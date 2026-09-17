import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { Config } from '../config.js'
import { AgentTeamError, isAgentTeamError } from '../domain/errors.js'
import type { AgentTeamService, AgentTeamChange } from '../service/agent-team-service.js'
import {
  AGENT_TEAM_API_PATH,
  AGENT_TEAM_EVENTS_PATH,
  AGENT_TEAM_METHODS,
  AGENT_TEAM_UPLOAD_PATH,
  type AgentTeamCommandBridge,
  type AgentTeamRequest,
  type AgentTeamResponse,
} from './contracts.js'

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

const requestSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  method: z.enum(AGENT_TEAM_METHODS),
  expectedRevision: z.int().positive().optional(),
  payload: z.unknown(),
}).strict()

const idPayload = z.object({ id: z.string().trim().min(1) }).strict()
const interactionResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('question'),
    answers: z.array(z.object({
      id: z.string().trim().min(1).max(200),
      selected: z.array(z.string().min(1).max(500)).max(50),
      custom: z.string().max(32_000).optional(),
    }).strict()).min(1).max(32),
  }).strict(),
  z.object({
    kind: z.literal('approval'),
    outcome: z.enum(['allowed-once', 'rejected']),
  }).strict(),
])

export interface WebTransport {
  dispose(): void
}

export function registerWebTransport(
  ctx: Context,
  config: Config,
  service: AgentTeamService,
  commands: AgentTeamCommandBridge,
): WebTransport {
  const clients = new Set<ServerResponse>()
  const unsubscribe = service.subscribe(change => broadcast(clients, change))
  const heartbeat = setInterval(() => {
    for (const response of clients) response.write(': heartbeat\n\n')
  }, config.sseHeartbeatMs)
  heartbeat.unref()

  const disposeApi = ctx.webServer.register({
    kind: 'exact',
    path: AGENT_TEAM_API_PATH,
    handler: async (request, response) => {
      await handleApi(request, response, config, service, ctx, commands)
    },
  })
  const disposeEvents = ctx.webServer.register({
    kind: 'exact',
    path: AGENT_TEAM_EVENTS_PATH,
    handler: (request, response) => {
      handleEvents(request, response, clients)
    },
  })
  const disposeUpload = ctx.webServer.register({
    kind: 'exact',
    path: AGENT_TEAM_UPLOAD_PATH,
    handler: async (request, response) => {
      await handleUpload(request, response, service, ctx)
    },
  })

  return {
    dispose() {
      disposeUpload()
      disposeEvents()
      disposeApi()
      unsubscribe()
      clearInterval(heartbeat)
      for (const response of clients) response.end()
      clients.clear()
    },
  }
}

