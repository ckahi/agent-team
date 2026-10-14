import Schema from '@deepseek-ai/schemastery'

export interface Config {
  maxRequestBytes: number
  sseHeartbeatMs: number
  runtimeConcurrency: number
  directMemberChatDefault: boolean
  assistantBuilderProvider: string
  assistantBuilderModel: string
  assistantBuilderAgentPresetId: string
  assistantBuilderPermissionPresetId: string
  /** Startup orphan cleanup mode for dissolved-team leftovers (01 Q2; grace-marked). */
  orphanCleanup: 'delete' | 'log'
}

export const Config: Schema<Config> = Schema.object({
  maxRequestBytes: Schema.number().min(1024).max(1024 * 1024).default(128 * 1024),
  sseHeartbeatMs: Schema.number().min(5_000).max(120_000).default(20_000),
  runtimeConcurrency: Schema.number().min(1).max(32).default(4),
  directMemberChatDefault: Schema.boolean().default(true),
  assistantBuilderProvider: Schema.string().default(''),
  assistantBuilderModel: Schema.string().default(''),
  assistantBuilderAgentPresetId: Schema.string().default(''),
  assistantBuilderPermissionPresetId: Schema.string().default(''),
  orphanCleanup: Schema.union(['delete', 'log']).default('delete'),
})
