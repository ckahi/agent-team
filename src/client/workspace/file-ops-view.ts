import { AgentTeamError, isAgentTeamError } from '../../domain/errors.js'

/** 01c §2.2-3/4：markdown 按扩展名识别（渲染↔源码切换仅对 markdown 开放）。 */
export function isMarkdownPath(path: string): boolean {
  const name = path.split('/').pop() ?? ''
  const extension = name.slice(name.lastIndexOf('.'))
  return ['.md', '.markdown'].includes(extension.toLowerCase()) && name.includes('.')
}

export interface DeleteErrorFeedback {
  text: string
  retryable: boolean
}

/** 01c §5 反馈规范 10/11/12/15：错误码 → 弹窗内文案与重试可用性（校验类错误不给重试）。 */
export function deleteErrorFeedback(error: unknown): DeleteErrorFeedback {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('请求超时')) return { text: '操作超时，请重试', retryable: true }
  const code = isAgentTeamError(error) ? error.code : (error as { code?: string })?.code
  switch (code) {
    case 'WORKSPACE_FILE_DELETE_FAILED':
      return { text: `删除失败：${message}`, retryable: true }
    case 'INVALID_REQUEST':
      if (message.includes('is a directory')) return { text: '删除失败：目录不支持删除。', retryable: false }
      return { text: '删除失败：路径校验失败，已阻止该操作。', retryable: false }
    case 'WORKSPACE_UNAVAILABLE':
    case 'TEAM_NOT_FOUND':
      return { text: '删除失败：Workspace 不可用或已变更。', retryable: false }
    default:
      return { text: `删除失败：${message}`, retryable: true }
  }
}

/** 预览读取失败文案（01c §5-5：透传原因）。 */
export function readErrorText(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('请求超时')) return '读取失败：操作超时，请重试'
  // 客户端 api.ts 抛的是普通 Error + Object.assign(code)（P-QA-1），不能用 instanceof AgentTeamError 判定。
  const code = isAgentTeamError(error) ? error.code : (error as { code?: string })?.code
  if (code === 'INVALID_REQUEST' && error instanceof Error && error.message.includes('does not exist')) {
    return '该文件已被删除或移动，内容已不可用'
  }
  return `读取失败：${error instanceof Error ? error.message : String(error)}`
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${bytes} B`
}
