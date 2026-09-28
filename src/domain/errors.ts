export type AgentTeamErrorCode =
  | 'ASSISTANT_NOT_FOUND'
  | 'ASSISTANT_IN_USE'
  | 'ASSISTANT_REVISION_CONFLICT'
  | 'TEAM_NOT_FOUND'
  | 'TEAM_INVALID_LEADER'
  | 'TEAM_REVISION_CONFLICT'
  | 'TEAM_NOT_ACTIVE'
  | 'TEAM_DELETING'
  | 'MEMBER_NOT_FOUND'
  | 'MEMBER_IS_LEADER'
  | 'MEMBER_BUSY'
  | 'WORKSPACE_UNAVAILABLE'
  | 'WORKSPACE_FILE_DELETE_FAILED'
  | 'WORKSPACE_GIT_UNAVAILABLE'
  | 'MODEL_REFERENCE_INVALID'
  | 'PRESET_REFERENCE_INVALID'
  | 'PERMISSION_PRESET_INVALID'
  | 'SKILL_REFERENCE_INVALID'
  | 'MCP_REFERENCE_INVALID'
  | 'PRESET_PROMPT_INCOMPATIBLE'
  | 'AGENT_HANDLE_OWNERSHIP_CONFLICT'
  | 'INTERACTION_INVALID'
  | 'INTERACTION_NOT_FOUND'
  | 'INTERACTION_NOT_PENDING'
  | 'SESSION_CREATE_FAILED'
  | 'TEAM_DELETE_FAILED'
  | 'INVALID_REQUEST'

export class AgentTeamError extends Error {
  constructor(
    readonly code: AgentTeamErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AgentTeamError'
  }
}

export function isAgentTeamError(error: unknown): error is AgentTeamError {
  return error instanceof AgentTeamError
}
