import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  AgentTeamOverlay,
  AgentTeamSettingsSection,
  type WorkspaceChoice,
} from './components.js'
import { AGENT_TEAM_PICK_DIRECTORY_PATH } from '../transport/contracts.js'

export const name = 'agent-team-client'
export const inject = ['slots', 'workspaces']

interface PickDirectoryResponse {
  ok: boolean
  path?: string | null
  message?: string
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'agent-team', order: 40, label: 'Agent 团队' },
    AgentTeamSettingsSection,
  ))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'agent-team',
      order: 20,
      label: '团队',
      inject: (): { pickWorkspace: () => Promise<WorkspaceChoice | null> } => ({
        pickWorkspace: async () => {
          const response = await fetch(AGENT_TEAM_PICK_DIRECTORY_PATH, { method: 'POST' })
          const result = await response.json() as PickDirectoryResponse
          if (!result.ok) {
            throw new Error(result.message ?? 'directory picker failed')
          }
          if (result.path === null || result.path === undefined) return null
          const workspace = await ctx.workspaces.create({ path: result.path })
          return {
            id: workspace.workspaceId,
            path: workspace.path,
            title: workspace.title,
          }
        },
      }),
    },
    AgentTeamOverlay,
  ))
}
