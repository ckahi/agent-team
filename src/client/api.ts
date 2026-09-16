import {
  AGENT_TEAM_API_PATH,
  AGENT_TEAM_EVENTS_PATH,
  AGENT_TEAM_UPLOAD_PATH,
  type AgentTeamMethod,
  type AgentTeamPayload,
  type AgentTeamResponse,
  type AgentTeamResult,
  type AssistantBuilderConversationView,
  type MemberConversationView,
  type WorkspaceUploadView,
} from '../transport/contracts.js'

export async function callAgentTeam<M extends AgentTeamMethod>(
  method: M,
  ...args: AgentTeamPayload<M> extends undefined
    ? [payload?: undefined, expectedRevision?: number]
    : [payload: AgentTeamPayload<M>, expectedRevision?: number]
): Promise<AgentTeamResult<M>> {
  const [payload, expectedRevision] = args
  const controller = new AbortController()
  // 压缩/命令执行可能在宿主侧等待模型调用，给更长超时
  const timeoutMs = method === 'team.reset' || method === 'team.dissolve' || method === 'team.command.execute' || method === 'team.command.compactAll'
    ? 120_000
    : 10_000
  const timeout = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetch(AGENT_TEAM_API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        method,
        payload: payload ?? {},
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
    })
    const body = await response.json() as AgentTeamResponse
    if (!body.ok) {
      const error = new Error(body.error.message)
      Object.assign(error, { code: body.error.code, details: body.error.details })
      throw error
    }
    return body.value as AgentTeamResult<M>
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`请求超时：${method}`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function uploadAgentTeamFile(teamId: string, file: File): Promise<WorkspaceUploadView> {
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, 120_000)
  const requestId = crypto.randomUUID()
  try {
    const response = await fetch(`${AGENT_TEAM_UPLOAD_PATH}?teamId=${encodeURIComponent(teamId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Agent-Team-File-Name': encodeURIComponent(file.name),
        'X-Agent-Team-Request-Id': requestId,
      },
      signal: controller.signal,
      body: file,
    })
    const body = await response.json() as AgentTeamResponse
    if (!body.ok) {
      const error = new Error(body.error.message)
      Object.assign(error, { code: body.error.code, details: body.error.details })
      throw error
    }
    return body.value as WorkspaceUploadView
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`文件上传超时：${file.name}`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

interface ChangeSubscription {
  onChange: () => void
  onError: () => void
}

interface ConversationSubscription {
  teamId: string
  onChange: (conversation?: MemberConversationView) => void
  onError: () => void
  onOpen?: () => void
}

interface AssistantBuilderSubscription {
  onChange: (conversation?: AssistantBuilderConversationView) => void
  onError: () => void
  onOpen?: () => void
}

interface WorkspaceSubscription {
  teamId: string
  onChange: () => void
  onError: () => void
}

const changeSubscriptions = new Set<ChangeSubscription>()
const conversationSubscriptions = new Set<ConversationSubscription>()
const assistantBuilderSubscriptions = new Set<AssistantBuilderSubscription>()
const workspaceSubscriptions = new Set<WorkspaceSubscription>()
let sharedEventSource: EventSource | undefined

function eventSource(): EventSource {
  if (sharedEventSource !== undefined) return sharedEventSource
  const source = new EventSource(AGENT_TEAM_EVENTS_PATH)
  source.addEventListener('change', () => {
    for (const subscription of changeSubscriptions) subscription.onChange()
  })
  source.addEventListener('conversation', ((event: MessageEvent<string>) => {
    try {
      const change = JSON.parse(event.data) as {
        entityId?: string
        conversation?: MemberConversationView
      }
      for (const subscription of conversationSubscriptions) {
        if (subscription.teamId === change.entityId) subscription.onChange(change.conversation)
      }
    } catch {
      for (const subscription of conversationSubscriptions) subscription.onChange()
    }
  }) as EventListener)
  source.addEventListener('assistant-builder-conversation', ((event: MessageEvent<string>) => {
    try {
      const change = JSON.parse(event.data) as {
        assistantBuilderConversation?: AssistantBuilderConversationView
      }
      for (const subscription of assistantBuilderSubscriptions) {
        subscription.onChange(change.assistantBuilderConversation)
      }
    } catch {
      for (const subscription of assistantBuilderSubscriptions) subscription.onChange()
    }
  }) as EventListener)
  source.addEventListener('workspace', ((event: MessageEvent<string>) => {
    try {
      const change = JSON.parse(event.data) as { entityId?: string }
      for (const subscription of workspaceSubscriptions) {
        if (subscription.teamId === change.entityId) subscription.onChange()
      }
    } catch {
      for (const subscription of workspaceSubscriptions) subscription.onChange()
    }
  }) as EventListener)
  source.onerror = () => {
    for (const subscription of changeSubscriptions) subscription.onError()
    for (const subscription of conversationSubscriptions) subscription.onError()
    for (const subscription of assistantBuilderSubscriptions) subscription.onError()
    for (const subscription of workspaceSubscriptions) subscription.onError()
  }
  source.onopen = () => {
    for (const subscription of conversationSubscriptions) subscription.onOpen?.()
    for (const subscription of assistantBuilderSubscriptions) subscription.onOpen?.()
  }
  sharedEventSource = source
  return source
}

function releaseEventSourceIfUnused(): void {
  if (
    changeSubscriptions.size > 0
    || conversationSubscriptions.size > 0
    || assistantBuilderSubscriptions.size > 0
    || workspaceSubscriptions.size > 0
  ) return
  sharedEventSource?.close()
  sharedEventSource = undefined
}

export function subscribeAgentTeamWorkspace(
  teamId: string,
  onChange: () => void,
  onError: () => void,
): () => void {
  const subscription: WorkspaceSubscription = { teamId, onChange, onError }
  workspaceSubscriptions.add(subscription)
  eventSource()
  return () => {
    workspaceSubscriptions.delete(subscription)
    releaseEventSourceIfUnused()
  }
}

export function subscribeAgentTeam(onChange: () => void, onError: () => void): () => void {
  const subscription: ChangeSubscription = { onChange, onError }
  changeSubscriptions.add(subscription)
  eventSource()
  return () => {
    changeSubscriptions.delete(subscription)
    releaseEventSourceIfUnused()
  }
}

export function subscribeAgentTeamConversation(
  teamId: string,
  onChange: (conversation?: MemberConversationView) => void,
  onError: () => void,
  onOpen?: () => void,
): () => void {
  const subscription: ConversationSubscription = {
    teamId,
    onChange,
    onError,
    ...(onOpen === undefined ? {} : { onOpen }),
  }
  conversationSubscriptions.add(subscription)
  const source = eventSource()
  if (source.readyState === EventSource.OPEN) queueMicrotask(() => { onOpen?.() })
  return () => {
    conversationSubscriptions.delete(subscription)
    releaseEventSourceIfUnused()
  }
}

export function subscribeAssistantBuilderConversation(
  onChange: (conversation?: AssistantBuilderConversationView) => void,
  onError: () => void,
  onOpen?: () => void,
): () => void {
  const subscription: AssistantBuilderSubscription = {
    onChange,
    onError,
    ...(onOpen === undefined ? {} : { onOpen }),
  }
  assistantBuilderSubscriptions.add(subscription)
  const source = eventSource()
  if (source.readyState === EventSource.OPEN) queueMicrotask(() => { onOpen?.() })
  return () => {
    assistantBuilderSubscriptions.delete(subscription)
    releaseEventSourceIfUnused()
  }
}
