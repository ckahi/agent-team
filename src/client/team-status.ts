export interface TeamExecutionView {
  members: Record<string, { lastRuntimeState: string }>
  tasks: Record<string, { status: string }>
}

export function isTeamExecuting(team: TeamExecutionView): boolean {
  return Object.values(team.members).some(member => (
    member.lastRuntimeState === 'running' || member.lastRuntimeState === 'waiting_approval'
  )) || Object.values(team.tasks).some(task => task.status === 'running')
}

export function canRetryTeamStart(state: string): boolean {
  return state === 'error'
}

/** team.start 改异步启动语义后，starting 是请求返回后的常态中间态，UI 需渲染「启动中」。 */
export function isTeamStarting(state: string): boolean {
  return state === 'starting'
}
