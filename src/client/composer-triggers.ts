export type ComposerTriggerKind = 'skill' | 'file'

export interface ComposerTrigger {
  kind: ComposerTriggerKind
  start: number
  end: number
  query: string
}

export interface ComposerTriggerReplacement {
  value: string
  cursor: number
}

export interface ComposerSkillSource {
  name: string
  description: string
  userInvocable: boolean
}

export interface OptionScrollGeometry {
  viewportTop: number
  viewportBottom: number
  optionTop: number
  optionBottom: number
  scrollTop: number
}

export function composerTriggerAt(value: string, rawCursor: number): ComposerTrigger | undefined {
  const cursor = Math.max(0, Math.min(rawCursor, value.length))
  let start = cursor
  while (start > 0 && !/\s/.test(value[start - 1] ?? '')) start -= 1
  const token = value.slice(start, cursor)
  if (token.length === 0) return undefined

  const marker = token[0]
  if (marker !== '/' && marker !== '@') return undefined
  if (marker === '@' && token.startsWith('@"')) return undefined

  const query = token.slice(1)
  if (marker === '/' && !/^[a-zA-Z0-9._-]*$/.test(query)) return undefined

  let end = cursor
  while (end < value.length && !/\s/.test(value[end] ?? '')) end += 1
  return {
    kind: marker === '/' ? 'skill' : 'file',
    start,
    end,
    query,
  }
}

export function replaceComposerTrigger(
  value: string,
  trigger: ComposerTrigger,
  replacement: string,
): ComposerTriggerReplacement {
  const suffix = trigger.end >= value.length || !/\s/.test(value[trigger.end] ?? '') ? ' ' : ''
  return {
    value: `${value.slice(0, trigger.start)}${replacement}${suffix}${value.slice(trigger.end)}`,
    cursor: trigger.start + replacement.length + suffix.length,
  }
}

export function matchingUserSkills<T extends ComposerSkillSource>(
  skills: readonly T[],
  selectedNames: ReadonlySet<string>,
  rawQuery: string,
): T[] {
  const query = rawQuery.toLocaleLowerCase()
  return skills
    .filter(skill => selectedNames.has(skill.name)
      && skill.userInvocable
      && skill.name.toLocaleLowerCase().includes(query))
    .sort((left, right) => Number(!left.name.toLocaleLowerCase().startsWith(query))
      - Number(!right.name.toLocaleLowerCase().startsWith(query))
      || left.name.localeCompare(right.name))
}

/** 工作台私有批量指令：压缩全体成员上下文（仅队长）。不注册进宿主命令表。 */
export const TEAM_COMPACT_COMMAND = 'team-compact'

export interface ComposerCommandSource {
  name: string
  description: string
}

/** 整行匹配 `/<name> ...` 的斜杠命令行（name 语法与宿主一致）。 */
export interface ParsedSlashLine {
  name: string
  args: string
}

export function parseSlashLine(line: string): ParsedSlashLine | undefined {
  const match = /^\/([a-z][a-z0-9._-]*)(?=$|[\t\n\r ])/u.exec(line)
  if (match === null) return undefined
  const name = match[1]
  if (name === undefined) return undefined
  return { name, args: line.slice(match[0].length) }
}

/** 命令候选过滤：前缀命中优先，其余按名称排序（与 Skill 候选同规则）。 */
export function matchingCommands<T extends ComposerCommandSource>(
  commands: readonly T[],
  rawQuery: string,
): T[] {
  const query = rawQuery.toLocaleLowerCase()
  return commands
    .filter(command => command.name.toLocaleLowerCase().includes(query))
    .sort((left, right) => Number(!left.name.toLocaleLowerCase().startsWith(query))
      - Number(!right.name.toLocaleLowerCase().startsWith(query))
      || left.name.localeCompare(right.name))
}

export function scrollTopForActiveOption(geometry: OptionScrollGeometry): number {
  if (geometry.optionTop < geometry.viewportTop) {
    return Math.max(0, geometry.scrollTop - (geometry.viewportTop - geometry.optionTop))
  }
  if (geometry.optionBottom > geometry.viewportBottom) {
    return geometry.scrollTop + geometry.optionBottom - geometry.viewportBottom
  }
  return geometry.scrollTop
}
