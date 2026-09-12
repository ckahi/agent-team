import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconBranchOutline16,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconFolderClose16,
  IconFolderOpen16,
  IconRefreshOutline16,
  IconRightUpOutline14,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  TeamView,
  WorkspaceEntryView,
  WorkspaceGitChangeView,
  WorkspaceGitDiffView,
  WorkspaceGitStatusView,
} from '../../transport/contracts.js'
import { callAgentTeam, subscribeAgentTeamWorkspace } from '../api.js'
import { AnimatedModal } from '../shared.js'
import css from './WorkspacePanel.module.css'

export function WorkspacePanel({
  team,
  refreshSignal,
  onCollapse,
}: {
  team: TeamView
  refreshSignal: number
  onCollapse: () => void
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<'files' | 'changes'>('files')
  const [entries, setEntries] = useState<WorkspaceEntryView[]>([])
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatusView>()
  const [diffTarget, setDiffTarget] = useState<WorkspaceDiffTarget>()
  const [fileError, setFileError] = useState<string>()
  const [gitError, setGitError] = useState<string>()
  const [fileRefreshing, setFileRefreshing] = useState(false)
  const [gitRefreshing, setGitRefreshing] = useState(false)
  const [treeRefreshToken, setTreeRefreshToken] = useState(0)
  const fileLoadGeneration = useRef(0)
  const gitLoadGeneration = useRef(0)

  const loadFiles = useCallback(async (): Promise<void> => {
    const generation = ++fileLoadGeneration.current
    setFileRefreshing(true)
    try {
      const next = await callAgentTeam('team.workspace.list', { teamId: team.id })
      if (generation !== fileLoadGeneration.current) return
      setEntries(next)
      setTreeRefreshToken(current => current + 1)
      setFileError(undefined)
    } catch (cause) {
      if (generation !== fileLoadGeneration.current) return
      setFileError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (generation === fileLoadGeneration.current) setFileRefreshing(false)
    }
  }, [team.id])

  const loadChanges = useCallback(async (): Promise<void> => {
    const generation = ++gitLoadGeneration.current
    setGitRefreshing(true)
    try {
      const next = await callAgentTeam('team.workspace.changes', { teamId: team.id })
      if (generation !== gitLoadGeneration.current) return
      setGitStatus(next)
      setGitError(undefined)
    } catch (cause) {
      if (generation !== gitLoadGeneration.current) return
      setGitError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (generation === gitLoadGeneration.current) setGitRefreshing(false)
    }
  }, [team.id])

  const load = useCallback(async (): Promise<void> => {
    await Promise.allSettled([loadFiles(), loadChanges()])
  }, [loadChanges, loadFiles])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (refreshSignal === 0) return
    const timer = setTimeout(() => { void load() }, 600)
    return () => { clearTimeout(timer) }
  }, [load, refreshSignal])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeAgentTeamWorkspace(team.id, () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => { void load() }, 250)
    }, () => {})
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
    }
  }, [load, team.id])

  const refreshing = fileRefreshing || gitRefreshing
  return (
    <>
      <aside className={css.workspacePanel}>
        <div className={css.workspaceHeader}>
          <div><strong>Workspace</strong><span>{team.workspacePath}</span></div>
          <div className={css.workspaceHeaderActions}>
            <Tooltip label={refreshing ? '刷新中…' : '刷新 Workspace'} side="bottom" delayMs={400}>
              <button
                type="button"
                className={`${css.workspaceRefreshButton} ${refreshing ? css.workspaceRefreshButtonBusy : ''}`}
                disabled={refreshing}
                aria-label={refreshing ? '正在刷新 Workspace' : '刷新 Workspace'}
                onClick={() => { void load() }}
              >
                <IconRefreshOutline16 size={16} />
              </button>
            </Tooltip>
            <Tooltip label="收起 Workspace" side="bottom" delayMs={400}>
              <button
                type="button"
                className={css.workspaceRefreshButton}
                aria-label="收起 Workspace"
                onClick={onCollapse}
              >
                <IconChevronRightOutline14 size={14} />
              </button>
            </Tooltip>
          </div>
        </div>
        <div className={css.workspaceTabs} role="tablist" aria-label="Workspace 视图">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'files'}
            className={activeTab === 'files' ? css.workspaceTabActive : ''}
            onClick={() => { setActiveTab('files') }}
          >文件</button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'changes'}
            className={activeTab === 'changes' ? css.workspaceTabActive : ''}
            onClick={() => { setActiveTab('changes') }}
          >
            变更
            {gitStatus?.state === 'repository' && gitStatus.changes.length > 0
              ? <span>{gitStatus.changes.length}</span>
              : null}
          </button>
        </div>
        <div className={css.workspaceContent}>
          {activeTab === 'files' ? (
            <div className={css.fileTree}>
              {entries.map(entry => (
                <WorkspaceTreeRow
                  key={entry.path}
                  teamId={team.id}
                  entry={entry}
                  depth={0}
                  refreshToken={treeRefreshToken}
                />
              ))}
              {entries.length === 0 && !fileError && (
                <span className={css.fileEmpty}>{fileRefreshing ? '正在读取目录…' : '目录为空'}</span>
              )}
              {fileError && <span className={css.fileError}>{fileError}</span>}
            </div>
          ) : (
            <WorkspaceChanges
              status={gitStatus}
              error={gitError}
              refreshing={gitRefreshing}
              onOpenDiff={setDiffTarget}
            />
          )}
        </div>
      </aside>
      <WorkspaceDiffDialog
        teamId={team.id}
        target={diffTarget}
        onClose={() => { setDiffTarget(undefined) }}
      />
    </>
  )
}

