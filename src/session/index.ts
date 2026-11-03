/**
 * 会话管理层
 *
 * 管理 QQ peer → dsh Agent 的映射和生命周期。
 */
export { SessionManager } from './session-manager.ts';
export { IdleEvictor } from './idle-evictor.ts';
export type {
  AgentSetup,
  SessionEventLike,
  DshAgent,
  DshAgentHandle,
  DshAgentRegistry,
  AgentPresetsLike,
  PresetComposition,
  PresetEntry,
  PresetSwitchOutcome,
  PermissionPresetsLike,
  PermissionPresetEntry,
  PermissionSwitchOutcome,
  SessionRecord,
  SessionStatus,
  SessionContextUsage,
  TokenUsageStats,
  WorkspaceSession,
  WorkspaceGroup,
  WorkspaceInfo,
  ChangeWorkspaceOutcome,
  SwitchSessionOutcome,
  ArchiveSessionOutcome,
} from './types.ts';
