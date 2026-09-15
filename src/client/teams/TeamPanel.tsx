import type { FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  IconChevronLeftOutline14,
  IconCloseOutline16,
  IconFolderOpenOutline16,
  IconPlusOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AssistantView,
  CatalogView,
  TeamView,
  TeamWorkbenchView,
} from '../../transport/contracts.js'
import { callAgentTeam, subscribeAgentTeamConversation } from '../api.js'
import { AssistantPanel } from '../assistants/AssistantPanel.js'
import css from '../AgentTeam.module.css'
import { CrownIcon } from '../icons/CrownIcon.js'
import { memberStatusLabel, TASK_STATE_LABELS, teamStartErrorHint } from '../labels.js'
import {
  loadWorkbenchVisibleSlots,
  reconcileVisibleMemberSlots,
  saveWorkbenchVisibleSlots,
  sortMembersLeaderFirst,
  toggleVisibleMemberSlot,
} from '../member-visibility.js'
import { AnimatedModal, Empty, Field } from '../shared.js'
import { openTeam } from '../store.js'
import { canRetryTeamStart, isTeamExecuting } from '../team-status.js'
import type { WorkspaceChoice } from '../types.js'
import { ConversationColumn } from '../workbench/ConversationColumn.js'
import { WorkspacePanel } from '../workspace/WorkspacePanel.js'

const ACTIVE_CONVERSATION_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'waiting_approval',
  'error',
  'starting',
])

const ONLY_ACTIVE_PREFERENCE_STORAGE_KEY = 'agent-team:workbench:only-active'