async function handleUpload(
  request: IncomingMessage,
  response: ServerResponse,
  service: AgentTeamService,
  ctx: Context,
): Promise<void> {
  const requestId = headerValue(request.headers['x-agent-team-request-id']) ?? 'unknown'
  if (request.method !== 'POST') {
    writeJson(response, 405, failure(requestId, 'METHOD_NOT_ALLOWED', 'Only POST is supported'))
    return
  }
  if (!sameOrigin(request)) {
    writeJson(response, 403, failure(requestId, 'ORIGIN_REJECTED', 'Cross-origin requests are not allowed'))
    return
  }
  try {
    const url = new URL(request.url ?? AGENT_TEAM_UPLOAD_PATH, `http://${request.headers.host ?? 'localhost'}`)
    const teamId = url.searchParams.get('teamId')?.trim()
    const encodedName = headerValue(request.headers['x-agent-team-file-name'])
    if (!teamId || !encodedName) throw new AgentTeamError('INVALID_REQUEST', 'Team id and file name are required')
    let fileName: string
    try {
      fileName = decodeURIComponent(encodedName)
    } catch {
      throw new AgentTeamError('INVALID_REQUEST', 'File name encoding is invalid')
    }
    const data = await readBytes(request, MAX_UPLOAD_BYTES)
    const value = await service.uploadWorkspaceFile(teamId, fileName, data)
    writeJson(response, 200, { requestId, ok: true, value })
  } catch (error) {
    if (!isAgentTeamError(error)) {
      ctx.logger.error('agent-team: unhandled upload error', error)
    }
    const normalized = normalizeError(requestId, error)
    const status = normalized.error.code.endsWith('_NOT_FOUND') ? 404 : 400
    writeJson(response, status, normalized)
  }
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  config: Config,
  service: AgentTeamService,
  ctx: Context,
  commands: AgentTeamCommandBridge,
): Promise<void> {
  if (request.method !== 'POST') {
    writeJson(response, 405, failure('unknown', 'METHOD_NOT_ALLOWED', 'Only POST is supported'))
    return
  }
  if (!sameOrigin(request)) {
    writeJson(response, 403, failure('unknown', 'ORIGIN_REJECTED', 'Cross-origin requests are not allowed'))
    return
  }
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    writeJson(response, 415, failure('unknown', 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'))
    return
  }

  let parsed: AgentTeamRequest
  try {
    const body = await readJson(request, config.maxRequestBytes)
    parsed = requestSchema.parse(body) as AgentTeamRequest
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request'
    writeJson(response, 400, failure('unknown', 'INVALID_REQUEST', message))
    return
  }

  // 命令执行等长操作以客户端连接为取消边界：连接提前关闭时中止宿主命令。
  // 挂在 response 的 'close' 上：IncomingMessage 的 'close' 在 body 读尽时即发射
  // （Node ≥15），会错过客户端断连；response 'close' 在连接断开或响应结束时发射，
  // 用 writableEnded 区分——正常完成后不 abort，断连（writableEnded=false）才 abort。
  const abortController = new AbortController()
  response.once('close', () => {
    if (!response.writableEnded) abortController.abort()
  })

  try {
    const value = await dispatch(service, parsed, commands, abortController.signal)
    writeJson(response, 200, { requestId: parsed.requestId, ok: true, value })
  } catch (error) {
    if (!isAgentTeamError(error) && !(error instanceof z.ZodError)) {
      ctx.logger.error('agent-team: unhandled API error', error)
    }
    const normalized = normalizeError(parsed.requestId, error)
    const status = normalized.error.code.endsWith('_NOT_FOUND') ? 404
      : normalized.error.code.includes('REVISION_CONFLICT') ? 409
        : 400
    writeJson(response, status, normalized)
  }
}

function handleEvents(
  request: IncomingMessage,
  response: ServerResponse,
  clients: Set<ServerResponse>,
): void {
  if (request.method !== 'GET') {
    writeJson(response, 405, failure('unknown', 'METHOD_NOT_ALLOWED', 'Only GET is supported'))
    return
  }
  if (!sameOrigin(request)) {
    writeJson(response, 403, failure('unknown', 'ORIGIN_REJECTED', 'Cross-origin requests are not allowed'))
    return
  }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  })
  response.write('retry: 2000\n\n')
  clients.add(response)
  const close = () => { clients.delete(response) }
  request.once('close', close)
  response.once('close', close)
}

