import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionRequestEvent,
} from '@deepseek-ai/dsh-user-questions/types'
import type {
  ApprovalOutcome,
  ApprovalRequestEvent,
} from '@deepseek-ai/dsh-user-approval/types'
import { AgentTeamError } from '../domain/errors.js'
import type {
  InteractionResponseInput,
  PendingInteractionView,
  QuestionAnswerView,
  QuestionItemView,
} from '../transport/contracts.js'

/**
 * DSH 0.1.5 用 Cordis waterfall（`user-questions/request` / `approval/request`）
 * 承载人机交互请求；bridge 以 answerer 身份接管本插件团队会话的请求，
 * 把待决交互投影给团队 UI，并在 UI 应答后回填 waterfall 结果。
 */
type PendingQuestionRecord = {
  id: string
  kind: 'question'
  sessionId: string
  questions: QuestionItemView[]
  settle: (answer: AskUserQuestionAnswer) => boolean
  cancel: () => void
}

type PendingApprovalRecord = {
  id: string
  kind: 'approval'
  sessionId: string
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
  settle: (outcome: ApprovalOutcome) => boolean
  cancel: () => void
}

type PendingInteractionRecord = PendingQuestionRecord | PendingApprovalRecord

export interface TeamInteractionScope {
  acceptsSession: (sessionId: string) => boolean
  /**
   * Resolve a session id (possibly a derived sub-agent's own session) to the
   * owned team session it belongs to, by walking the durable parentSession
   * chain. Ownership is a SESSION relation, not a scope-ancestor relation:
   * harness agent scopes are flat, so a member-level listener can never see
   * child dispatch keys — but the request payload itself carries the lineage
   * (agent.session.header.parentSession). Return undefined when no owned
   * ancestor exists (depth-capped by the implementation).
   */
  resolveOwnedSession?: (sessionId: string) => string | undefined
  onChange: (sessionId: string) => void
}

export class TeamInteractionBridge {
  private readonly records = new Map<string, PendingInteractionRecord>()
  private readonly scopes = new Set<TeamInteractionScope>()
  private disposers: (() => void) | undefined

  constructor(
    private readonly ctx: Context,
    scope?: TeamInteractionScope,
  ) {
    if (scope !== undefined) this.scopes.add(scope)
  }

  registerScope(scope: TeamInteractionScope): () => void {
    this.scopes.add(scope)
    return () => { this.scopes.delete(scope) }
  }

  start(): void {
    if (this.disposers !== undefined) return
    // prepend 是 G1 的核心：cordis 全树共享单一 _hooks 监听器数组，unshift 使本
    // 插件包级 untagged 监听器排在宿主 api-remotes 转发桥（宿主启动时最先注册、
    // 命中即短路不调 next()）之前，从而先获得 owned 会话请求的 waterfall 应答权。
    // attachAgentContext 保留为降级兜底：若某宿主版本 prepend 语义失效，包级监听
    // 器退回到转发桥之后——此时兜底路径最坏退化为本修复前的 bug 现状（请求仍被
    // 转发桥抢答、卡片泄漏主界面），不会更差，但也不会更好。
    const removeQuestions = this.ctx.on('user-questions/request', (request, next) =>
      this.claimQuestion(request, next), { prepend: true })
    const removeApprovals = this.ctx.on('approval/request', (request, next) =>
      this.claimApproval(request, next), { prepend: true })
    this.disposers = () => {
      removeQuestions()
      removeApprovals()
    }
  }

  /**
   * Register the claim listeners inside one agent's own scope.
   *
   * Member interactions are dispatched with `scopeTarget(agent, agent)`, and a
   * scope carrier only admits untagged listeners plus listeners whose scope is
   * an ancestor of the dispatch key. This plugin package's scope is not in a
   * member agent's ancestor chain, so the package-level listeners from
   * `start()` never see agent-scoped requests — registering the same handlers
   * on the agent context (whose scope tag equals the dispatch key) is what
   * makes claiming work. The agent fiber disposes these listeners itself.
   */
  attachAgentContext(agentCtx: Context): void {
    agentCtx.on('user-questions/request', (request, next) =>
      this.claimQuestion(request, next))
    agentCtx.on('approval/request', (request, next) =>
      this.claimApproval(request, next))
  }