interface WorkspaceDiffTarget {
  change: WorkspaceGitChangeView
  scope: 'staged' | 'unstaged'
}

function WorkspaceChanges({
  status,
  error,
  refreshing,
  onOpenDiff,
}: {
  status: WorkspaceGitStatusView | undefined
  error: string | undefined
  refreshing: boolean
  onOpenDiff: (target: WorkspaceDiffTarget) => void
}): JSX.Element {
  if (error !== undefined) return <span className={css.fileError}>{error}</span>
  if (status === undefined) return <span className={css.fileEmpty}>{refreshing ? '正在读取 Git 状态…' : '暂无状态'}</span>
  if (status.state === 'not-repository') {
    return (
      <div className={css.workspaceGitEmpty}>
        <span><IconBranchOutline16 size={20} /></span>
        <strong>当前 Workspace 不是 Git 仓库</strong>
        <p>仍可在“文件”中浏览工作区内容。</p>
      </div>
    )
  }
  if (status.changes.length === 0) {
    return (
      <div className={css.workspaceGitEmpty}>
        <span><IconBranchOutline16 size={20} /></span>
        <strong>没有未提交变更</strong>
        <p>Workspace 当前处于干净状态。</p>
      </div>
    )
  }

  const conflicted = status.changes.filter(change => change.kind === 'unmerged')
  const staged = status.changes.filter(change => change.staged && change.kind !== 'unmerged')
  const modified = status.changes.filter(change => change.unstaged && !['unmerged', 'untracked'].includes(change.kind))
  const untracked = status.changes.filter(change => change.kind === 'untracked')
  return (
    <div className={css.workspaceChanges}>
      <WorkspaceChangeGroup title="冲突" changes={conflicted} scope="unstaged" onOpenDiff={onOpenDiff} />
      <WorkspaceChangeGroup title="已暂存" changes={staged} scope="staged" onOpenDiff={onOpenDiff} />
      <WorkspaceChangeGroup title="已修改" changes={modified} scope="unstaged" onOpenDiff={onOpenDiff} />
      <WorkspaceChangeGroup title="未跟踪" changes={untracked} scope="unstaged" onOpenDiff={onOpenDiff} />
      {status.truncated && <span className={css.workspaceChangesTruncated}>变更过多，仅显示前 2000 项。</span>}
    </div>
  )
}

