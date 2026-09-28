import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import {
  IconBranchOutline16,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconFolderClose16,
  IconFolderOpen16,
  IconRefreshOutline16,
  IconRightUpOutline14,
  MarkdownText,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  TeamView,
  WorkspaceEntryView,
  WorkspaceFileDeleteView,
  WorkspaceGitChangeView,
  WorkspaceGitDiffView,
  WorkspaceGitStatusView,
} from '../../transport/contracts.js'
import { callAgentTeam, subscribeAgentTeamWorkspace } from '../api.js'
import { AnimatedModal } from '../shared.js'
import { deleteErrorFeedback, formatBytes, isMarkdownPath, readErrorText } from './file-ops-view.js'
import css from './WorkspacePanel.module.css'

// MarkdownText 的 labels 必须是模块级常量：每次 render 换 identity 会丢弃其内部渲染缓存。
const MARKDOWN_LABELS: MarkdownLabels = {
  code: { copyLabel: '复制', copiedLabel: '已复制' },
  footnotes: '脚注',
}

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
  const [previewTarget, setPreviewTarget] = useState<string>()
  const [menuTarget, setMenuTarget] = useState<{ path: string; name: string; x: number; y: number }>()
  const [deleteTarget, setDeleteTarget] = useState<string>()
  const [deleteNotice, setDeleteNotice] = useState<{ tone: 'success' | 'error'; text: string }>()
  const fileLoadGeneration = useRef(0)
  const gitLoadGeneration = useRef(0)
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>()

  const showDeleteNotice = useCallback((tone: 'success' | 'error', text: string): void => {
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
    setDeleteNotice({ tone, text })
    noticeTimer.current = setTimeout(() => { setDeleteNotice(undefined) }, 3_500)
  }, [])

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

  const handleDeleteSettled = useCallback((view: WorkspaceFileDeleteView): void => {
    setDeleteTarget(undefined)
    // AC-10/01c §5-9：成功与"已不存在"都反馈并刷新；差异仅在文案与色调。
    if (view.deleted) showDeleteNotice('success', `已删除 ${view.path}`)
    else showDeleteNotice('error', '删除失败：文件已不存在，可能已被删除。列表已刷新。')
    void loadFiles()
  }, [loadFiles, showDeleteNotice])

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
                  onOpenPreview={setPreviewTarget}
                  onOpenMenu={(entry, x, y) => { setMenuTarget({ path: entry.path, name: entry.name, x, y }) }}
                />
              ))}
              {entries.length === 0 && !fileError && (
                <span className={css.fileEmpty}>{fileRefreshing ? '正在读取目录…' : '目录为空'}</span>
              )}
              {fileError && <span className={css.fileError}>{fileError}</span>}
              {deleteNotice && (
                <span
                  role="status"
                  className={`${css.workspaceNotice} ${deleteNotice.tone === 'success' ? css.workspaceNoticeSuccess! : css.workspaceNoticeError!}`}
                >
                  {deleteNotice.text}
                </span>
              )}
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
      <WorkspacePreviewDialog
        teamId={team.id}
        path={previewTarget}
        onClose={() => { setPreviewTarget(undefined) }}
      />
      {menuTarget && (
        <WorkspaceRowMenu
          target={menuTarget}
          onClose={() => { setMenuTarget(undefined) }}
          onDelete={() => {
            setDeleteTarget(menuTarget.path)
            setMenuTarget(undefined)
          }}
        />
      )}
      <WorkspaceDeleteDialog
        teamId={team.id}
        path={deleteTarget}
        onClose={() => { setDeleteTarget(undefined) }}
        onSettled={handleDeleteSettled}
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
  onOpenPreview,
  onOpenMenu,
}: {
  teamId: string
  entry: WorkspaceEntryView
  depth: number
  refreshToken: number
  onOpenPreview: (path: string) => void
  onOpenMenu: (entry: WorkspaceEntryView, x: number, y: number) => void
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

  function handleRowClick(): void {
    // P0-1/AC-5：目录行维持展开/折叠；文件与 symlink 打开只读预览。
    if (entry.kind === 'directory') setOpen(current => !current)
    else onOpenPreview(entry.path)
  }

  function handleContextMenu(event: ReactMouseEvent): void {
    // P0-3：目录行不弹菜单（结构性拦截，目录不可删）。
    if (entry.kind === 'directory') return
    event.preventDefault()
    onOpenMenu(entry, event.clientX, event.clientY)
  }

  return (
    <div>
      <button
        type="button"
        className={css.fileRow}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={handleRowClick}
        onContextMenu={handleContextMenu}
      >
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
          onOpenPreview={onOpenPreview}
          onOpenMenu={onOpenMenu}
        />
      ))}
    </div>
  )
}

