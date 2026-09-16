import type { FormEvent } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import {
  IconCloseOutline16,
  IconPaperclipOutline16,
  IconSendOutline16,
  IconStopFill16,
  MarkdownText,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CatalogView,
  CommandDescriptorView,
  ConversationNode,
  MemberConversationView,
  TeamView,
  WorkspaceUploadView,
} from '../../transport/contracts.js'
import { callAgentTeam, uploadAgentTeamFile } from '../api.js'
import { MARKDOWN_LABELS } from '../markdown-labels.js'
import {
  composerTriggerAt,
  matchingCommands,
  matchingUserSkills,
  parseSlashLine,
  replaceComposerTrigger,
  scrollTopForActiveOption,
  TEAM_COMPACT_COMMAND,
  type ComposerTrigger,
} from '../composer-triggers.js'
import css from './ConversationColumn.module.css'
import { mergeConversationNodes } from '../conversation-nodes.js'
import {
  beginCompactRun,
  compactProgressSummary,
  endCompactRun,
  isRunForTeam,
  markMemberCompacting,
  markMemberSkipped,
  markMemberSucceeded,
  useCompactRun,
} from '../state/compact-progress.js'
import { insertWorkspaceFileMention, workspaceFileMention } from '../file-mentions.js'
import { CrownIcon } from '../icons/CrownIcon.js'
import { DeepThinkIcon } from '../icons/DeepThinkIcon.js'
import { shouldSubmitComposer } from '../keyboard.js'
import { memberStatusLabel, PERMISSION_LABELS } from '../labels.js'
import {
  defaultReasoningLabel,
  reasoningEffortLabel,
  useModelCapabilities,
} from '../model-reasoning.js'
import { PendingInteractionCard } from './PendingInteractionCard.js'

interface ComposerCandidate {
  id: string
  label: string
  description: string
  replacement: string
  group: 'team' | 'commands' | 'skills'
}