function loadOnlyActivePreference(): boolean {
  try {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(ONLY_ACTIVE_PREFERENCE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/** 持久化「只看活跃」偏好；存储失败（如隐私模式配额受限）静默忽略。 */
function saveOnlyActivePreference(value: boolean): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(ONLY_ACTIVE_PREFERENCE_STORAGE_KEY, value ? 'true' : 'false')
  } catch {
    // 忽略存储写入失败（隐私模式 / 配额限制），偏好退化为会话内状态
  }
}

function isConversationActive(status: string | undefined): boolean {
  return status !== undefined && ACTIVE_CONVERSATION_STATUSES.has(status)
}

const runtimeStateClass: Readonly<Record<string, string | undefined>> = {
  offline: css.memberRuntimeOffline,
  starting: css.memberRuntimeStarting,
  idle: css.memberRuntimeIdle,
  running: css.memberRuntimeRunning,
  waiting_approval: css.memberRuntimeWaiting,
  error: css.memberRuntimeError,
}

const statusDotStateClass: Readonly<Record<string, string | undefined>> = {
  offline: css.statusOffline,
  starting: css.statusStarting,
  idle: css.statusIdle,
  running: css.statusRunning,
  waiting_approval: css.statusWaiting,
  error: css.statusError,
}

export function TeamPanel({
  catalog,
  assistants,
  teams,
  createRequest,
  selectedTeamId,
  pickWorkspace,
  onChanged,
}: {
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  teams: TeamView[]
  createRequest: number
  selectedTeamId: string | undefined
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  onChanged: () => Promise<void>
}): JSX.Element {
  const [creating, setCreating] = useState(false)
  const [managingAssistants, setManagingAssistants] = useState(false)
  const selectedTeam = teams.find(team => team.id === selectedTeamId)
  const visibleTeams = selectedTeamId === undefined
    ? teams
    : teams.filter(team => team.id === selectedTeamId)

  useEffect(() => {
    if (createRequest > 0) {
      setManagingAssistants(false)
      setCreating(true)
    }
  }, [createRequest])

  useEffect(() => {
    if (selectedTeamId !== undefined) setManagingAssistants(false)
  }, [selectedTeamId])

  return (
    <section className={css.section}>
      {selectedTeam === undefined && <div className={css.sectionHeader}>
        <div>
          <h2 className={css.sectionHeading}>团队 <span className={css.count}>{teams.length}</span></h2>
          <p className={css.sectionDescription}>选择 Leader 和成员，共享同一个 Workspace 协作。</p>
        </div>
        <div className={css.sectionHeaderActions}>
          <Button variant="outline" onClick={() => { setManagingAssistants(true) }}>
            管理助手
          </Button>
          <Button variant="primary" disabled={assistants.length === 0} onClick={() => { setCreating(true) }}>
            组建团队
          </Button>
        </div>
      </div>}
      {selectedTeam === undefined
        ? visibleTeams.length === 0
          ? <Empty text="还没有团队" hint="先通过右上角“管理助手”创建助手，再选择 Leader 和团队成员。" />
          : <div className={css.cardList}>{visibleTeams.map(team => (
              <TeamCard
                key={team.id}
                team={team}
                catalog={catalog}
                assistants={assistants}
                pickWorkspace={pickWorkspace}
                onChanged={onChanged}
                onCloned={async teamId => {
                  openTeam(teamId)
                  await onChanged()
                }}
              />
            ))}</div>
        : <TeamWorkbench
          key={selectedTeam.id}
          team={selectedTeam}
          catalog={catalog}
          assistants={assistants}
          permissionPresets={catalog?.permissionPresets ?? []}
          pickWorkspace={pickWorkspace}
          onChanged={onChanged}
        />}
      <AnimatedModal
        open={managingAssistants}
        onClose={() => { setManagingAssistants(false) }}
        title="管理助手"
        closeLabel="关闭"
        description="创建和维护可在不同团队间复用的助手模板。"
        className={css.assistantManagementDialog ?? ''}
        contentClassName={css.assistantManagementDialogContent ?? ''}
      >
        <div className={css.assistantManagementBody}>
          <AssistantPanel
            catalog={catalog}
            assistants={assistants}
            onChanged={onChanged}
          />
        </div>
      </AnimatedModal>
      <AnimatedModal
        open={creating}
        onClose={() => { setCreating(false) }}
        title="新建团队"
        closeLabel="关闭"
        description="让多个 AI 助手组队协作。一个团队必须有且只有一个 Leader。"
        className={css.teamCreateDialog ?? ''}
        contentClassName={css.teamCreateContent ?? ''}
      >
        <TeamForm
          catalog={catalog}
          assistants={assistants}
          pickWorkspace={pickWorkspace}
          onCancel={() => { setCreating(false) }}
          onCreated={async teamId => {
            setCreating(false)
            openTeam(teamId)
            await onChanged()
          }}
        />
      </AnimatedModal>
    </section>
  )
}

function TeamWorkbench({
  team,
  catalog,
  assistants,
  permissionPresets,
  pickWorkspace,
  onChanged,
}: {
  team: TeamView
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  permissionPresets: CatalogView['permissionPresets']
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  onChanged: () => Promise<void>
}): JSX.Element {
  const members = useMemo(() => sortMembersLeaderFirst(Object.values(team.members)), [team.members])
  const memberIds = useMemo(() => members.map(member => member.id), [members])
  const [snapshot, setSnapshot] = useState<TeamWorkbenchView>()
  const [visibleSlots, setVisibleSlots] = useState(() => loadWorkbenchVisibleSlots(team.id, memberIds, team.leaderSlotId))
  const [error, setError] = useState<string>()
  const [memberActionError, setMemberActionError] = useState<string>()
  const [memberActionBusy, setMemberActionBusy] = useState(false)
  const [memberToRemove, setMemberToRemove] = useState<TeamView['members'][string]>()
  const [managementOpen, setManagementOpen] = useState(false)
  const [addMemberOpen, setAddMemberOpen] = useState(false)
  const [expandedSlotId, setExpandedSlotId] = useState<string>()
  const [onlyActive, setOnlyActive] = useState(() => loadOnlyActivePreference())
  const [onlyActiveHint, setOnlyActiveHint] = useState<string>()
  const [workspaceVisible, setWorkspaceVisible] = useState(true)
  const [workspaceRefreshSignal, setWorkspaceRefreshSignal] = useState(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>()
  const loadGeneration = useRef(0)
  const previousMemberIds = useRef(memberIds)

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    try {
      const next = await callAgentTeam('team.workbench.get', { id: team.id })
      if (generation !== loadGeneration.current) return
      setSnapshot(next)
      setError(undefined)
    } catch (cause) {
      if (generation !== loadGeneration.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [team.id])

  useEffect(() => { void load() }, [load, team.revision])
  useEffect(() => subscribeAgentTeamConversation(team.id, conversation => {
    if (conversation !== undefined) {
      loadGeneration.current += 1
      setWorkspaceRefreshSignal(current => current + 1)
      setSnapshot(current => {
        if (current === undefined) return current
        const conversations = current.conversations.filter(item => item.slotId !== conversation.slotId)
        return { ...current, conversations: [...conversations, conversation] }
      })
      setError(undefined)
      return
    }
    if (refreshTimer.current !== undefined) return
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined
      void load()
    }, 50)
  }, () => { setError('实时连接已断开，正在等待重连') }, () => {
    setError(undefined)
    void load()
  }), [load, team.id])
  useEffect(() => () => {
    if (refreshTimer.current !== undefined) clearTimeout(refreshTimer.current)
  }, [])
  useEffect(() => {
    setVisibleSlots(current => {
      const next = reconcileVisibleMemberSlots(current, previousMemberIds.current, memberIds, team.leaderSlotId)
      const unchanged = next.length === current.length && next.every((slotId, index) => slotId === current[index])
      if (!unchanged) saveWorkbenchVisibleSlots(team.id, next)
      return next
    })
    previousMemberIds.current = memberIds
  }, [team.members, team.leaderSlotId, team.id, memberIds])
  useEffect(() => {
    if (expandedSlotId !== undefined && team.members[expandedSlotId] === undefined) setExpandedSlotId(undefined)
  }, [expandedSlotId, team.members])
  useEffect(() => {
    if (expandedSlotId === undefined) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpandedSlotId(undefined)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('keydown', closeOnEscape) }
  }, [expandedSlotId])

  useEffect(() => {
    if (!onlyActive) setOnlyActiveHint(undefined)
  }, [onlyActive])
  useEffect(() => {
    if (expandedSlotId === undefined) return
    if (onlyActive && !isConversationActive(conversations.get(expandedSlotId)?.status) && expandedSlotId !== team.leaderSlotId) {
      setExpandedSlotId(undefined)
    }
  }, [expandedSlotId, onlyActive, snapshot, team.leaderSlotId])

  function changeOnlyActive(value: boolean): void {
    setOnlyActive(value)
    saveOnlyActivePreference(value)
    setOnlyActiveHint(undefined)
  }

  function toggleMember(slotId: string): void {
    setVisibleSlots(current => {
      const next = toggleVisibleMemberSlot(current, slotId)
      const unchanged = next.length === current.length && next.every((value, index) => value === current[index])
      if (!unchanged) saveWorkbenchVisibleSlots(team.id, next)
      return next
    })
  }

  async function removeMember(): Promise<void> {
    if (memberToRemove === undefined) return
    setMemberActionBusy(true)
    try {
      await callAgentTeam('team.removeMember', {
        teamId: team.id,
        slotId: memberToRemove.id,
      }, team.revision)
      setMemberToRemove(undefined)
      setMemberActionError(undefined)
      await onChanged()
      await load()
    } catch (cause) {
      setMemberActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setMemberActionBusy(false)
    }
  }

  const conversations = new Map(snapshot?.conversations.map(item => [item.slotId, item]) ?? [])
  const isActiveSlot = (slotId: string): boolean =>
    slotId === team.leaderSlotId || isConversationActive(conversations.get(slotId)?.status)
  const tabMembers = members
  const visibleMembers = visibleSlots
    .filter(slotId => !onlyActive || isActiveSlot(slotId))
    .map(slotId => team.members[slotId])
    .filter((value): value is TeamView['members'][string] => value !== undefined)

  return (
    <div className={css.workbench}>
      <div className={css.workbenchMainPane}>
        <div className={css.memberTabs} aria-label="团队成员">
        {tabMembers.map(member => {
          const conversation = conversations.get(member.id)
          const selected = visibleSlots.includes(member.id)
          const hiddenByFilter = onlyActive && member.role !== 'leader' && !isActiveSlot(member.id)
          return (
            <span key={member.id} className={css.memberTabWrap}>
              <button
                type="button"
                className={`${css.memberTab} ${member.role === 'leader' ? '' : css.memberTabWithActions} ${selected ? css.memberTabActive : ''} ${hiddenByFilter ? css.memberTabFiltered : ''}`}
                onClick={() => {
                  if (hiddenByFilter) {
                    setOnlyActiveHint('已开启「只看活跃」，请先取消勾选')
                    return
                  }
                  setOnlyActiveHint(undefined)
                  toggleMember(member.id)
                }}
                aria-pressed={selected}
                title={hiddenByFilter ? '空闲中，已开启只看活跃' : undefined}
              >
                <span className={css.memberAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
                <span className={css.memberTabName}>{member.displayName}</span>
                {member.role === 'leader' && <CrownIcon size={15} className={css.leaderCrown} title="Leader" />}
                <span className={`${css.statusDot} ${statusDotStateClass[conversation?.status ?? 'offline'] ?? css.statusIdle}`} />
              </button>
              {member.role !== 'leader' && (
                <span className={css.memberTabActions}>
                  <button
                    type="button"
                    className={css.memberTabRemoveAction}
                    title={`移出成员 ${member.displayName}`}
                    aria-label={`移出成员 ${member.displayName}`}
                    onClick={() => {
                      setMemberActionError(undefined)
                      setMemberToRemove(member)
                    }}
                  >
                    <IconCloseOutline16 size={12} />
                  </button>
                </span>
              )}
            </span>
          )
        })}
        <label className={css.activeOnlyToggle} title="自动高亮运行中的成员，空闲成员置灰；Leader 始终显示">
          <input
            type="checkbox"
            checked={onlyActive}
            onChange={event => { changeOnlyActive(event.target.checked) }}
          />
          只看活跃
        </label>
        <span className={css.manageButtonWrap}>
          {!workspaceVisible && (
            <Button
              variant="ghost"
              size="sm"
              className={css.manageButton}
              onClick={() => { setWorkspaceVisible(true) }}
            >
              <IconChevronLeftOutline14 size={14} />
              Workspace
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className={css.manageButton}
            onClick={() => {
              setAddMemberOpen(true)
            }}
          >
            <IconPlusOutline16 size={14} />
            添加助手
          </Button>
          <Button variant="ghost" size="sm" className={css.manageButton} onClick={() => { setManagementOpen(value => !value) }}>
            {managementOpen ? '收起管理' : '团队管理'}
          </Button>
        </span>
        </div>
        {error && <div role="alert" className={css.workbenchError}>{error}</div>}
        {onlyActiveHint && <div role="status" className={css.workbenchHint}>{onlyActiveHint}</div>}
        {memberActionError && memberToRemove === undefined && (
          <div role="alert" className={css.workbenchError}>{memberActionError}</div>
        )}
        {expandedSlotId !== undefined && (
          <button
            type="button"
            className={css.conversationFocusBackdrop}
            aria-label="关闭放大对话"
            onClick={() => { setExpandedSlotId(undefined) }}
          />
        )}
        <div className={css.workbenchBody}>
          <div className={css.conversationGrid} style={{ '--member-columns': visibleMembers.length } as React.CSSProperties}>
            {visibleMembers.map(member => (
              <ConversationColumn
                key={member.id}
                team={team}
                member={member}
                conversation={conversations.get(member.id)}
                permissionPresets={permissionPresets}
                onSent={load}
                onTeamChanged={onChanged}
                expanded={expandedSlotId === member.id}
                onExpandedChange={expanded => { setExpandedSlotId(expanded ? member.id : undefined) }}
              />
            ))}
          </div>
        </div>
      </div>
      {workspaceVisible && (
        <WorkspacePanel
          team={team}
          refreshSignal={workspaceRefreshSignal}
          onCollapse={() => { setWorkspaceVisible(false) }}
        />
      )}
      <AnimatedModal
        open={managementOpen}
        onClose={() => { setManagementOpen(false) }}
        title="团队管理"
        description="管理成员、Leader、上下文和团队生命周期。"
        closeLabel="关闭"
        className={css.managementDialog ?? ''}
        contentClassName={css.managementDialogContent ?? ''}
      >
        <div className={css.managementDialogBody}>
          <TeamCard
            team={team}
            catalog={catalog}
            assistants={assistants}
            pickWorkspace={pickWorkspace}
            onChanged={async () => { await onChanged(); await load() }}
            onCloned={async teamId => {
              setManagementOpen(false)
              openTeam(teamId)
              await onChanged()
            }}
            compact
          />
        </div>
      </AnimatedModal>
      <AddTeamMemberDialog
        open={addMemberOpen}
        team={team}
        catalog={catalog}
        assistants={assistants}
        onClose={() => { setAddMemberOpen(false) }}
        onChanged={async () => { await onChanged(); await load() }}
      />
      <AnimatedModal
        open={memberToRemove !== undefined}
        onClose={() => {
          if (memberActionBusy) return
          setMemberToRemove(undefined)
          setMemberActionError(undefined)
        }}
        title="移出团队成员"
        closeLabel="关闭"
        description="该成员将停止参与当前团队。"
        className={css.memberRemoveDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={memberActionBusy}
              onClick={() => {
                setMemberToRemove(undefined)
                setMemberActionError(undefined)
              }}
            >
              取消
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={memberActionBusy}
              onClick={() => { void removeMember() }}
            >
              {memberActionBusy ? '移出中…' : '确认移出'}
            </button>
          </>
        )}
      >
        <div className={css.memberRemoveConfirm}>
          <div className={css.memberRemoveIcon} aria-hidden="true">−</div>
          <div>
            <strong>确定移出“{memberToRemove?.displayName}”？</strong>
            <p>该成员将停止参与团队；若仍有未完成任务，系统会阻止移出。助手模板和 Session 历史都会保留。</p>
          </div>
          {memberActionError && <div role="alert" className={css.inlineError}>{memberActionError}</div>}
        </div>
      </AnimatedModal>
    </div>
  )
}


function AddTeamMemberDialog({
  open,
  team,
  catalog,
  assistants,
  onClose,
  onChanged,
}: {
  open: boolean
  team: TeamView
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  onClose: () => void
  onChanged: () => Promise<void>
}): JSX.Element {
  const [addingAssistantId, setAddingAssistantId] = useState<string>()
  const [configuringAssistants, setConfiguringAssistants] = useState(false)
  const [error, setError] = useState<string>()

  async function addMember(assistant: AssistantView): Promise<void> {
    setAddingAssistantId(assistant.id)
    try {
      await callAgentTeam('team.addMember', {
        teamId: team.id,
        value: { assistantId: assistant.id },
      }, team.revision)
      setError(undefined)
      onClose()
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAddingAssistantId(undefined)
    }
  }

  function close(): void {
    if (addingAssistantId !== undefined) return
    setConfiguringAssistants(false)
    setError(undefined)
    onClose()
  }

  return (
    <>
      <AnimatedModal
        open={open}
        onClose={close}
        title="添加助手"
        description={`选择一个助手加入团队“${team.name}”。同一个助手可以多次加入。`}
        closeLabel="关闭"
        className={css.addMemberDialog ?? ''}
        contentClassName={css.addMemberDialogContent ?? ''}
      >
        <div className={css.addMemberDialogHeader}>
          <strong>助手列表</strong>
          <div className={css.addMemberDialogHeaderActions}>
            <span>{assistants.length} 个助手</span>
            <Button
              variant="outline"
              size="sm"
              disabled={addingAssistantId !== undefined}
              onClick={() => { setConfiguringAssistants(true) }}
            >
              助手配置
            </Button>
          </div>
        </div>
        <div className={css.addMemberMenuList}>
          {assistants.map(assistant => (
            <button
              key={assistant.id}
              type="button"
              className={css.addMemberOption}
              disabled={addingAssistantId !== undefined}
              onClick={() => { void addMember(assistant) }}
            >
              <span className={css.addMemberAvatar}>{assistant.name.slice(0, 1).toUpperCase()}</span>
              <span className={css.addMemberCopy}>
                <strong>{assistant.name}</strong>
                <span>{assistant.provider} / {assistant.model}</span>
              </span>
              <span className={css.addMemberOptionAction}>
                {addingAssistantId === assistant.id ? '添加中…' : <IconPlusOutline16 size={14} />}
              </span>
            </button>
          ))}
          {assistants.length === 0 && <span className={css.addMemberEmpty}>还没有可添加的助手模板</span>}
        </div>
        {error && <div role="alert" className={css.inlineError}>{error}</div>}
      </AnimatedModal>
      <AnimatedModal
        open={configuringAssistants}
        onClose={() => { setConfiguringAssistants(false) }}
        title="助手配置"
        closeLabel="关闭"
        description="创建和维护可在不同团队间复用的助手模板。"
        className={css.assistantManagementDialog ?? ''}
        contentClassName={css.assistantManagementDialogContent ?? ''}
      >
        <div className={css.assistantManagementBody}>
          <AssistantPanel
            catalog={catalog}
            assistants={assistants}
            onChanged={onChanged}
          />
        </div>
      </AnimatedModal>
    </>
  )
}

function CloneTeamDialog({
  open,
  team,
  catalog,
  pickWorkspace,
  onClose,
  onCreated,
}: {
  open: boolean
  team: TeamView
  catalog: CatalogView | undefined
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  onClose: () => void
  onCreated: (teamId: string) => Promise<void>
}): JSX.Element {
  const catalogWorkspaces = catalog?.workspaces.filter(workspace => workspace.status === 'ok') ?? []
  const [name, setName] = useState(`${team.name} 副本`)
  const [workspaceId, setWorkspaceId] = useState(team.workspaceId)
  const [pickedWorkspace, setPickedWorkspace] = useState<WorkspaceChoice>()
  const [saving, setSaving] = useState(false)
  const [pickingWorkspace, setPickingWorkspace] = useState(false)
  const [error, setError] = useState<string>()
  const members = Object.values(team.members)
  const workspaces = useMemo(() => {
    const items = [...catalogWorkspaces]
    const fallback: WorkspaceChoice = pickedWorkspace ?? {
      id: team.workspaceId,
      path: team.workspacePath,
      title: workspaceName(team.workspacePath),
    }
    if (!items.some(workspace => workspace.id === fallback.id)) {
      items.push({ ...fallback, status: 'ok' as const })
    }
    return items
  }, [catalogWorkspaces, pickedWorkspace, team.workspaceId, team.workspacePath])

  useEffect(() => {
    if (!open) return
    setName(`${team.name} 副本`)
    setWorkspaceId(team.workspaceId)
    setPickedWorkspace(undefined)
    setSaving(false)
    setPickingWorkspace(false)
    setError(undefined)
  }, [open, team.id, team.name, team.workspaceId])

  async function chooseWorkspace(): Promise<void> {
    setPickingWorkspace(true)
    try {
      const workspace = await pickWorkspace()
      if (workspace === null) return
      setPickedWorkspace(workspace)
      setWorkspaceId(workspace.id)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPickingWorkspace(false)
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!name.trim() || !workspaceId) return
    setSaving(true)
    try {
      const draft = await callAgentTeam('team.clone', {
        teamId: team.id,
        name,
        workspaceId,
      })
      await callAgentTeam('team.start', { id: draft.id }, draft.revision)
      setError(undefined)
      onClose()
      await onCreated(draft.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  function close(): void {
    if (saving || pickingWorkspace) return
    onClose()
  }

  return (
    <AnimatedModal
      open={open}
      onClose={close}
      title="复制团队"
      closeLabel="关闭"
      description="复用当前团队配置，并为每位成员创建全新 Session。"
      className={css.cloneTeamDialog ?? ''}
      contentClassName={css.cloneTeamDialogContent ?? ''}
    >
      <form className={css.cloneTeamForm} onSubmit={(event) => { void submit(event) }}>
        <div className={css.cloneTeamFields}>
          <Field label="团队名称">
            <input
              required
              value={name}
              onChange={event => { setName(event.target.value) }}
              placeholder="输入团队名称"
              className={css.input}
              autoFocus
            />
          </Field>
          <Field label="Workspace">
            <div className={css.workspacePickerRow}>
              <select
                required
                value={workspaceId}
                onChange={event => { setWorkspaceId(event.target.value) }}
                className={css.input}
              >
                <option value="">{workspaces.length === 0 ? '暂无 Workspace' : '请选择 Workspace'}</option>
                {workspaces.map(item => <option key={item.id} value={item.id}>{item.title} — {item.path}</option>)}
              </select>
              <Button
                variant="outline"
                type="button"
                disabled={pickingWorkspace || saving}
                onClick={() => { void chooseWorkspace() }}
                className={css.workspacePickButton}
              >
                <IconFolderOpenOutline16 size={16} />
                {pickingWorkspace ? '选择中…' : '选择文件夹'}
              </Button>
            </div>
          </Field>
        </div>
        <section className={css.cloneTeamMembers} aria-label="复制的团队成员">
          <div className={css.cloneTeamSectionHeader}>
            <strong>团队成员</strong>
            <span>{members.length} 人</span>
          </div>
          <div className={css.cloneTeamMemberGrid}>
            {members.map(member => (
              <div key={member.id} className={`${css.cloneTeamMember} ${member.role === 'leader' ? css.cloneTeamLeader : ''}`}>
                <span className={css.cloneTeamAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
                <span className={css.cloneTeamMemberCopy}>
                  <strong title={member.displayName}>{member.displayName}</strong>
                  <span>{member.assistantSnapshot.provider} / {member.assistantSnapshot.model}</span>
                </span>
                <span className={css.cloneTeamRole}>{member.role === 'leader' ? 'Leader' : '成员'}</span>
              </div>
            ))}
          </div>
        </section>
        <p className={css.cloneTeamNotice}>不会复制任务、对话上下文、消息历史或运行状态。</p>
        {error && <div role="alert" className={css.inlineError}>{error}</div>}
        <div className={css.cloneTeamActions}>
          <Button variant="outline" type="button" disabled={saving || pickingWorkspace} onClick={close}>取消</Button>
          <Button variant="primary" type="submit" disabled={saving || pickingWorkspace || !name.trim() || !workspaceId}>
            {saving ? '复制并启动中…' : '复制并启动'}
          </Button>
        </div>
      </form>
    </AnimatedModal>
  )
}

function TeamCard({
  team,
  catalog,
  assistants,
  pickWorkspace,
  onChanged,
  onCloned,
  compact = false,
}: {
  team: TeamView
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  onChanged: () => Promise<void>
  onCloned: (teamId: string) => Promise<void>
  compact?: boolean
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [addingMember, setAddingMember] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [dissolveOpen, setDissolveOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [memberToRemove, setMemberToRemove] = useState<{ slotId: string; displayName: string }>()
  const [error, setError] = useState<string>()
  const members = sortMembersLeaderFirst(Object.values(team.members))
  const tasks = Object.values(team.tasks)
  const executing = isTeamExecuting(team)

  async function dissolve(): Promise<void> {
    setBusy(true)
    try {
      await callAgentTeam('team.dissolve', { teamId: team.id, confirmation: team.name })
      setDissolveOpen(false)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function resetTeam(): Promise<void> {
    setBusy(true)
    try {
      await callAgentTeam('team.reset', { teamId: team.id, confirmation: team.name }, team.revision)
      setResetOpen(false)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function removeMember(): Promise<void> {
    if (memberToRemove === undefined) return
    setBusy(true)
    try {
      await callAgentTeam('team.removeMember', {
        teamId: team.id,
        slotId: memberToRemove.slotId,
      }, team.revision)
      setMemberToRemove(undefined)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function changeLeader(successorSlotId: string): Promise<void> {
    if (successorSlotId === team.leaderSlotId) return
    setBusy(true)
    try {
      await callAgentTeam('team.changeLeader', {
        teamId: team.id,
        successorSlotId,
      }, team.revision)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function retryStart(): Promise<void> {
    setBusy(true)
    try {
      await callAgentTeam('team.start', { id: team.id }, team.revision)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <article className={`${css.card} ${compact ? css.managementCard : ''}`}>
      <header className={css.teamCardHeader}>
        <div className={css.teamCardIdentity}>
          <strong className={css.teamCardName}>{team.name}</strong>
          <span className={css.teamCardWorkspace}>{team.workspacePath}</span>
        </div>
        {canRetryTeamStart(team.state) && (
          <span className={css.teamCardErrorActions}>
            <span className={`${css.badge} ${css.badgeError}`}>启动失败</span>
            <button
              type="button"
              className={css.retryStartButton}
              disabled={busy}
              onClick={() => { void retryStart() }}
            >
              {busy ? '启动中…' : '重试启动'}
            </button>
          </span>
        )}
        {executing && <span className={`${css.badge} ${css.badgeSuccess ?? ''}`}>任务执行中</span>}
      </header>

      {canRetryTeamStart(team.state) && (
        <div className={css.teamLastError}>
          <span>
            {team.lastError
              ? `上次启动失败（${new Date(team.lastError.failedAt).toLocaleString()}）：${team.lastError.message}`
              : '上次启动失败：原因未记录（升级前数据），可点「重试启动」重新获取'}
          </span>
          <span>{teamStartErrorHint(team.lastError?.code)}</span>
        </div>
      )}

      <section className={css.teamMemberSection} aria-label="团队成员">
        <div className={css.teamSectionHeader}>
          <strong>团队成员</strong>
          <span className={css.teamSectionActions}>
            <span>{members.length} 人</span>
            <button
              type="button"
              className={css.addMemberButton}
              disabled={busy}
              onClick={() => { setAddingMember(true) }}
            >
              <IconPlusOutline16 size={14} />
              添加助手
            </button>
          </span>
        </div>
        <div className={css.memberGrid}>
          {members.map(member => (
            <div key={member.id} className={`${css.memberTile} ${member.role === 'leader' ? css.memberTileLeader : ''}`}>
              <span className={css.memberTileAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
              <span className={css.memberTileCopy}>
                <span className={css.memberTileName} title={member.displayName}>{member.displayName}</span>
                <span className={`${css.memberRuntime} ${runtimeStateClass[member.lastRuntimeState] ?? css.memberRuntimeIdle}`}>
                  <span className={`${css.statusDot} ${statusDotStateClass[member.lastRuntimeState] ?? css.statusIdle}`} />
                  {memberStatusLabel(member.lastRuntimeState)}
                </span>
              </span>
              <span className={css.memberTileActions}>
                {member.role === 'leader'
                  ? <span className={`${css.memberRole} ${css.memberRoleLeader}`}>Leader</span>
                  : <button
                    type="button"
                    className={`${css.memberRole} ${css.memberRoleAction}`}
                    disabled={busy}
                    onClick={() => { void changeLeader(member.id) }}
                  >
                    设为 Leader
                  </button>}
                {member.id !== team.leaderSlotId && (
                  <button
                    type="button"
                    className={css.memberRemoveButton}
                    disabled={busy}
                    onClick={() => {
                      setError(undefined)
                      setMemberToRemove({ slotId: member.id, displayName: member.displayName })
                    }}
                  >
                    移出
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </section>
      <div className={`${css.contextResetPanel} ${css.cloneTeamPanel ?? ''}`}>
        <div className={css.contextResetCopy}>
          <strong>复制团队</strong>
          <span>复用当前成员和配置，为所有成员创建全新 Session。</span>
        </div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setError(undefined)
            setCloneOpen(true)
          }}
        >
          复制团队
        </Button>
      </div>
      {tasks.length > 0 && (
        <div className={css.taskList}>
          <strong className={css.taskTitle}>任务板</strong>
          {tasks.map(task => (
            <div key={task.id} className={css.memberRow}>
              <span>{task.title}</span>
              <span className={css.muted}>{TASK_STATE_LABELS[task.status] ?? task.status}{task.ownerSlotId ? ` · ${team.members[task.ownerSlotId]?.displayName ?? '已移除成员'}` : ''}</span>
            </div>
          ))}
        </div>
      )}
      {team.state !== 'deleting' && team.state !== 'delete_blocked' && (
        <div className={css.contextResetPanel}>
          <div className={css.contextResetCopy}>
            <strong>清空任务与上下文</strong>
            <span>停止所有成员并清空任务板，为每位成员换用全新 Session。Workspace 文件和团队配置不变。</span>
          </div>
          <button
            type="button"
            className={css.dangerButton}
            disabled={busy}
            onClick={() => {
              setError(undefined)
              setResetOpen(true)
            }}
          >
            {busy ? '处理中…' : '清空'}
          </button>
        </div>
      )}
      <div className={`${css.contextResetPanel} ${css.dissolvePanel}`}>
        <div className={css.contextResetCopy}>
          <strong>解散团队</strong>
          <span>永久删除团队、任务和团队消息；助手模板与 Workspace 文件保留，旧 Session 日志不再恢复。</span>
        </div>
        <button
          type="button"
          className={css.dangerButton}
          disabled={busy || team.state === 'deleting'}
          onClick={() => {
            setError(undefined)
            setDissolveOpen(true)
          }}
        >
          {team.state === 'deleting' ? '解散中…' : team.state === 'delete_blocked' ? '重试解散' : '解散团队'}
        </button>
      </div>
        {error && !dissolveOpen && !resetOpen && memberToRemove === undefined && <div role="alert" className={css.inlineError}>{error}</div>}
      </article>
      <AddTeamMemberDialog
        open={addingMember}
        team={team}
        catalog={catalog}
        assistants={assistants}
        onClose={() => { setAddingMember(false) }}
        onChanged={onChanged}
      />
      <CloneTeamDialog
        open={cloneOpen}
        team={team}
        catalog={catalog}
        pickWorkspace={pickWorkspace}
        onClose={() => { setCloneOpen(false) }}
        onCreated={onCloned}
      />
      <AnimatedModal
        open={memberToRemove !== undefined}
        onClose={() => {
          if (busy) return
          setMemberToRemove(undefined)
          setError(undefined)
        }}
        title="移出团队成员"
        closeLabel="关闭"
        description="该成员将停止参与当前团队。"
        className={css.memberRemoveDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setMemberToRemove(undefined)
                setError(undefined)
              }}
            >
              取消
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={busy}
              onClick={() => { void removeMember() }}
            >
              {busy ? '移出中…' : '确认移出'}
            </button>
          </>
        )}
      >
        <div className={css.memberRemoveConfirm}>
          <div className={css.memberRemoveIcon} aria-hidden="true">−</div>
          <div>
            <strong>确定移出“{memberToRemove?.displayName}”？</strong>
            <p>该成员将停止参与团队；若仍有未完成任务，系统会阻止移出。助手模板和 Session 历史都会保留。</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </AnimatedModal>
      <AnimatedModal
        open={resetOpen}
        onClose={() => {
          if (busy) return
          setResetOpen(false)
          setError(undefined)
        }}
        title="清空任务与上下文"
        closeLabel="关闭"
        description="所有成员将换用全新的对话上下文。"
        className={css.teamResetDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setResetOpen(false)
                setError(undefined)
              }}
            >
              取消
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={busy}
              onClick={() => { void resetTeam() }}
            >
              {busy ? '清空中…' : '确认清空'}
            </button>
          </>
        )}
      >
        <div className={css.teamResetConfirm}>
          <div className={css.teamResetIcon} aria-hidden="true">↻</div>
          <div>
            <strong>确定清空“{team.name}”的任务与上下文？</strong>
            <p>所有成员会停止，任务板和待处理消息会被清空，并换用全新 Session。Workspace 文件、团队配置和旧 Session 日志会保留。</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </AnimatedModal>
      <AnimatedModal
        open={dissolveOpen}
        onClose={() => {
          if (busy) return
          setDissolveOpen(false)
          setError(undefined)
        }}
        title="解散团队"
        closeLabel="关闭"
        description="此操作无法撤销。"
        className={css.teamDissolveDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDissolveOpen(false)
                setError(undefined)
              }}
            >
              取消
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={busy}
              onClick={() => { void dissolve() }}
            >
              {busy ? '解散中…' : '确认解散'}
            </button>
          </>
        )}
      >
        <div className={css.teamDissolveConfirm}>
          <div className={css.teamDissolveIcon} aria-hidden="true">!</div>
          <div>
            <strong>确定解散“{team.name}”？</strong>
            <p>所有成员将停止，团队任务、消息和配置会被永久删除。助手模板与 Workspace 文件会保留。</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </AnimatedModal>
    </>
  )
}

interface DraftMember {
  key: string
  assistantId: string
}

function workspaceName(path: string): string {
  const normalized = path.replace(/[/\\]+$/, '')
  return normalized.split(/[/\\]/).at(-1) || 'Workspace'
}

function TeamForm({
  catalog,
  assistants,
  pickWorkspace,
  onCancel,
  onCreated,
}: {
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  onCancel: () => void
  onCreated: (teamId: string) => Promise<void>
}): JSX.Element {
  const catalogWorkspaces = catalog?.workspaces.filter(workspace => workspace.status === 'ok') ?? []
  const [name, setName] = useState('')
  const [workspaceId, setWorkspaceId] = useState(catalogWorkspaces[0]?.id ?? '')
  const [pickedWorkspace, setPickedWorkspace] = useState<WorkspaceChoice>()
  const [query, setQuery] = useState('')
  const [members, setMembers] = useState<DraftMember[]>([])
  const [leaderKey, setLeaderKey] = useState<string>()
  const [directMemberChat, setDirectMemberChat] = useState(true)
  const [saving, setSaving] = useState(false)
  const [pickingWorkspace, setPickingWorkspace] = useState(false)
  const [error, setError] = useState<string>()
  const workspaces = useMemo(() => {
    if (pickedWorkspace === undefined || catalogWorkspaces.some(workspace => workspace.id === pickedWorkspace.id)) {
      return catalogWorkspaces
    }
    return [...catalogWorkspaces, { ...pickedWorkspace, status: 'ok' as const }]
  }, [catalogWorkspaces, pickedWorkspace])
  const byId = useMemo(() => new Map(assistants.map(assistant => [assistant.id, assistant])), [assistants])
  const filteredAssistants = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return assistants
    return assistants.filter(assistant => [assistant.name, assistant.description, assistant.provider, assistant.model]
      .some(value => value?.toLocaleLowerCase().includes(normalized)))
  }, [assistants, query])

  useEffect(() => { if (!workspaceId && workspaces[0]) setWorkspaceId(workspaces[0].id) }, [workspaceId, workspaces])

  async function chooseWorkspace(): Promise<void> {
    setPickingWorkspace(true)
    try {
      const workspace = await pickWorkspace()
      if (workspace === null) return
      setPickedWorkspace(workspace)
      setWorkspaceId(workspace.id)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPickingWorkspace(false)
    }
  }

  function addAssistant(assistant: AssistantView): void {
    const member: DraftMember = {
      key: crypto.randomUUID(),
      assistantId: assistant.id,
    }
    setMembers(current => [...current, member])
    setLeaderKey(current => current ?? member.key)
  }

  function removeMember(key: string): void {
    const remaining = members.filter(member => member.key !== key)
    setMembers(remaining)
    if (leaderKey === key) setLeaderKey(remaining[0]?.key)
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (leaderKey === undefined || members.length === 0) return
    setSaving(true)
    try {
      const draft = await callAgentTeam('team.createDraft', {
        name,
        workspaceId,
        directMemberChat,
        members: members.map(member => ({
          assistantId: member.assistantId,
          role: member.key === leaderKey ? 'leader' : 'member',
        })),
      })
      await callAgentTeam('team.start', { id: draft.id }, draft.revision)
      await onCreated(draft.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const canSubmit = name.trim().length > 0
    && workspaceId.length > 0
    && leaderKey !== undefined
    && members.length > 0

  return (
    <form onSubmit={(event) => { void submit(event) }} className={css.teamBuilderForm}>
      <div className={css.teamBuilderGrid}>
        <section className={css.assistantPicker}>
          <div className={css.builderSectionHeading}>
            <strong>所有助手 <span className={css.count}>{assistants.length}</span></strong>
          </div>
          <input
            type="search"
            value={query}
            onChange={event => { setQuery(event.target.value) }}
            placeholder="搜索助手、Provider 或模型"
            aria-label="搜索助手"
            className={css.builderSearch}
          />
          <div className={css.assistantPickList}>
            {filteredAssistants.map(assistant => (
              <div key={assistant.id} className={css.assistantPickRow}>
                <div className={css.assistantPickAvatar} aria-hidden="true">
                  {assistant.name.slice(0, 1).toLocaleUpperCase()}
                </div>
                <div className={css.assistantPickCopy}>
                  <strong>{assistant.name}</strong>
                  <span>{assistant.provider} / {assistant.model}</span>
                </div>
                <button
                  type="button"
                  className={css.assistantAddButton}
                  onClick={() => { addAssistant(assistant) }}
                  aria-label={`添加 ${assistant.name}`}
                >
                  <IconPlusOutline16 size={16} />
                </button>
              </div>
            ))}
            {filteredAssistants.length === 0 && <Empty text="没有匹配的助手" />}
          </div>
        </section>

        <section className={css.selectedMembers}>
          <div className={css.builderSectionHeading}>
            <div>
              <strong>已选成员 {members.length}</strong>
              <p>选择团队成员并指定一个 Leader。同一助手可多次选择。</p>
            </div>
            <span className={css.leaderLegend}>Leader</span>
          </div>
          <div className={css.selectedMemberList}>
            {members.length === 0
              ? (
                  <div className={css.memberEmpty}>
                    <strong>至少选择一个助手当团队 Leader。</strong>
                    <span>从左侧助手列表添加成员。</span>
                  </div>
                )
              : members.map(member => {
                  const assistant = byId.get(member.assistantId)
                  const leader = member.key === leaderKey
                  return (
                    <div key={member.key} className={`${css.selectedMemberRow} ${leader ? css.selectedLeader : ''}`}>
                      <div className={css.assistantPickAvatar} aria-hidden="true">
                        {assistant?.name.slice(0, 1).toLocaleUpperCase() ?? '?'}
                      </div>
                      <div className={css.selectedMemberCopy}>
                        <strong>{assistant?.name ?? '助手'}</strong>
                        <span>{assistant?.provider} / {assistant?.model}</span>
                      </div>
                      {leader
                        ? <span className={css.leaderBadge}>Leader</span>
                        : <button type="button" className={css.setLeaderButton} onClick={() => { setLeaderKey(member.key) }}>设为 Leader</button>}
                      <button
                        type="button"
                        className={css.removeDraftMember}
                        onClick={() => { removeMember(member.key) }}
                        aria-label={`移除 ${assistant?.name ?? '助手'}`}
                      >
                        <IconCloseOutline16 size={14} />
                      </button>
                    </div>
                  )
                })}
          </div>
          <div className={css.teamFields}>
            <Field label="团队名称">
              <input required value={name} onChange={event => { setName(event.target.value) }} placeholder="输入团队名称" className={css.input} />
            </Field>
            <Field label="Workspace">
              <div className={css.workspacePickerRow}>
                <select required value={workspaceId} onChange={event => { setWorkspaceId(event.target.value) }} className={css.input}>
                  <option value="">{workspaces.length === 0 ? '暂无 Workspace' : '请选择 Workspace'}</option>
                  {workspaces.map(item => <option key={item.id} value={item.id}>{item.title} — {item.path}</option>)}
                </select>
                <Button
                  variant="outline"
                  type="button"
                  disabled={pickingWorkspace || saving}
                  onClick={() => { void chooseWorkspace() }}
                  className={css.workspacePickButton}
                >
                  <IconFolderOpenOutline16 size={16} />
                  {pickingWorkspace ? '选择中…' : '选择文件夹'}
                </Button>
              </div>
            </Field>
            <label className={css.checkboxRow}>
              <input type="checkbox" checked={directMemberChat} onChange={event => { setDirectMemberChat(event.target.checked) }} />
              允许用户和普通成员直接通信
            </label>
          </div>
        </section>
      </div>
      {error && <div role="alert" className={css.inlineError}>{error}</div>}
      <div className={css.teamBuilderActions}>
        <Button variant="outline" onClick={onCancel} disabled={saving}>取消</Button>
        <Button variant="primary" type="submit" disabled={saving || !canSubmit}>
          {saving ? '创建并启动中…' : '创建并启动'}
        </Button>
      </div>
    </form>
  )
}