  list(sessionId: string): PendingInteractionView[] {
    return [...this.records.values()]
      .filter(record => record.sessionId === sessionId)
      .map(toView)
  }

  forget(sessionId: string): void {
    for (const [id, record] of this.records) {
      if (record.sessionId !== sessionId) continue
      this.records.delete(id)
      record.cancel()
      this.notifyChange(sessionId)
    }
  }

  async respond(
    sessionId: string,
    interactionId: string,
    response: InteractionResponseInput,
  ): Promise<void> {
    const record = this.records.get(interactionId)
    if (record === undefined) {
      throw new AgentTeamError('INTERACTION_NOT_FOUND', '该交互请求已结束或不存在')
    }
    if (record.sessionId !== sessionId || !this.acceptsSession(sessionId)) {
      throw new AgentTeamError('INTERACTION_NOT_FOUND', '该交互请求不属于指定的会话')
    }
    if (record.kind === 'question') {
      if (response.kind !== 'question') {
        throw new AgentTeamError('INTERACTION_INVALID', '交互响应类型与待处理请求不匹配')
      }
      const answers = normalizeQuestionAnswers(record.questions, response.answers)
      if (!record.settle({ answers: answers as AskUserQuestionAnswerItem[] })) {
        throw new AgentTeamError('INTERACTION_NOT_PENDING', '该交互请求已由其他页面处理')
      }
    } else {
      if (response.kind !== 'approval') {
        throw new AgentTeamError('INTERACTION_INVALID', '交互响应类型与待处理请求不匹配')
      }
      if (response.outcome !== 'allowed-once' && response.outcome !== 'rejected') {
        throw new AgentTeamError('INTERACTION_INVALID', '未知的审批结论')
      }
      if (!record.settle(response.outcome)) {
        throw new AgentTeamError('INTERACTION_NOT_PENDING', '该交互请求已由其他页面处理')
      }
    }
    this.records.delete(record.id)
    this.notifyChange(record.sessionId)
  }

  async dispose(): Promise<void> {
    this.disposers?.()
    this.disposers = undefined
    for (const record of this.records.values()) record.cancel()
    this.records.clear()
  }