type PreviewState =
  | { stage: 'loading' }
  | { stage: 'text'; content: string }
  | { stage: 'markdown'; view: 'render' | 'source'; content: string }
  | { stage: 'oversize'; bytes: number }
  | { stage: 'binary' }
  | { stage: 'error'; message: string; retryable: boolean }

function WorkspacePreviewDialog({
  teamId,
  path,
  onClose,
}: {
  teamId: string
  path: string | undefined
  onClose: () => void
}): JSX.Element {
  const [state, setState] = useState<PreviewState>({ stage: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (path === undefined) return
    let active = true
    setState({ stage: 'loading' })
    void callAgentTeam('team.workspace.read', { teamId, path }).then(view => {
      if (!active) return
      if (view.oversize) {
        setState({ stage: 'oversize', bytes: view.bytes })
      } else if (view.kind === 'binary') {
        setState({ stage: 'binary' })
      } else if (isMarkdownPath(path)) {
        setState({ stage: 'markdown', view: 'render', content: view.content ?? '' })
      } else {
        setState({ stage: 'text', content: view.content ?? '' })
      }
    }).catch(cause => {
      if (!active) return
      const invalid = (cause as { code?: string })?.code === 'INVALID_REQUEST'
      // "文件已不存在"类内容失效无重试必要（01c §6-5）；其余失败可重试。
      setState({ stage: 'error', message: readErrorText(cause), retryable: !invalid })
    })
    return () => { active = false }
  }, [attempt, path, teamId])

  const previewingMarkdown = state.stage === 'markdown'
  return (
    <AnimatedModal
      open={path !== undefined}
      onClose={onClose}
      title={path ?? '文件预览'}
      className={css.workspaceDiffDialog ?? ''}
      headless
    >
      <div className={css.workspaceDiffShell}>
        <header className={css.workspaceDiffHeader}>
          <div className={css.workspaceDiffHeading}>
            <div className={css.workspaceDiffTitleRow}>
              <h2>{path ?? '文件预览'}</h2>
              <span>只读预览</span>
            </div>
          </div>
          <div className={css.workspaceDiffHeaderActions}>
            {previewingMarkdown && state.stage === 'markdown' && (
              <div className={css.workspaceDiffLayout} role="group" aria-label="预览视图">
                <button
                  type="button"
                  className={state.view === 'render' ? css.workspaceDiffLayoutActive : ''}
                  onClick={() => { setState({ ...state, view: 'render' }) }}
                >渲染</button>
                <button
                  type="button"
                  className={state.view === 'source' ? css.workspaceDiffLayoutActive : ''}
                  onClick={() => { setState({ ...state, view: 'source' }) }}
                >源码</button>
              </div>
            )}
            <button type="button" className={css.workspaceDiffClose} aria-label="关闭预览" onClick={onClose}>
              <IconCloseOutline16 size={16} />
            </button>
          </div>
        </header>
        <div className={css.workspaceDiffBody}>
          {state.stage === 'loading' && <div className={css.workspaceDiffState}>正在读取文件…</div>}
          {state.stage === 'error' && (
            <div className={css.workspacePreviewErrorState}>
              <div role="alert" className={css.workspaceDiffError}>{state.message}</div>
              {state.retryable && (
                <button type="button" className={css.workspacePreviewRetry} onClick={() => { setAttempt(current => current + 1) }}>
                  重试
                </button>
              )}
            </div>
          )}
          {state.stage === 'binary' && (
            <div className={css.workspaceDiffState}>该文件为二进制/非文本文件，不支持预览。</div>
          )}
          {state.stage === 'oversize' && (
            <div className={`${css.workspaceDiffState} ${css.workspacePreviewWarning!}`}>
              文件过大（{formatBytes(state.bytes)}），超过预览上限 1 MB。请用系统编辑器打开该文件。
            </div>
          )}
          {state.stage === 'text' && <pre className={css.workspacePreviewText}>{state.content === '' ? '（空文件）' : state.content}</pre>}
          {state.stage === 'markdown' && state.view === 'render' && (
            <div className={css.workspacePreviewMarkdown}>
              {state.content === '' ? '（空文件）' : <MarkdownText text={state.content} labels={MARKDOWN_LABELS} />}
            </div>
          )}
          {state.stage === 'markdown' && state.view === 'source' && (
            <pre className={css.workspacePreviewText}>{state.content === '' ? '（空文件）' : state.content}</pre>
          )}
        </div>
      </div>
    </AnimatedModal>
  )
}