export function ConversationColumn({
  team,
  member,
  conversation,
  permissionPresets,
  onSent,
  onTeamChanged,
  expanded,
  onExpandedChange,
}: {
  team: TeamView
  member: TeamView['members'][string]
  conversation: MemberConversationView | undefined
  permissionPresets: CatalogView['permissionPresets']
  onSent: () => Promise<void>
  onTeamChanged: () => Promise<void>
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}): JSX.Element {
  const [content, setContent] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [changingPermission, setChangingPermission] = useState(false)
  const [changingReasoning, setChangingReasoning] = useState(false)
  const [permissionPresetId, setPermissionPresetId] = useState(member.permissionPresetId)
  const [reasoningEffort, setReasoningEffort] = useState(member.reasoningEffort ?? '')
  const [error, setError] = useState<string>()
  const [pendingMessages, setPendingMessages] = useState<ConversationNode[]>([])
  const [uploadingFiles, setUploadingFiles] = useState(false)
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger>()
  const [composerCandidates, setComposerCandidates] = useState<ComposerCandidate[]>([])
  const [composerCandidateIndex, setComposerCandidateIndex] = useState(0)
  const [composerCandidatesLoading, setComposerCandidatesLoading] = useState(false)
  const [composerCandidatesError, setComposerCandidatesError] = useState<string>()
  const [localNotices, setLocalNotices] = useState<ConversationNode[]>([])
  const memberCommandsRef = useRef<Map<string, CommandDescriptorView[]>>(new Map())
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composerTriggerOptionsRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const fileInsertionPoint = useRef({ start: 0, end: 0 })
  const timelineRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const composing = useRef(false)
  const sendInFlight = useRef(false)
  const composerCandidateGeneration = useRef(0)
  const canChat = team.state === 'active' && (member.role === 'leader' || team.directMemberChat)
  const running = conversation?.status === 'running'
  const compactRun = useCompactRun()
  // P-1：仅当前团队的 run 参与渲染，防止跨团队 slotId 碰撞误显 badge
  const teamCompactRun = isRunForTeam(compactRun, team.id) ? compactRun : undefined
  const compactSummary = teamCompactRun !== undefined ? compactProgressSummary(teamCompactRun) : undefined
  const memberCompacting = teamCompactRun?.members.find(item => item.slotId === member.id && item.state === 'compacting')
  const isCompactInitiator = teamCompactRun?.initiatorSlotId === member.id
  const visibleNodes = mergeConversationNodes(conversation?.nodes ?? [], [...pendingMessages, ...localNotices])
  const pendingInteractions = conversation?.pendingInteractions ?? []
  const statusLabel = pendingInteractions.some(interaction => interaction.kind === 'approval')
    ? '等待审批'
    : pendingInteractions.length > 0
      ? '等待回答'
      : memberStatusLabel(conversation?.status ?? member.lastRuntimeState)
  const statusState = pendingInteractions.some(interaction => interaction.kind === 'approval')
    ? 'waiting_approval'
    : pendingInteractions.length > 0
      ? 'waiting_approval'
      : conversation?.status ?? member.lastRuntimeState
  const statusClass = statusState === 'running'
    ? css.columnStatusRunning
    : statusState === 'waiting_approval'
      ? css.columnStatusWaiting
      : statusState === 'error'
        ? css.columnStatusError
        : statusState === 'starting'
          ? css.columnStatusStarting
          : undefined
  const modelCapabilities = useModelCapabilities(
    member.assistantSnapshot.provider,
    member.assistantSnapshot.model,
  )
  const defaultReasoningEffort = modelCapabilities.value?.reasoning?.defaultEffort
  const reasoningModeLabel = reasoningEffort
    ? reasoningEffortLabel(modelCapabilities.value, reasoningEffort)
    : defaultReasoningEffort
      ? reasoningEffortLabel(modelCapabilities.value, defaultReasoningEffort)
      : '默认'
  const skillNamesKey = member.assistantSnapshot.skillAllowlist.join('\u0000')
  const composerMenuId = `agent-team-composer-menu-${member.id}`

  useEffect(() => {
    setPermissionPresetId(member.permissionPresetId)
  }, [member.permissionPresetId])

  useEffect(() => {
    setReasoningEffort(member.reasoningEffort ?? '')
  }, [member.reasoningEffort])

  useEffect(() => {
    const committedIds = new Set(conversation?.nodes.map(node => node.id) ?? [])
    setPendingMessages(current => {
      const next = current.filter(node => !committedIds.has(node.id))
      return next.length === current.length ? current : next
    })
  }, [conversation?.throughSeq])

  useEffect(() => {
    if (!stickToBottom.current) return
    const frame = requestAnimationFrame(() => {
      const timeline = timelineRef.current
      if (timeline !== null) timeline.scrollTop = timeline.scrollHeight
    })
    return () => { cancelAnimationFrame(frame) }
  }, [conversation?.throughSeq, pendingInteractions.length, pendingMessages.length, localNotices.length])

  useEffect(() => {
    const generation = ++composerCandidateGeneration.current
    setComposerCandidateIndex(0)
    setComposerCandidatesError(undefined)
    if (composerTrigger === undefined) {
      setComposerCandidates([])
      setComposerCandidatesLoading(false)
      return
    }
    const query = composerTrigger.query.toLocaleLowerCase()
    if (composerTrigger.kind === 'skill') {
      setComposerCandidates([])
      setComposerCandidatesLoading(true)
      const timer = window.setTimeout(() => {
        const cachedCommands = memberCommandsRef.current.get(member.id)
        const commandsReady = cachedCommands !== undefined
          ? Promise.resolve(cachedCommands)
          : callAgentTeam('team.command.list', { teamId: team.id, slotId: member.id })
        void Promise.all([
          commandsReady,
          callAgentTeam('skill.catalog', {
            agentPresetId: member.assistantSnapshot.agentPresetId,
          }),
        ]).then(([commands, catalog]) => {
          if (generation !== composerCandidateGeneration.current) return
          memberCommandsRef.current.set(member.id, commands)
          const selected = new Set(member.assistantSnapshot.skillAllowlist)
          const teamCandidates = member.role === 'leader' && TEAM_COMPACT_COMMAND.toLocaleLowerCase().includes(query)
            ? [{
                id: `command:${TEAM_COMPACT_COMMAND}`,
                label: `/${TEAM_COMPACT_COMMAND}`,
                description: '压缩全体成员上下文（仅队长）',
                replacement: `/${TEAM_COMPACT_COMMAND}`,
                group: 'team' as const,
              }]
            : []
          const commandCandidates = matchingCommands(commands, query).map(command => ({
            id: `command:${command.name}`,
            label: `/${command.name}`,
            description: command.description,
            replacement: `/${command.name}`,
            group: 'commands' as const,
          }))
          const skillCandidates = matchingUserSkills(catalog.skills, selected, query)
            .map(skill => ({
              id: `skill:${skill.name}`,
              label: `/${skill.name}`,
              description: skill.description,
              replacement: `/${skill.name}`,
              group: 'skills' as const,
            }))
          setComposerCandidates([...teamCandidates, ...commandCandidates, ...skillCandidates])
          setComposerCandidatesLoading(false)
        }).catch(cause => {
          if (generation !== composerCandidateGeneration.current) return
          setComposerCandidates([])
          setComposerCandidatesLoading(false)
          setComposerCandidatesError(cause instanceof Error ? cause.message : String(cause))
        })
      }, 100)
      return () => { window.clearTimeout(timer) }
    }

    setComposerCandidates([])
    setComposerCandidatesLoading(true)
    const timer = window.setTimeout(() => {
      void callAgentTeam('team.workspace.search', {
        teamId: team.id,
        query: composerTrigger.query,
        limit: 40,
      }).then(entries => {
        if (generation !== composerCandidateGeneration.current) return
        setComposerCandidates(entries.map(entry => ({
          id: `file:${entry.path}`,
          label: entry.path,
          description: 'Workspace 文件',
          replacement: workspaceFileMention(entry.path),
          group: 'skills' as const,
        })))
        setComposerCandidatesLoading(false)
      }).catch(cause => {
        if (generation !== composerCandidateGeneration.current) return
        setComposerCandidates([])
        setComposerCandidatesLoading(false)
        setComposerCandidatesError(cause instanceof Error ? cause.message : String(cause))
      })
    }, 140)
    return () => { window.clearTimeout(timer) }
  }, [composerTrigger?.kind, composerTrigger?.query, skillNamesKey, team.id, member.id, member.role])

  useEffect(() => {
    const container = composerTriggerOptionsRef.current
    if (container === null || composerCandidates.length === 0) return
    const active = container.querySelector<HTMLElement>('[aria-selected="true"]')
    if (active === null) return
    const viewport = container.getBoundingClientRect()
    const option = active.getBoundingClientRect()
    container.scrollTop = scrollTopForActiveOption({
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom,
      optionTop: option.top,
      optionBottom: option.bottom,
      scrollTop: container.scrollTop,
    })
  }, [composerCandidateIndex, composerCandidates.length])

  function updateComposerTrigger(value: string, cursor: number | null): void {
    setComposerTrigger(composerTriggerAt(value, cursor ?? value.length))
  }

  function acceptComposerCandidate(candidate: ComposerCandidate): void {
    if (composerTrigger === undefined) return
    const next = replaceComposerTrigger(content, composerTrigger, candidate.replacement)
    setContent(next.value)
    setComposerTrigger(undefined)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor)
    })
  }

  function pushLocalNotice(text: string, tone: 'neutral' | 'error' | 'warning'): void {
    setLocalNotices(current => [
      ...current.slice(-9),
      {
        id: `local-notice:${crypto.randomUUID()}`,
        kind: 'notice' as const,
        seq: Number.MAX_SAFE_INTEGER,
        time: Date.now(),
        tone,
        text,
      },
    ])
  }

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault()
    const message = content.trim()
    if (!message || sendInFlight.current) return
    // 进入提交即置位（含命令分流的 list 等待期），杜绝连按 Enter 的重入窗口
    sendInFlight.current = true
    setSending(true)
    try {
      const parsed = parseSlashLine(message)
      if (parsed !== undefined) {
        let commands = memberCommandsRef.current.get(member.id)
        if (commands === undefined) {
          try {
            commands = await callAgentTeam('team.command.list', { teamId: team.id, slotId: member.id })
            memberCommandsRef.current.set(member.id, commands)
          } catch {
            commands = []
          }
        }
        if (parsed.name === TEAM_COMPACT_COMMAND) {
          await submitCompactAll(message)
          return
        }
        if (commands.some(command => command.name === parsed.name)) {
          await submitCommand(message)
          return
        }
      }
      const pendingId = `pending:${crypto.randomUUID()}`
      const pending: ConversationNode = {
        id: pendingId,
        kind: 'user',
        seq: Number.MAX_SAFE_INTEGER,
        time: Date.now(),
        text: message,
      }
      setContent('')
      setComposerTrigger(undefined)
      setPendingMessages(current => [...current, pending])
      stickToBottom.current = true
      try {
        const delivered = await callAgentTeam('team.message.send', {
          teamId: team.id,
          targetSlotId: member.id,
          content: message,
        })
        setPendingMessages(current => current.map(node => node.id === pendingId ? { ...node, id: delivered.id } : node))
        setError(undefined)
        await onSent()
      } catch (cause) {
        setPendingMessages(current => current.filter(node => node.id !== pendingId))
        setContent(current => current.length === 0 ? message : current)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      sendInFlight.current = false
      setSending(false)
    }
  }

  /** 执行宿主官方斜杠命令（以当前列成员会话身份），结果以本地 notice 呈现。 */
  async function submitCommand(line: string): Promise<void> {
    setContent('')
    setComposerTrigger(undefined)
    stickToBottom.current = true
    try {
      const execution = await callAgentTeam('team.command.execute', {
        teamId: team.id,
        slotId: member.id,
        line,
      })
      const name = parseSlashLine(line)?.name ?? ''
      pushLocalNotice(
        execution.result.kind === 'success'
          ? `/${name} ${execution.result.text ?? '已执行'}`
          : `/${name} ${execution.result.text}`,
        execution.result.kind === 'success' ? 'neutral' : 'error',
      )
      setError(undefined)
      await onSent()
    } catch (cause) {
      setContent(current => current.length === 0 ? line : current)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  /** /team-compact：队长并行压缩全队上下文（各成员独立会话，无共享资源竞争），过程状态由 compact-progress 逐成员驱动，最后渲染汇总 notice。 */
  async function submitCompactAll(line: string): Promise<void> {
    // 本地预判 leader 身份：非队长直接提示，不发起 RPC，输入保留（host 校验保留作双保险）
    if (member.role !== 'leader') {
      pushLocalNotice('「/team-compact」仅队长（Leader）可执行', 'warning')
      return
    }
    setContent('')
    setComposerTrigger(undefined)
    stickToBottom.current = true
    // 压缩范围与宿主 compactTeamMembers 一致：team.members 全员，含 Leader 本人
    const roster = Object.values(team.members).map(entry => ({ slotId: entry.id, displayName: entry.displayName }))
    beginCompactRun(team.id, member.id, roster)
    type CompactOutcome =
      | { kind: 'compacted'; displayName: string }
      | { kind: 'skipped'; displayName: string; reason: string }
      | { kind: 'failed'; displayName: string; reason: string }
    // 两阶段并行：先全员标记 compacting（badge 同时亮起），再并发发起全部 execute，逐个 settle 独立翻转
    for (const entry of roster) markMemberCompacting(entry.slotId)
    const tasks = roster.map(entry => (async (): Promise<CompactOutcome> => {
      try {
        const execution = await callAgentTeam('team.command.execute', {
          teamId: team.id,
          slotId: entry.slotId,
          line: '/compact',
        })
        if (execution.result.kind === 'success') {
          markMemberSucceeded(entry.slotId)
          return { kind: 'compacted', displayName: entry.displayName }
        }
        // 错误结果（如成员忙碌）= 跳过，原因取宿主返回文本
        const reason = execution.result.text || '命令执行失败'
        markMemberSkipped(entry.slotId, reason)
        return { kind: 'skipped', displayName: entry.displayName, reason }
      } catch (cause) {
        // RPC 异常（超时/断连等）= 失败，原因取异常信息
        const reason = cause instanceof Error ? cause.message : String(cause)
        markMemberSkipped(entry.slotId, reason)
        return { kind: 'failed', displayName: entry.displayName, reason }
      }
    })())
    try {
      // 任务自身不 reject（全路径折叠为 outcome），rejected 分支仅作防御
      const settled = await Promise.allSettled(tasks)
      const outcomes = settled.map(result => result.status === 'fulfilled'
        ? result.value
        : { kind: 'failed' as const, displayName: '未知成员', reason: '任务异常' })
      const compactedNames: string[] = []
      const skippedEntries: Extract<CompactOutcome, { kind: 'skipped' }>[] = []
      const failedEntries: Extract<CompactOutcome, { kind: 'failed' }>[] = []
      for (const outcome of outcomes) {
        if (outcome.kind === 'compacted') compactedNames.push(outcome.displayName)
        else if (outcome.kind === 'skipped') skippedEntries.push(outcome)
        else failedEntries.push(outcome)
      }
      // P-3：notice 不支持换行渲染，逐成员一条独立 notice（roster 序，三桶语义区分），末尾汇总一行
      for (const outcome of outcomes) {
        if (outcome.kind === 'compacted') pushLocalNotice(`已压缩：${outcome.displayName}`, 'neutral')
        else if (outcome.kind === 'skipped') pushLocalNotice(`已跳过：${outcome.displayName}（${outcome.reason}）`, 'warning')
        else pushLocalNotice(`压缩失败：${outcome.displayName}（${outcome.reason}）`, 'error')
      }
      if (outcomes.length === 0) {
        pushLocalNotice('全队上下文压缩完成：没有可处理的成员', 'warning')
      } else {
        pushLocalNotice(
          `全队上下文压缩完成 — 已完成 ${compactedNames.length} / 跳过 ${skippedEntries.length} / 失败 ${failedEntries.length}`,
          compactedNames.length === 0 ? 'warning' : 'neutral',
        )
      }
      setError(undefined)
      await onSent()
    } catch (cause) {
      setContent(current => current.length === 0 ? line : current)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      // 全部成员 settle 后才释放 sendInFlight 并清除进度状态（badge/横幅消失）
      endCompactRun()
    }
  }

  async function stop(): Promise<void> {
    if (stopping) return
    setStopping(true)
    try {
      await callAgentTeam('team.member.stop', { teamId: team.id, slotId: member.id })
      setError(undefined)
      await onSent()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStopping(false)
    }
  }

  async function changePermission(nextPermissionPresetId: string): Promise<void> {
    if (changingPermission || nextPermissionPresetId === permissionPresetId) return
    const previous = permissionPresetId
    setPermissionPresetId(nextPermissionPresetId)
    setChangingPermission(true)
    try {
      await callAgentTeam('team.member.setPermissionPreset', {
        teamId: team.id,
        slotId: member.id,
        permissionPresetId: nextPermissionPresetId,
      })
      setError(undefined)
      await onTeamChanged()
    } catch (cause) {
      setPermissionPresetId(previous)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setChangingPermission(false)
    }
  }

  async function changeReasoning(nextReasoningEffort: string): Promise<void> {
    if (changingReasoning || nextReasoningEffort === reasoningEffort) return
    const previous = reasoningEffort
    setReasoningEffort(nextReasoningEffort)
    setChangingReasoning(true)
    try {
      await callAgentTeam('team.member.setReasoningEffort', {
        teamId: team.id,
        slotId: member.id,
        ...(nextReasoningEffort ? { reasoningEffort: nextReasoningEffort } : {}),
      })
      setError(undefined)
      await onTeamChanged()
    } catch (cause) {
      setReasoningEffort(previous)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setChangingReasoning(false)
    }
  }

  async function uploadFiles(files: FileList | null): Promise<void> {
    const selected = Array.from(files ?? [])
    if (selected.length === 0 || uploadingFiles) return
    setUploadingFiles(true)
    try {
      const uploads: WorkspaceUploadView[] = []
      for (const file of selected) uploads.push(await uploadAgentTeamFile(team.id, file))
      let nextCursor = fileInsertionPoint.current.start
      setContent(current => {
        let nextValue = current
        let selectionStart = Math.min(fileInsertionPoint.current.start, current.length)
        let selectionEnd = Math.min(fileInsertionPoint.current.end, current.length)
        for (const upload of uploads) {
          const inserted = insertWorkspaceFileMention(nextValue, selectionStart, selectionEnd, upload.path)
          nextValue = inserted.value
          nextCursor = inserted.cursor
          selectionStart = inserted.cursor
          selectionEnd = inserted.cursor
        }
        return nextValue
      })
      setError(undefined)
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(nextCursor, nextCursor)
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (fileInputRef.current !== null) fileInputRef.current.value = ''
      setUploadingFiles(false)
    }
  }

  return (
    <section
      className={`${css.conversationColumn} ${expanded ? css.conversationColumnExpanded : ''}`}
      aria-label={`${member.displayName} 对话`}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded || undefined}
    >
      <header
        className={css.columnHeader}
        title={expanded ? undefined : '双击放大对话'}
        onDoubleClick={() => { if (!expanded) onExpandedChange(true) }}
      >
        <div className={css.columnIdentity}>
          <span className={css.memberAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{member.displayName} {member.role === 'leader' && <CrownIcon size={15} className={css.leaderCrown} title="Leader" />}</strong>
            <div
              className={css.columnModelMeta}
              title={`${member.assistantSnapshot.provider} / ${member.assistantSnapshot.model} · 思考模式：${reasoningModeLabel}`}
            >
              <span className={css.columnModelName}>
                {member.assistantSnapshot.provider} / {member.assistantSnapshot.model}
              </span>
              <span className={css.reasoningModeBadge}>{reasoningModeLabel}</span>
            </div>
          </div>
        </div>
        <div className={css.columnHeaderActions}>
          {memberCompacting !== undefined && (
            <span className={css.columnCompactBadge} title={`${member.displayName} 的上下文正在压缩`}>压缩中</span>
          )}
          <span className={`${css.columnStatus} ${statusClass ?? ''}`}>{statusLabel}</span>
          {expanded && (
            <Tooltip label="关闭放大对话" side="bottom" delayMs={400}>
              <button
                type="button"
                className={css.columnExpandClose}
                aria-label="关闭放大对话"
                onDoubleClick={event => { event.stopPropagation() }}
                onClick={() => { onExpandedChange(false) }}
              >
                <IconCloseOutline16 size={16} />
              </button>
            </Tooltip>
          )}
        </div>
      </header>
      {isCompactInitiator && teamCompactRun !== undefined && compactSummary !== undefined && (
        <div className={css.compactProgressBanner} role="status">
          {teamCompactRun.members.some(item => item.state === 'compacting')
            ? `正在压缩 ${teamCompactRun.members.filter(item => item.state === 'compacting').length} 个成员…`
            : '压缩收尾中…'}
        </div>
      )}
      <div
        className={css.timeline}
        ref={timelineRef}
        onScroll={event => {
          const timeline = event.currentTarget
          stickToBottom.current = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80
        }}
      >
        {visibleNodes.length === 0 && pendingInteractions.length === 0
          ? <div className={css.columnEmpty}>
            <span className={css.emptyAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
            <strong>{member.displayName}</strong>
            <span>{member.role === 'leader' ? '向 Leader 描述目标，由它组织团队协作。' : '等待 Leader 分配任务，或直接向该成员发送消息。'}</span>
          </div>
          : <>
            {visibleNodes.map(node => <ConversationNodeView key={node.id} node={node} />)}
            {pendingInteractions.map(interaction => (
              <PendingInteractionCard
                key={interaction.id}
                interaction={interaction}
                onRespond={async response => {
                  await callAgentTeam('team.interaction.respond', {
                    teamId: team.id,
                    slotId: member.id,
                    interactionId: interaction.id,
                    response,
                  })
                  await onSent()
                }}
              />
            ))}
          </>}
      </div>
      <form className={css.composer} onSubmit={(event) => { void send(event) }}>
        {composerTrigger !== undefined && (
          <div
            id={composerMenuId}
            className={css.composerTriggerMenu}
            role="listbox"
            aria-label={composerTrigger.kind === 'skill' ? '命令与 Skill 候选' : 'Workspace 文件候选'}
          >
            <div className={css.composerTriggerHeading}>
              <strong>{composerTrigger.kind === 'skill' ? '命令与 Skills' : 'Workspace 文件'}</strong>
              <span>↑↓ 选择 · Enter 插入 · Esc 关闭</span>
            </div>
            <div ref={composerTriggerOptionsRef} className={css.composerTriggerOptions}>
              {composerCandidates.map((candidate, index) => {
                const previous = composerCandidates[index - 1]
                const showGroup = composerTrigger.kind === 'skill'
                  && (previous === undefined || previous.group !== candidate.group)
                const groupLabel = candidate.group === 'team'
                  ? '团队操作'
                  : candidate.group === 'commands'
                    ? `命令 · 对 ${member.displayName} 执行`
                    : 'Skills'
                return (
                  <Fragment key={candidate.id}>
                    {showGroup && <span className={css.composerTriggerGroup}>{groupLabel}</span>}
                    <button
                      id={`${composerMenuId}-${index}`}
                      type="button"
                      role="option"
                      aria-selected={index === composerCandidateIndex}
                      className={`${css.composerTriggerOption} ${index === composerCandidateIndex ? css.composerTriggerOptionActive : ''}`}
                      title={candidate.group === 'commands' ? `以 ${member.displayName} 的会话身份执行；部分命令的交互面板仅在主界面提供` : undefined}
                      onMouseDown={event => { event.preventDefault() }}
                      onMouseEnter={() => { setComposerCandidateIndex(index) }}
                      onClick={() => { acceptComposerCandidate(candidate) }}
                    >
                      <strong>{candidate.label}</strong>
                      <span>{candidate.description}</span>
                    </button>
                  </Fragment>
                )
              })}
              {composerCandidatesLoading && <span className={css.composerTriggerEmpty}>正在搜索…</span>}
              {!composerCandidatesLoading && composerCandidatesError !== undefined && (
                <span className={css.composerTriggerEmpty}>{composerCandidatesError}</span>
              )}
              {!composerCandidatesLoading && composerCandidatesError === undefined && composerCandidates.length === 0 && (
                <span className={css.composerTriggerEmpty}>
                  {composerTrigger.kind === 'skill'
                    ? '没有匹配的命令或已加载 Skill'
                    : '没有匹配的 Workspace 文件'}
                </span>
              )}
              {composerTrigger.kind === 'skill' && (
                <span className={css.composerTriggerEmpty}>
                  命令以「{member.displayName}」的会话身份执行；部分命令的交互面板仅在主界面提供
                </span>
              )}
            </div>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={content}
          onChange={event => {
            setContent(event.currentTarget.value)
            updateComposerTrigger(event.currentTarget.value, event.currentTarget.selectionStart)
          }}
          onClick={event => {
            updateComposerTrigger(event.currentTarget.value, event.currentTarget.selectionStart)
          }}
          onBlur={() => {
            window.setTimeout(() => { setComposerTrigger(undefined) }, 100)
          }}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          onKeyDown={event => {
            if (composerTrigger !== undefined) {
              if (event.key === 'ArrowDown' && composerCandidates.length > 0) {
                event.preventDefault()
                setComposerCandidateIndex(current => (current + 1) % composerCandidates.length)
                return
              }
              if (event.key === 'ArrowUp' && composerCandidates.length > 0) {
                event.preventDefault()
                setComposerCandidateIndex(current => (current - 1 + composerCandidates.length) % composerCandidates.length)
                return
              }
              if ((event.key === 'Enter' || event.key === 'Tab') && composerCandidates.length > 0) {
                event.preventDefault()
                acceptComposerCandidate(composerCandidates[composerCandidateIndex]!)
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setComposerTrigger(undefined)
                return
              }
            }
            if (!shouldSubmitComposer({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
              keyCode: event.nativeEvent.keyCode,
            }, composing.current)) return
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }}
          disabled={!canChat || uploadingFiles}
          placeholder={!canChat ? '当前不可直接对话' : `发送消息到 ${member.displayName}…`}
          aria-controls={composerTrigger === undefined ? undefined : composerMenuId}
          aria-expanded={composerTrigger !== undefined}
          aria-activedescendant={composerTrigger !== undefined && composerCandidates.length > 0
            ? `${composerMenuId}-${composerCandidateIndex}`
            : undefined}
          rows={2}
        />
        <div className={css.composerFooter}>
          <div className={css.composerUtilities}>
            <button
              type="button"
              className={`${css.composerIconButton} ${css.composerAttachButton}`}
              disabled={!canChat || uploadingFiles}
              aria-label={uploadingFiles ? '正在上传文件' : '选择文件'}
              onClick={() => {
                const textarea = textareaRef.current
                fileInsertionPoint.current = {
                  start: textarea?.selectionStart ?? content.length,
                  end: textarea?.selectionEnd ?? content.length,
                }
                fileInputRef.current?.click()
              }}
            >
              <IconPaperclipOutline16 size={16} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className={css.hiddenFileInput}
              multiple
              tabIndex={-1}
              onChange={event => { void uploadFiles(event.currentTarget.files) }}
            />
            <select
              className={css.permissionSelect}
              aria-label={`${member.displayName} 权限`}
              value={permissionPresetId}
              disabled={changingPermission || permissionPresets.length === 0}
              onChange={event => { void changePermission(event.target.value) }}
            >
              {permissionPresets.map(permission => (
                <option key={permission.value} value={permission.value}>
                  权限 · {PERMISSION_LABELS[permission.value] ?? permission.name}
                </option>
              ))}
            </select>
            {modelCapabilities.value?.reasoning !== undefined
              && modelCapabilities.value.reasoning.efforts.length > 0 && (
                <label
                  className={`${css.reasoningModeControl} ${changingReasoning ? css.reasoningModeControlDisabled : ''}`}
                  title={`思考模式：${reasoningModeLabel}；切换后下一轮生效`}
                >
                  <span>思考模式</span>
                  <select
                    aria-label={`${member.displayName} 思考模式；当前为 ${reasoningModeLabel}；切换后下一轮生效`}
                    value={reasoningEffort}
                    disabled={changingReasoning}
                    onChange={event => { void changeReasoning(event.target.value) }}
                  >
                    <option value="">{defaultReasoningLabel(modelCapabilities.value)}</option>
                    {modelCapabilities.value.reasoning.efforts.map(effort => (
                      <option key={effort.id} value={effort.id}>
                        {reasoningEffortLabel(modelCapabilities.value, effort.id)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
          </div>
          <div className={css.composerActions}>
            <AssistantSkillsInfo skills={member.assistantSnapshot.skillAllowlist} />
            {conversation?.contextUsage !== undefined && (
              <ContextUsageMeter usage={conversation.contextUsage} />
            )}
            {running && (
              <Tooltip label={stopping ? '停止中…' : '停止生成'} side="top" delayMs={400}>
                <button
                  type="button"
                  className={css.composerIconButton}
                  disabled={stopping}
                  aria-label={stopping ? '停止中' : '停止生成'}
                  onClick={() => { void stop() }}
                >
                  <IconStopFill16 size={16} />
                </button>
              </Tooltip>
            )}
            <Tooltip label={sending ? '发送中…' : '发送消息'} side="top" delayMs={400}>
              <button
                type="submit"
                className={css.composerIconButton}
                disabled={!canChat || sending || uploadingFiles || !content.trim()}
                aria-label={sending ? '发送中' : '发送消息'}
              >
                <IconSendOutline16 size={16} />
              </button>
            </Tooltip>
          </div>
        </div>
        {error && <span className={css.composerError}>{error}</span>}
      </form>
    </section>
  )
}

function AssistantSkillsInfo({ skills }: { skills: readonly string[] }): JSX.Element {
  return (
    <div className={css.skillsInfo}>
      <button
        type="button"
        className={css.skillsInfoButton}
        aria-label={skills.length === 0 ? '当前助手未加载 Skills' : `查看当前助手加载的 ${skills.length} 个 Skills`}
      >
        <InfoIcon size={16} />
      </button>
      <div className={css.skillsInfoPopover} role="tooltip">
        <div className={css.skillsInfoHeading}>
          <strong>已加载 Skills</strong>
          <span>{skills.length} 个</span>
        </div>
        {skills.length === 0
          ? <span className={css.skillsInfoEmpty}>当前助手未加载 Skill</span>
          : (
            <ul className={css.skillsInfoList}>
              {skills.map(skill => <li key={skill}>{skill}</li>)}
            </ul>
          )}
      </div>
    </div>
  )
}

function InfoIcon({ size }: { size: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="5" r="1" fill="currentColor" />
      <path d="M8 7.5V11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function ContextUsageMeter({
  usage,
}: {
  usage: NonNullable<MemberConversationView['contextUsage']>
}): JSX.Element {
  const percent = usage.contextWindow === undefined
    ? undefined
    : Math.min(100, Math.round(usage.usedTokens / usage.contextWindow * 100))
  const pressureClass = percent !== undefined && percent >= 90
    ? css.contextUsageCritical
    : percent !== undefined && percent >= 75
      ? css.contextUsageWarning
      : ''
  const cacheHitPercent = usage.inputTokens === 0
    ? 0
    : Math.round(usage.cacheReadTokens / usage.inputTokens * 100)
  const details = [
    `输入 ${formatTokenCount(usage.inputTokens)}`,
    `输出 ${formatTokenCount(usage.outputTokens)}`,
    `缓存命中 ${cacheHitPercent}%`,
    ...(usage.cacheWriteTokens > 0 ? [`缓存写 ${formatTokenCount(usage.cacheWriteTokens)}`] : []),
    ...(usage.reasoningTokens > 0 ? [`思考 ${formatTokenCount(usage.reasoningTokens)}`] : []),
  ]
  return (
    <div className={`${css.contextUsage} ${pressureClass}`}>
      <button
        type="button"
        className={css.contextUsageButton}
        aria-label={percent === undefined
          ? `已使用约 ${usage.usedTokens} tokens，上下文窗口大小未知`
          : `上下文已使用约 ${usage.usedTokens} / ${usage.contextWindow} tokens，${percent}%`}
      >
        <svg className={css.contextUsageRing} viewBox="0 0 36 36" aria-hidden="true">
          <circle className={css.contextUsageRingTrack} cx="18" cy="18" r="14" />
          {percent !== undefined && (
            <circle
              className={css.contextUsageRingValue}
              cx="18"
              cy="18"
              r="14"
              pathLength="100"
              strokeDasharray={`${percent} 100`}
            />
          )}
        </svg>
      </button>
      <div className={css.contextUsagePopover} role="tooltip">
        <strong>已使用 {formatTokenCount(usage.usedTokens)} tokens</strong>
        <span>
          {usage.contextWindow === undefined
            ? '上下文窗口大小未知'
            : `上下文窗口 ${formatTokenCount(usage.contextWindow)} · 已用 ${percent}%`}
        </span>
        <span>{details.join(' · ')}</span>
      </div>
    </div>
  )
}

export function ConversationNodeView({ node }: { node: ConversationNode }): JSX.Element {
  if (node.kind === 'tool') return <ToolCard node={node} />
  if (node.kind === 'notice') return <div className={`${css.noticeNode} ${node.tone === 'error' ? css.noticeError : ''}`}>{node.text}</div>
  if (node.kind === 'team-message') return <TeamMessageCard node={node} />
  return (
    <article className={`${css.messageNode} ${node.kind === 'user' ? css.userMessage : css.assistantMessage}`}>
      {node.reasoning && (
        <ReasoningBlock node={node} />
      )}
      {node.text && (
        <div className={css.messageText}>
          {node.kind === 'assistant'
            ? <MarkdownText text={node.text} streaming={node.streaming === true} labels={MARKDOWN_LABELS} />
            : <PlainText text={node.text} />}
        </div>
      )}
      {node.streaming && <span className={css.streamingMark}>生成中…</span>}
    </article>
  )
}

function ReasoningBlock({
  node,
}: {
  node: Extract<ConversationNode, { kind: 'user' | 'assistant' }>
}): JSX.Element {
  const reasoningRunning = node.reasoningStartedAt !== undefined
    && node.reasoningCompletedAt === undefined
    && node.streaming === true
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!reasoningRunning) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 200)
    return () => { window.clearInterval(timer) }
  }, [reasoningRunning])

  const elapsed = node.reasoningStartedAt === undefined
    ? undefined
    : Math.max(0, (node.reasoningCompletedAt ?? now) - node.reasoningStartedAt)
  const timing = elapsed === undefined
    ? undefined
    : reasoningRunning
      ? `思考中 · ${formatElapsedTime(elapsed)}`
      : `用时 ${formatElapsedTime(elapsed)}`

  return (
    <details className={css.reasoningBlock}>
      <summary>
        <DeepThinkIcon size={14} className={css.reasoningIcon} />
        <span>Think</span>
        {timing !== undefined && (
          <>
            <span className={css.reasoningSeparator} aria-hidden="true">·</span>
            <span className={css.reasoningTime}>{timing}</span>
          </>
        )}
      </summary>
      <pre>{node.reasoning}</pre>
    </details>
  )
}

function formatElapsedTime(milliseconds: number): string {
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} 秒`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.floor((milliseconds % 60_000) / 1_000)
  return `${minutes} 分 ${seconds} 秒`
}

const TEAM_MESSAGE_TYPE_LABELS: Record<Extract<ConversationNode, { kind: 'team-message' }>['messageType'], string> = {
  instruction: '指令',
  progress: '进度',
  result: '结果',
  question: '问题',
  warning: '警告',
  system: '系统',
}

function TeamMessageCard({ node }: { node: Extract<ConversationNode, { kind: 'team-message' }> }): JSX.Element {
  const toneClass = node.messageType === 'result'
    ? css.teamMessageResult
    : node.messageType === 'question'
      ? css.teamMessageQuestion
      : node.messageType === 'warning'
        ? css.teamMessageWarning
        : node.messageType === 'instruction'
          ? css.teamMessageInstruction
          : node.messageType === 'system'
            ? css.teamMessageSystem
            : css.teamMessageProgress
  const category = node.senderRole === 'leader'
    ? 'Leader 消息'
    : node.senderRole === 'system'
      ? '团队事件'
      : '成员反馈'
  return (
    <article className={`${css.teamMessageCard} ${toneClass}`}>
      <header className={css.teamMessageHeader}>
        <span className={css.teamMessageIdentity}>
          <strong>{category}</strong>
          {node.senderRole !== 'system' && <span>{node.senderName}</span>}
          {node.senderRole !== 'system' && (
            <code className={css.teamMessageMemberId} title={`成员 ID：${node.senderId}`}>
              ID {shortMemberId(node.senderId)}
            </code>
          )}
        </span>
        <span className={css.teamMessageType}>{TEAM_MESSAGE_TYPE_LABELS[node.messageType]}</span>
      </header>
      <div className={css.teamMessageText}><PlainText text={node.text} /></div>
    </article>
  )
}

function shortMemberId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

/** 纯文本渲染（替代已移除的 primitives `MessageText`），保留换行。 */
function PlainText({ text }: { text: string }): JSX.Element {
  return <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>
}

function ToolCard({ node }: { node: Extract<ConversationNode, { kind: 'tool' }> }): JSX.Element {
  const status = node.status === 'running' ? '执行中' : node.status === 'success' ? '已完成' : '失败'
  return (
    <details className={`${css.toolCard} ${node.status === 'error' ? css.toolCardError : ''}`} open={node.status !== 'success'}>
      <summary>
        <span className={css.toolIcon}>⌘</span>
        <strong>{node.name}</strong>
        <span>{status}</span>
      </summary>
      {node.arguments && <div className={css.toolSection}><span>参数</span><pre>{prettyJson(node.arguments)}</pre></div>}
      {node.result && <div className={css.toolSection}><span>结果</span><pre>{node.result}</pre></div>}
      {node.error && <div className={css.toolError}>{node.error}</div>}
    </details>
  )
}

function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) {
    const scaled = value / 1_000
    return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}k`
  }
  const scaled = value / 1_000_000
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}m`
}

function prettyJson(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
}