  private claimQuestion(
    request: AskUserQuestionRequestEvent,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    const sessionId = this.resolveOwnedSessionId(request.agent)
    if (sessionId === undefined) {
      // G4 + B-1: the package-level prepend listener is the only vantage that
      // sees every request; this warn means the plugin did NOT claim it and
      // the host's api-remotes forwarding bridge will answer it on the main
      // UI. Both claim paths warn unconditionally with empty placeholders when
      // an identity field is missing, so a silent passthrough can never hide.
      this.ctx.logger?.warn(
        'agent-team: user question not claimed by agent-team (will be answered by the host fallback); '
        + `agent.id=${String(request.agent?.id)} agent.session.id=${String(request.agent?.session?.id)} `
        + `parentSession=${String(request.agent?.session?.header?.parentSession)}`,
      )
      return next()
    }
    const questions = request.questions.map(toQuestionItemView)
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      let settled = false
      const record: PendingQuestionRecord = {
        id: `question:${randomUUID()}`,
        kind: 'question',
        sessionId,
        questions,
        settle: answer => {
          if (settled) return false
          settled = true
          resolve(answer)
          return true
        },
        cancel: () => {
          if (settled) return
          settled = true
          reject(new Error('user question was cancelled before it was answered'))
        },
      }
      this.records.set(record.id, record)
      this.notifyChange(sessionId)
      request.signal?.addEventListener('abort', () => {
        if (this.records.delete(record.id)) {
          record.cancel()
          this.notifyChange(sessionId)
        }
      }, { once: true })
    })
  }

  private claimApproval(
    request: ApprovalRequestEvent,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const sessionId = this.resolveOwnedSessionId(request.agent)
    if (sessionId === undefined) {
      // G4: see claimQuestion — unclaimed approval falls through to the host
      // forwarding bridge (main UI card) with a full-identity warn trail.
      this.ctx.logger?.warn(
        'agent-team: approval request not claimed by agent-team (will be answered by the host fallback); '
        + `agent.id=${String(request.agent?.id)} agent.session.id=${String(request.agent?.session?.id)} `
        + `parentSession=${String(request.agent?.session?.header?.parentSession)} toolName=${String(request.toolName)}`,
      )
      return next()
    }
    return new Promise<ApprovalOutcome>((resolve, reject) => {
      let settled = false
      const record: PendingApprovalRecord = {
        id: `approval:${randomUUID()}`,
        kind: 'approval',
        sessionId,
        approvalId: randomUUID(),
        toolName: request.toolName,
        ...(request.callId === undefined ? {} : { callId: String(request.callId) }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        settle: outcome => {
          if (settled) return false
          settled = true
          resolve(outcome)
          return true
        },
        cancel: () => {
          if (settled) return
          settled = true
          reject(new Error('approval was cancelled before it was decided'))
        },
      }
      this.records.set(record.id, record)
      this.notifyChange(sessionId)
      request.signal?.addEventListener('abort', () => {
        if (this.records.delete(record.id)) {
          record.cancel()
          this.notifyChange(sessionId)
        }
      }, { once: true })
    })
  }

  private acceptsSession(sessionId: string): boolean {
    return [...this.scopes].some(scope => scope.acceptsSession(sessionId))
  }

  /**
   * Resolve the request's agent to a team session id the bridge owns.
   *
   * Base candidates are the payload's two carried identities (session id and
   * agent id — the registry shares one id between agent and session, but the
   * waterfall payload has carried either across versions). When neither is
   * owned, the durable parentSession chain decides (G3): a derived sub-agent's
   * own session id is never owned, so each candidate — including the chain
   * head read from `agent.session.header.parentSession` — is offered to the
   * scope's lineage resolver, which walks up to the nearest owned ancestor.
   * A mismatch or unresolvable lineage silently leaks the interaction to the
   * official conversation UI, so every miss is logged (see claim handlers).
   */
  private resolveOwnedSessionId(
    agent: { id: unknown; session?: { id: unknown; header?: { parentSession?: unknown } } } | undefined,
  ): string | undefined {
    if (agent === undefined) return undefined
    const candidates = [agent.session?.id, agent.id]
    const parentSession = agent.session?.header?.parentSession
    if (parentSession !== undefined && parentSession !== null) candidates.push(parentSession)
    for (const candidate of candidates) {
      if (candidate === undefined) continue
      const sessionId = String(candidate)
      if (this.acceptsSession(sessionId)) return sessionId
      const resolved = this.resolveViaScopes(sessionId)
      if (resolved !== undefined) return resolved
    }
    return undefined
  }

  /**
   * Offer one session id to every registered scope's lineage resolver. A
   * throwing resolver is contained here (logged, treated as "not owned") so a
   * registry hiccup can never escape the claim path and fail the caller's
   * tool open — the request degrades to passthrough instead.
   */
  private resolveViaScopes(sessionId: string): string | undefined {
    for (const scope of this.scopes) {
      if (scope.resolveOwnedSession === undefined) continue
      try {
        const resolved = scope.resolveOwnedSession(sessionId)
        if (resolved !== undefined) return resolved
      } catch (error) {
        this.ctx.logger?.warn(
          'agent-team: session lineage resolver failed while resolving an interaction owner; '
          + `sessionId=${sessionId} error=${String(error)}`,
        )
      }
    }
    return undefined
  }

  private notifyChange(sessionId: string): void {
    for (const scope of this.scopes) {
      if (scope.acceptsSession(sessionId)) scope.onChange(sessionId)
    }
  }
}

