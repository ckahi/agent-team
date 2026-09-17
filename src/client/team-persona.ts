import { memberTemplateDrift } from '../domain/types.js'
import type { AssistantView, TeamView } from '../transport/contracts.js'

/** 确认弹窗摘要计数：逐成员判定与最新助手模板的漂移（不含移除中成员与模板已删除成员）。 */
export function countDriftedMembers(team: TeamView, assistants: AssistantView[]): number {
  const byId = new Map(assistants.map(assistant => [assistant.id, assistant]))
  return Object.values(team.members).filter(member => {
    if (member.desiredState === 'removing') return false
    const assistant = byId.get(member.assistantId)
    return assistant !== undefined && memberTemplateDrift(member, assistant)
  }).length
}