function WorkspaceRowMenu({
  target,
  onClose,
  onDelete,
}: {
  target: { path: string; name: string; x: number; y: number }
  onClose: () => void
  onDelete: () => void
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: target.x, top: target.y })
  // P-QA-3：fixed 定位按实际尺寸做视口钳位，右/下边缘不溢出，删除项始终可点。
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (menu === null) return
    const { offsetWidth, offsetHeight } = menu
    const margin = 8
    setPosition({
      left: Math.max(margin, Math.min(target.x, window.innerWidth - offsetWidth - margin)),
      top: Math.max(margin, Math.min(target.y, window.innerHeight - offsetHeight - margin)),
    })
  }, [target.x, target.y])
  useEffect(() => {
    function handlePointerDown(event: MouseEvent): void {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) onClose()
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])
  return (
    <div ref={menuRef} className={css.workspaceRowMenu} style={{ left: position.left, top: position.top }} role="menu" aria-label={`文件操作：${target.path}`}>
      <button type="button" role="menuitem" className={css.workspaceRowMenuItem} onClick={onDelete}>
        删除
      </button>
    </div>
  )
}

function WorkspaceDeleteDialog({
  teamId,
  path,
  onClose,
  onSettled,
}: {
  teamId: string
  path: string | undefined
  onClose: () => void
  onSettled: (view: WorkspaceFileDeleteView) => void
}): JSX.Element {
  const [stage, setStage] = useState<'confirm' | 'deleting' | 'error'>('confirm')
  const [feedback, setFeedback] = useState<{ text: string; retryable: boolean }>()

  // 每次打开重置为待确认态。
  useEffect(() => {
    if (path !== undefined) {
      setStage('confirm')
      setFeedback(undefined)
    }
  }, [path])

  async function confirmDelete(): Promise<void> {
    if (path === undefined || stage === 'deleting') return
    // AC-18：删除请求不可取消，deleting 态禁用全部关闭路径（确认/取消/Esc 均禁用或被 onClose 门禁拦截）。
    setStage('deleting')
    setFeedback(undefined)
    try {
      const view = await callAgentTeam('team.workspace.delete', { teamId, path })
      onSettled(view)
    } catch (cause) {
      setFeedback(deleteErrorFeedback(cause))
      setStage('error')
    }
  }

  // 01c §2.4-4 定稿：失败弹窗不关，错误显示在弹窗内；校验类错误不给重试。
  const requestInFlight = stage === 'deleting'
  return (
    <AnimatedModal
      open={path !== undefined}
      onClose={() => { if (!requestInFlight) onClose() }}
      title="删除确认"
      className={css.workspaceDeleteDialog ?? ''}
      headless
    >
      <div className={css.workspaceDeleteShell}>
        <p className={css.workspaceDeleteQuestion}>确定要删除以下文件吗？</p>
        <p className={css.workspaceDeletePath}>{path}</p>
        <p className={css.workspaceDeleteWarning} role="note">⚠ 删除后不可恢复，此操作没有回收站</p>
        {stage === 'error' && feedback && (
          <div role="alert" className={css.workspaceDeleteError}>{feedback.text}</div>
        )}
        <div className={css.workspaceDeleteActions}>
          <button
            type="button"
            className={css.workspaceDeleteCancel}
            disabled={requestInFlight}
            onClick={onClose}
          >取消</button>
          {stage === 'error' && feedback?.retryable && (
            <button type="button" className={css.workspaceDeleteCancel} onClick={() => { void confirmDelete() }}>
              重试
            </button>
          )}
          <button
            type="button"
            className={css.workspaceDeleteDanger}
            disabled={requestInFlight}
            onClick={() => { void confirmDelete() }}
          >
            {requestInFlight ? '删除中…' : '删除'}
          </button>
        </div>
      </div>
    </AnimatedModal>
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