/**
 * Depth cap for the parentSession lineage walk: durable session headers cannot
 * form cycles, but a corrupt or adversarial store must not turn an interaction
 * claim into an unbounded loop. Real delegation chains are a few levels deep.
 */
const MAX_LINEAGE_DEPTH = 8

/**
 * Walk the durable parentSession chain from `startSessionId` up to the nearest
 * session satisfying `isOwned`, and return that owner's id (the start itself
 * qualifies). A missing link, a throwing `readParentSession` (contained and
 * treated as "no parent"), or the depth cap all resolve to undefined — the
 * caller then passes the request through to the host fallback instead.
 */
export function resolveSessionLineageOwner(
  startSessionId: string,
  readParentSession: (sessionId: string) => string | undefined,
  isOwned: (sessionId: string) => boolean,
): string | undefined {
  let cursor: string | undefined = startSessionId
  for (let depth = 0; depth <= MAX_LINEAGE_DEPTH && cursor !== undefined; depth += 1) {
    if (isOwned(cursor)) return cursor
    try {
      cursor = readParentSession(cursor)
    } catch {
      return undefined
    }
  }
  return undefined
}

export function normalizeQuestionAnswers(
  questions: readonly QuestionItemView[],
  answers: readonly QuestionAnswerView[],
): QuestionAnswerView[] {
  const byId = new Map<string, QuestionAnswerView>()
  for (const answer of answers) {
    if (byId.has(answer.id)) {
      throw new AgentTeamError('INTERACTION_INVALID', `问题“${answer.id}”存在重复答案`)
    }
    byId.set(answer.id, answer)
  }
  if (byId.size !== questions.length) {
    throw new AgentTeamError('INTERACTION_INVALID', '请完成全部问题后再提交')
  }
  return questions.map(question => {
    const answer = byId.get(question.id)
    if (answer === undefined) {
      throw new AgentTeamError('INTERACTION_INVALID', `缺少问题“${question.id}”的答案`)
    }
    const selected = [...answer.selected]
    if (new Set(selected).size !== selected.length) {
      throw new AgentTeamError('INTERACTION_INVALID', `问题“${question.id}”包含重复选项`)
    }
    const allowed = new Set(question.options?.map(option => option.label) ?? [])
    if (selected.some(label => !allowed.has(label))) {
      throw new AgentTeamError('INTERACTION_INVALID', `问题“${question.id}”包含无效选项`)
    }
    if (question.multiSelect !== true && selected.length > 1) {
      throw new AgentTeamError('INTERACTION_INVALID', `问题“${question.id}”只能选择一个选项`)
    }
    const custom = answer.custom?.trim()
    if (question.multiSelect !== true && custom !== undefined && custom.length > 0 && selected.length > 0) {
      throw new AgentTeamError('INTERACTION_INVALID', `问题“${question.id}”的自定义答案不能与单选项同时提交`)
    }
    if (selected.length === 0 && (custom === undefined || custom.length === 0)) {
      throw new AgentTeamError('INTERACTION_INVALID', `请回答问题“${question.question}”`)
    }
    return {
      id: question.id,
      selected,
      ...(custom === undefined || custom.length === 0 ? {} : { custom }),
    }
  })
}

function toQuestionItemView(question: AskUserQuestionRequestEvent['questions'][number]): QuestionItemView {
  return {
    id: question.id,
    question: question.question,
    ...(question.detail === undefined ? {} : { detail: question.detail }),
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.options === undefined ? {} : {
      options: question.options.map(option => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    }),
    ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
    ...(question.intent === undefined ? {} : { intent: { ...question.intent } }),
  }
}

function toView(record: PendingInteractionRecord): PendingInteractionView {
  if (record.kind === 'question') {
    return { id: record.id, kind: record.kind, questions: record.questions }
  }
  return {
    id: record.id,
    kind: record.kind,
    approvalId: String(record.approvalId),
    toolName: record.toolName,
    ...(record.callId === undefined ? {} : { callId: record.callId }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  }
}
