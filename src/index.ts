import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import type { Context } from '@deepseek-ai/cordis'
import { Config, type Config as AgentTeamConfig } from './config.js'
import { AgentTeamService } from './service/agent-team-service.js'
import { AssistantBuilderRuntime } from './runtime/assistant-builder-runtime.js'
import { TeamRuntime } from './runtime/team-runtime.js'
import {
  agentTeamAssistantsSpec,
  agentTeamRuntimeSpec,
  agentTeamStreamsSpec,
  legacyAgentTeamSpec,
} from './storage/domain.js'
import {
  LEGACY_UNIT_FILE,
  migrateLegacyAgentTeamStore,
  resolveStoragesRoot,
} from './storage/migration.js'
import { cleanupOrphans, warnIfStreamsLarge } from './storage/orphan-cleanup.js'
import {
  assistantBuilderPreferencesDomainSpec,
  DomainAssistantBuilderModelPreferenceStore,
} from './storage/assistant-builder-preferences.js'
import { CompositeAgentTeamStore } from './storage/store.js'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { registerNativeDirectoryPicker } from './runtime/native-directory-picker.js'
import { registerWebTransport } from './transport/web.js'

export const name = 'agent-team'
export const inject = [
  'agents',
  'agentPresets',
  'commands',
  'llm',
  'permissionPresets',
  'sessionPersistence',
  'sessions',
  'skills',
  'storageDomain',
  'systemPrompt',
  'tools',
  'webServer',
  'workspaceRegistry',
]
export { Config }

export async function apply(ctx: Context, config: AgentTeamConfig): Promise<void> {
  // Steady state: 4 open domains (runtime/assistants/streams + the pre-existing
  // assistant-builder preferences). Migration transiently opens a 5th (the
  // legacy read-only unit), closed inside migrateLegacyAgentTeamStore.
  const runtimeDomain = await ctx.storageDomain.open(agentTeamRuntimeSpec)
  const assistantsDomain = await ctx.storageDomain.open(agentTeamAssistantsSpec)
  const streamsDomain = await ctx.storageDomain.open(agentTeamStreamsSpec)
  const assistantBuilderPreferencesDomain = await ctx.storageDomain
    .open(assistantBuilderPreferencesDomainSpec)

  const openedDomains: Array<Domain<never>> = [
    runtimeDomain as never,
    assistantsDomain as never,
    streamsDomain as never,
    assistantBuilderPreferencesDomain as never,
  ]
  const closeAllDomains = async (): Promise<void> => {
    for (const domain of openedDomains) await domain.close()
  }

  try {
    const migration = await migrateLegacyAgentTeamStore({
      storageRoot: resolveStoragesRoot(),
      runtime: runtimeDomain,
      assistants: assistantsDomain,
      streams: streamsDomain,
      openLegacy: () => ctx.storageDomain.open(legacyAgentTeamSpec),
      logger: ctx.logger,
    })
    if (migration.migrated) {
      ctx.logger.info?.(
        `agent-team: legacy storage migrated (teams=${migration.counts?.teams} messages=${migration.counts?.messages} activities=${migration.counts?.activities} operations=${migration.counts?.operations} assistants=${migration.counts?.assistants} in ${migration.durationMs}ms, backup=${migration.backupPath ?? LEGACY_UNIT_FILE})`,
      )
    }

    warnIfStreamsLarge(streamsDomain, 5_000, ctx.logger)

    const store = new CompositeAgentTeamStore(runtimeDomain, assistantsDomain, streamsDomain, ctx.logger)
    const assistantBuilderModelPreferences = new DomainAssistantBuilderModelPreferenceStore(
      assistantBuilderPreferencesDomain,
    )
    let runtime: TeamRuntime | undefined
    let assistantBuilderRuntime: AssistantBuilderRuntime | undefined
    let transport: ReturnType<typeof registerWebTransport> | undefined
    let service: AgentTeamService | undefined
    let disposeNativePicker: (() => void) | undefined
    try {
      service = new AgentTeamService(ctx, config, store)
      runtime = new TeamRuntime(ctx, config, service)
      assistantBuilderRuntime = new AssistantBuilderRuntime(
        ctx,
        config,
        service,
        assistantBuilderModelPreferences,
        runtime.interactionBridge(),
      )
      service.attachRuntime(runtime)
      service.attachAssistantBuilderRuntime(assistantBuilderRuntime)
      transport = registerWebTransport(ctx, config, service, runtime)
      disposeNativePicker = registerNativeDirectoryPicker(ctx)
      ctx.effect(() => async () => {
        disposeNativePicker?.()
        transport?.dispose()
        await service?.disposeWorkspaceTracking()
        await assistantBuilderRuntime?.dispose()
        await runtime?.dispose()
        await closeAllDomains()
      }, 'agent-team: ordered shutdown')
      await cleanupOrphans({
        store,
        runtime: runtimeDomain,
        streams: streamsDomain,
        mode: config.orphanCleanup,
        logger: ctx.logger,
      })
      await runtime.recoverTeams()
      runtime.startInteractionBridge()
      service.startWorkspaceTracking()
    } catch (error) {
      disposeNativePicker?.()
      transport?.dispose()
      await service?.disposeWorkspaceTracking()
      await assistantBuilderRuntime?.dispose()
      await runtime?.dispose()
      throw error
    }
  } catch (error) {
    await closeAllDomains()
    throw error
  }
}

export { AgentTeamError } from './domain/errors.js'
export type * from './domain/types.js'
export type { AgentTeamChange, CatalogSnapshot } from './service/agent-team-service.js'