async function dispatch(
  service: AgentTeamService,
  request: AgentTeamRequest,
  commands: AgentTeamCommandBridge,
  signal: AbortSignal,
): Promise<unknown> {
  const options = request.expectedRevision === undefined
    ? {}
    : { expectedRevision: request.expectedRevision }
  switch (request.method) {
    case 'catalog.get': return service.catalog()
    case 'catalog.model.get': {
      const payload = z.object({
        provider: z.string().trim().min(1).max(200),
        model: z.string().trim().min(1).max(500),
      }).strict().parse(request.payload)
      return service.modelCapabilities(payload.provider, payload.model)
    }
    case 'skill.catalog': {
      const payload = z.object({ agentPresetId: z.string().trim().min(1).max(200) }).strict().parse(request.payload)
      return service.skillCatalog(payload.agentPresetId)
    }
    case 'mcp.catalog': {
      const payload = z.object({ agentPresetId: z.string().trim().min(1).max(200) }).strict().parse(request.payload)
      return service.mcpCatalog(payload.agentPresetId)
    }
    case 'assistant.list': return service.listAssistants()
    case 'assistant.get': return service.getAssistant(idPayload.parse(request.payload).id)
    case 'assistant.create': return service.createAssistant(request.payload as never)
    case 'assistant.update': {
      const payload = z.object({ id: z.string().min(1), value: z.unknown() }).strict().parse(request.payload)
      return service.updateAssistant(payload.id, payload.value as never, options)
    }
    case 'assistant.clone': {
      const payload = z.object({ id: z.string().min(1), name: z.string().optional() }).strict().parse(request.payload)
      return service.cloneAssistant(payload.id, payload.name)
    }
    case 'assistant.delete': await service.deleteAssistant(idPayload.parse(request.payload).id); return null
    case 'assistant.builder.list': return service.listAssistantBuilderConversations()
    case 'assistant.builder.draft.get': return service.getAssistantBuilderDraft()
    case 'assistant.builder.draft.configure': {
      const payload = z.object({
        provider: z.string().trim().min(1).max(200),
        model: z.string().trim().min(1).max(500),
      }).strict().parse(request.payload)
      return service.configureAssistantBuilderDraft(payload.provider, payload.model)
    }
    case 'assistant.builder.start': {
      const payload = z.object({
        provider: z.string().trim().min(1).max(200),
        model: z.string().trim().min(1).max(500),
        content: z.string().trim().min(1).max(32_000),
      }).strict().parse(request.payload)
      return service.startAssistantBuilderConversation(payload.provider, payload.model, payload.content)
    }
    case 'assistant.builder.get': {
      const payload = z.object({ sessionId: z.string().trim().min(1).max(200) }).strict().parse(request.payload)
      return service.getAssistantBuilderConversation(payload.sessionId)
    }
    case 'assistant.builder.configure': {
      const payload = z.object({
        sessionId: z.string().trim().min(1).max(200),
        provider: z.string().trim().min(1).max(200),
        model: z.string().trim().min(1).max(500),
      }).strict().parse(request.payload)
      return service.configureAssistantBuilder(payload.sessionId, payload.provider, payload.model)
    }
    case 'assistant.builder.send': {
      const payload = z.object({
        sessionId: z.string().trim().min(1).max(200),
        content: z.string().trim().min(1).max(32_000),
      }).strict().parse(request.payload)
      return service.sendAssistantBuilderMessage(payload.sessionId, payload.content)
    }
    case 'assistant.builder.interaction.respond': {
      const payload = z.object({
        sessionId: z.string().trim().min(1).max(200),
        interactionId: z.string().trim().min(1).max(500),
        response: interactionResponseSchema,
      }).strict().parse(request.payload)
      await service.respondToAssistantBuilderInteraction(
        payload.sessionId,
        payload.interactionId,
        payload.response.kind === 'approval'
          ? payload.response
          : {
            kind: 'question',
            answers: payload.response.answers.map(answer => ({
              id: answer.id,
              selected: answer.selected,
              ...(answer.custom === undefined ? {} : { custom: answer.custom }),
            })),
          },
      )
      return { accepted: true }
    }
    case 'assistant.builder.stop': {
      const payload = z.object({ sessionId: z.string().trim().min(1).max(200) }).strict().parse(request.payload)
      await service.stopAssistantBuilder(payload.sessionId)
      return { accepted: true }
    }
    case 'assistant.builder.archive': {
      const payload = z.object({ sessionId: z.string().trim().min(1).max(200) }).strict().parse(request.payload)
      await service.archiveAssistantBuilderConversation(payload.sessionId)
      return { archived: true }
    }
    case 'team.list': return service.listTeams()
    case 'team.get': return service.getTeam(idPayload.parse(request.payload).id)
    case 'team.createDraft': return service.createTeamDraft(request.payload as never)
    case 'team.clone': {
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
        name: z.string().trim().min(1).max(500),
        workspaceId: z.string().trim().min(1).max(500),
      }).strict().parse(request.payload)
      return service.cloneTeam(payload.teamId, {
        name: payload.name,
        workspaceId: payload.workspaceId,
      })
    }
    case 'team.start': return service.startTeam(idPayload.parse(request.payload).id, options)
    case 'team.addMember': {
      const payload = z.object({ teamId: z.string().min(1), value: z.unknown() }).strict().parse(request.payload)
      return service.addMember(payload.teamId, payload.value as never, options)
    }
    case 'team.removeMember': {
      const payload = z.object({ teamId: z.string().min(1), slotId: z.string().min(1) }).strict().parse(request.payload)
      return service.removeMember(payload.teamId, payload.slotId, options)
    }
    case 'team.changeLeader': {
      const payload = z.object({ teamId: z.string().min(1), successorSlotId: z.string().min(1) }).strict().parse(request.payload)
      return service.changeLeader(payload.teamId, payload.successorSlotId, options)
    }
    case 'team.reset': {
      const payload = z.object({ teamId: z.string().min(1), confirmation: z.string() }).strict().parse(request.payload)
      return service.resetTeam(payload.teamId, payload.confirmation, options)
    }
    case 'team.snapshots.refresh': {
      const payload = z.object({ teamId: z.string().min(1) }).strict().parse(request.payload)
      return service.syncMemberPersonas(payload.teamId)
    }
    case 'team.message.list': return service.listMessages(idPayload.parse(request.payload).id)
    case 'team.message.send': {
      const payload = z.object({
        teamId: z.string().min(1),
        content: z.string(),
        targetSlotId: z.string().min(1).optional(),
      }).strict().parse(request.payload)
      return service.sendUserMessage(payload.teamId, payload.content, payload.targetSlotId)
    }
    case 'team.workbench.get': return service.getWorkbench(idPayload.parse(request.payload).id)
    case 'team.member.stop': {
      const payload = z.object({ teamId: z.string().min(1), slotId: z.string().min(1) }).strict().parse(request.payload)
      await service.stopMember(payload.teamId, payload.slotId)
      return { accepted: true }
    }
    case 'team.interaction.respond': {
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
        slotId: z.string().trim().min(1).max(200),
        interactionId: z.string().trim().min(1).max(300),
        response: interactionResponseSchema,
      }).strict().parse(request.payload)
      await service.respondToInteraction(
        payload.teamId,
        payload.slotId,
        payload.interactionId,
        payload.response.kind === 'approval'
          ? payload.response
          : {
            kind: 'question',
            answers: payload.response.answers.map(answer => ({
              id: answer.id,
              selected: answer.selected,
              ...(answer.custom === undefined ? {} : { custom: answer.custom }),
            })),
          },
      )
      return { accepted: true }
    }
    case 'team.member.setPermissionPreset': {
      const payload = z.object({
        teamId: z.string().min(1),
        slotId: z.string().min(1),
        permissionPresetId: z.string().min(1),
      }).strict().parse(request.payload)
      return service.setMemberPermissionPreset(
        payload.teamId,
        payload.slotId,
        payload.permissionPresetId,
        options,
      )
    }
    case 'team.member.setReasoningEffort': {
      const payload = z.object({
        teamId: z.string().min(1),
        slotId: z.string().min(1),
        reasoningEffort: z.string().trim().min(1).max(200).optional(),
      }).strict().parse(request.payload)
      return service.setMemberReasoningEffort(
        payload.teamId,
        payload.slotId,
        payload.reasoningEffort,
        options,
      )
    }
    case 'team.workspace.list': {
      const payload = z.object({
        teamId: z.string().min(1),
        path: z.string().max(4096).optional(),
      }).strict().parse(request.payload)
      return service.listWorkspace(payload.teamId, payload.path)
    }
    case 'team.workspace.search': {
      const payload = z.object({
        teamId: z.string().min(1),
        query: z.string().max(4096).optional(),
        limit: z.int().min(1).max(100).optional(),
      }).strict().parse(request.payload)
      return service.searchWorkspace(payload.teamId, payload.query, payload.limit)
    }
    case 'team.workspace.changes': {
      const payload = z.object({ teamId: z.string().min(1) }).strict().parse(request.payload)
      return service.getWorkspaceChanges(payload.teamId)
    }
    case 'team.workspace.diff': {
      const payload = z.object({
        teamId: z.string().min(1),
        path: z.string().min(1).max(4096),
        scope: z.enum(['staged', 'unstaged']),
        layout: z.enum(['unified', 'split']),
        theme: z.enum(['light', 'dark']),
      }).strict().parse(request.payload)
      return service.getWorkspaceDiff(payload.teamId, payload.path, payload.scope, payload.layout, payload.theme)
    }
    case 'team.command.list': {
      const payload = z.object({ teamId: z.string().min(1), slotId: z.string().min(1) }).strict().parse(request.payload)
      return commands.listMemberCommands(payload.teamId, payload.slotId)
    }
    case 'team.command.execute': {
      const payload = z.object({
        teamId: z.string().min(1),
        slotId: z.string().min(1),
        line: z.string().trim().min(2).max(8_000),
      }).strict().parse(request.payload)
      return commands.executeMemberCommand(payload.teamId, payload.slotId, payload.line, signal)
    }
    case 'team.command.compactAll': {
      const payload = z.object({ teamId: z.string().min(1), slotId: z.string().min(1) }).strict().parse(request.payload)
      return commands.compactAllMembers(payload.teamId, payload.slotId)
    }
    case 'team.dissolve': {
      const payload = z.object({ teamId: z.string().min(1), confirmation: z.string() }).strict().parse(request.payload)
      await service.dissolveTeam(payload.teamId, payload.confirmation, options)
      return null
    }
  }
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limit) throw new AgentTeamError('INVALID_REQUEST', `Request body exceeds ${limit} bytes`)
    chunks.push(buffer)
  }
  if (chunks.length === 0) throw new AgentTeamError('INVALID_REQUEST', 'Request body is empty')
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

