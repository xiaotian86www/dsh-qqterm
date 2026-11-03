/**
 * 会话管理层
 *
 * 管理 QQ peer → dsh Agent 的映射和生命周期。
 */
export { SessionManager } from './session-manager.ts';
export { IdleEvictor } from './idle-evictor.ts';
export { findSessionDirs, removeSessionDirs, isPathInside } from './session-store.ts';
export type { FoundSessionDir, RemoveSessionsResult } from './session-store.ts';
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
  SessionRecord,
  SessionStatus,
  TokenUsageStats,
  WorkspaceSession,
  SwitchSessionOutcome,
  DeleteSessionsOutcome,
  DeletedSessionInfo,
} from './types.ts';
