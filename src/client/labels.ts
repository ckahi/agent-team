export const TASK_STATE_LABELS: Readonly<Record<string, string>> = {
  pending: '待处理',
  assigned: '已分配',
  running: '进行中',
  blocked: '受阻',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
}

export function memberStatusLabel(status: string): string {
  const labels: Readonly<Record<string, string>> = {
    offline: '离线',
    starting: '启动中',
    idle: '空闲',
    running: '运行中',
    waiting_approval: '等待审批',
    error: '异常',
  }
  return labels[status] ?? status
}

export function taskStatusLabel(status: string): string {
  return TASK_STATE_LABELS[status] ?? status
}

export const TEAM_START_ERROR_HINTS: Readonly<Record<string, string>> = {
  PRESET_PROMPT_INCOMPATIBLE: '成员助手模板的 Agent Preset 替换了团队身份/名册提示段：请在助手库改用兼容预设，再点「重试启动」——重试将以助手库最新配置重新装配成员。',
}

const TEAM_START_ERROR_FALLBACK = '请检查 Workspace 是否可用、模型与网络配置后重试；重试将以助手库最新配置重新装配成员。'

export function teamStartErrorHint(code?: string): string {
  if (code === undefined) return TEAM_START_ERROR_FALLBACK
  return TEAM_START_ERROR_HINTS[code] ?? TEAM_START_ERROR_FALLBACK
}