async function readBytes(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > limit) {
    throw new AgentTeamError('INVALID_REQUEST', `File exceeds the ${Math.floor(limit / 1024 / 1024)} MB upload limit`)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limit) {
      throw new AgentTeamError('INVALID_REQUEST', `File exceeds the ${Math.floor(limit / 1024 / 1024)} MB upload limit`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (origin === undefined) return true
  const host = request.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function broadcast(clients: Set<ServerResponse>, change: AgentTeamChange): void {
  const event = change.entityType === 'conversation' ? 'conversation'
    : change.entityType === 'assistant-builder' ? 'assistant-builder-conversation'
      : change.entityType === 'workspace' ? 'workspace'
      : 'change'
  const frame = `id: ${change.cursor}\nevent: ${event}\ndata: ${JSON.stringify(change)}\n\n`
  for (const response of clients) response.write(frame)
}

function normalizeError(requestId: string, error: unknown): AgentTeamResponse & { ok: false } {
  if (isAgentTeamError(error)) {
    return failure(requestId, error.code, error.message, error.details)
  }
  if (error instanceof z.ZodError) {
    return failure(requestId, 'INVALID_REQUEST', 'Request validation failed', { issues: error.issues })
  }
  return failure(requestId, 'INTERNAL_ERROR', 'Agent Team encountered an internal error')
}

function failure(
  requestId: string,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AgentTeamResponse & { ok: false } {
  return {
    requestId,
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  }
}

function writeJson(response: ServerResponse, status: number, body: AgentTeamResponse): void {
  const json = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(json)
}
