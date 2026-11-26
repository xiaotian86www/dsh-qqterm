/**
 * 会话管理层
 *
 * 管理聊天会话 → dsh Agent 的映射和生命周期。
 */
export { SessionManager } from './session-manager.ts';
export { WorktreeError, worktreeErrorText, worktreeNoticeWithWorkspace } from './worktree.ts';
export type {
  AgentSetup,
  AgentOptionsLike,
  SessionEventLike,
  DshAgent,
  DshAgentHandle,
  DshAgentRegistry,
  AgentPresetsLike,
  PresetComposition,
  PresetEntry,
  PresetSwitchOutcome,
  ModelSwitchOutcome,
  SettingsDescriptorLike,
  EffortOption,
  EffortView,
  EffortSwitchOutcome,
  PermissionPresetsLike,
  PermissionPresetEntry,
  PermissionSwitchOutcome,
  SessionRecord,
  SessionStatus,
  SessionContextUsage,
  SessionTurnProgress,
  TokenUsageStats,
  WorkspaceSession,
  WorkspaceGroup,
  WorkspaceInfo,
  ChangeWorkspaceOutcome,
  SwitchSessionOutcome,
  RenameSessionOutcome,
  ArchiveSessionOutcome,
  SendToOutcome,
  PromptPlacement,
  PromptSubmission,
  SteerQueuedOutcome,
  RemoveQueuedOutcome,
  RetryPromptOutcome,
  WorktreeInfo,
} from './types.ts';
