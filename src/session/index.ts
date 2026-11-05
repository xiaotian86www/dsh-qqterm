/**
 * 会话管理层
 *
 * 管理聊天会话 → dsh Agent 的映射和生命周期。
 */
export { SessionManager } from './session-manager.ts';
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
  ModelSwitchOutcome,
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
  SendToOutcome,
} from './types.ts';