function WorkspaceChangeGroup({
  title,
  changes,
  scope,
  onOpenDiff,
}: {
  title: string
  changes: WorkspaceGitChangeView[]
  scope: 'staged' | 'unstaged'
  onOpenDiff: (target: WorkspaceDiffTarget) => void
}): JSX.Element | null {
  if (changes.length === 0) return null
  return (
    <section className={css.workspaceChangeGroup}>
      <header><strong>{title}</strong><span>{changes.length}</span></header>
      {changes.map(change => (
        <button
          type="button"
          className={css.workspaceChangeRow}
          key={`${title}:${change.path}`}
          title={`预览 ${change.path}`}
          onClick={() => { onOpenDiff({ change, scope }) }}
        >
          <span className={`${css.workspaceChangeCode} ${workspaceChangeTone(change)}`}>
            {workspaceChangeCode(change)}
          </span>
          <span className={css.workspaceChangePath}>
            {change.originalPath === undefined ? change.path : `${change.originalPath} → ${change.path}`}
          </span>
        </button>
      ))}
    </section>
  )
}

function WorkspaceDiffDialog({
  teamId,
  target,
  onClose,
}: {
  teamId: string
  target: WorkspaceDiffTarget | undefined
  onClose: () => void
}): JSX.Element {
  const [diff, setDiff] = useState<WorkspaceGitDiffView>()
  const [layout, setLayout] = useState<'unified' | 'split'>('unified')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const themeType = useHarnessThemeType()

  useEffect(() => {
    if (target === undefined) {
      setDiff(undefined)
      setError(undefined)
      return
    }
    let active = true
    setLoading(true)
    setDiff(undefined)
    setError(undefined)
    void callAgentTeam('team.workspace.diff', {
      teamId,
      path: target.change.path,
      scope: target.scope,
      layout,
      theme: themeType,
    }).then(next => {
      if (active) setDiff(next)
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [layout, target, teamId, themeType])

  const scopeLabel = target?.scope === 'staged' ? '已暂存' : '工作区'
  const hasTextPatch = diff !== undefined && !diff.binary && diff.html.length > 0
  return (
    <AnimatedModal
      open={target !== undefined}
      onClose={onClose}
      title={target?.change.path ?? '文件变更'}
      className={css.workspaceDiffDialog ?? ''}
      headless
    >
      <div className={css.workspaceDiffShell}>
        <header className={css.workspaceDiffHeader}>
          <div className={css.workspaceDiffHeading}>
            <div className={css.workspaceDiffTitleRow}>
              <h2>{target?.change.path ?? '文件变更'}</h2>
              <span>{workspaceChangeLabel(target?.change.kind)}</span>
            </div>
            <p>{scopeLabel}变更 · 只读预览</p>
          </div>
          <div className={css.workspaceDiffHeaderActions}>
            <div className={css.workspaceDiffLayout} role="group" aria-label="Diff 布局">
              <button
                type="button"
                className={layout === 'unified' ? css.workspaceDiffLayoutActive : ''}
                onClick={() => { setLayout('unified') }}
              >统一</button>
              <button
                type="button"
                className={layout === 'split' ? css.workspaceDiffLayoutActive : ''}
                onClick={() => { setLayout('split') }}
              >分栏</button>
            </div>
            <button type="button" className={css.workspaceDiffClose} aria-label="关闭变更预览" onClick={onClose}>
              <IconCloseOutline16 size={16} />
            </button>
          </div>
        </header>
        <div className={css.workspaceDiffBody}>
          {loading && <div className={css.workspaceDiffState}>正在读取文件变更…</div>}
          {error && <div role="alert" className={css.workspaceDiffError}>{error}</div>}
          {diff?.binary && <div className={css.workspaceDiffState}>二进制文件无法显示文本 Diff。</div>}
          {diff !== undefined && !diff.binary && !hasTextPatch && (
            <div className={css.workspaceDiffState}>这个文件只有元数据变化，没有可显示的文本差异。</div>
          )}
          {hasTextPatch && diff !== undefined && <WorkspaceDiffHtml html={diff.html} />}
        </div>
      </div>
    </AnimatedModal>
  )
}

function WorkspaceDiffHtml({ html }: { html: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    root.innerHTML = html
    return () => { root.replaceChildren() }
  }, [html])
  return <div ref={hostRef} className={css.workspaceDiffVirtualizer} />
}

function useHarnessThemeType(): 'light' | 'dark' {
  const readTheme = (): 'light' | 'dark' => (
    typeof document !== 'undefined' && document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
  )
  const [themeType, setThemeType] = useState<'light' | 'dark'>(readTheme)
  useEffect(() => {
    const observer = new MutationObserver(() => { setThemeType(readTheme()) })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => { observer.disconnect() }
  }, [])
  return themeType
}

function workspaceChangeLabel(kind: WorkspaceGitChangeView['kind'] | undefined): string {
  if (kind === 'added') return '新增文件'
  if (kind === 'deleted') return '删除文件'
  if (kind === 'renamed') return '重命名'
  if (kind === 'copied') return '复制文件'
  if (kind === 'unmerged') return '冲突文件'
  if (kind === 'untracked') return '未跟踪文件'
  if (kind === 'type-changed') return '类型变化'
  return '修改文件'
}

function workspaceChangeCode(change: WorkspaceGitChangeView): string {
  if (change.kind === 'untracked') return 'U'
  if (change.kind === 'unmerged') return '!'
  if (change.kind === 'added') return 'A'
  if (change.kind === 'deleted') return 'D'
  if (change.kind === 'renamed') return 'R'
  if (change.kind === 'copied') return 'C'
  if (change.kind === 'type-changed') return 'T'
  return 'M'
}

function workspaceChangeTone(change: WorkspaceGitChangeView): string {
  if (change.kind === 'added' || change.kind === 'untracked') return css.workspaceChangeAdded!
  if (change.kind === 'deleted' || change.kind === 'unmerged') return css.workspaceChangeDeleted!
  if (change.kind === 'renamed' || change.kind === 'copied') return css.workspaceChangeRenamed!
  return css.workspaceChangeModified!
}

function WorkspaceTreeRow({
  teamId,
  entry,
  depth,
  refreshToken,
}: {
  teamId: string
  entry: WorkspaceEntryView
  depth: number
  refreshToken: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<WorkspaceEntryView[]>()
  useEffect(() => {
    if (!open || entry.kind !== 'directory') return
    let active = true
    void callAgentTeam('team.workspace.list', { teamId, path: entry.path })
      .then(next => { if (active) setChildren(next) })
      .catch(() => { if (active) setChildren([]) })
    return () => { active = false }
  }, [entry.kind, entry.path, open, refreshToken, teamId])

  function toggle(): void {
    if (entry.kind === 'directory') setOpen(current => !current)
  }

  return (
    <div>
      <button type="button" className={css.fileRow} style={{ paddingLeft: 8 + depth * 14 }} onClick={toggle}>
        <span className={`${css.fileDisclosure} ${open ? css.fileDisclosureOpen : ''}`}>
          {entry.kind === 'directory'
            ? <IconChevronRightOutline14 size={12} />
            : entry.kind === 'symlink'
              ? <IconRightUpOutline14 size={12} />
              : null}
        </span>
        <span className={css.fileKindIcon}>
          {entry.kind === 'directory'
            ? open ? <IconFolderOpen16 size={16} /> : <IconFolderClose16 size={16} />
            : <FileOutlineIcon size={16} />}
        </span>
        <span>{entry.name}</span>
      </button>
      {open && children?.map(child => (
        <WorkspaceTreeRow
          key={child.path}
          teamId={teamId}
          entry={child}
          depth={depth + 1}
          refreshToken={refreshToken}
        />
      ))}
    </div>
  )
}

function FileOutlineIcon({ size }: { size: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 1.75h4.5L12 5.25v9H4v-12.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8.5 1.75v3.5H12" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}
