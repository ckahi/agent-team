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
