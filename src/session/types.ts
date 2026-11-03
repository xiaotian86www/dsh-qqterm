/**
 * 会话管理层类型定义
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ChatScope, ReplyTarget } from '../types.ts';

/** AgentSetup hook 类型 */
export type AgentSetup = (agentCtx: Context) => Promise<void> | void;

/**
 * dsh 事件上的 usage（真实形状）
 *
 * 取自 session.v4 日志的 assistant/message 事件：
 *   data.usage = { inputTokens, outputTokens, totalTokens, cacheReadTokens }
 * totalTokens 是上下文总量，不等于 input + output，展示时不要拿它当合计。
 */
export interface SessionUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

/** dsh SessionEvent 简化类型（用于统计 token 用量 / 导出） */
export interface SessionEventLike {
  type: string;
  seq?: number;
  /** 事件载荷（usage / message 等真实字段都在这里） */
  data?: {
    usage?: SessionUsageLike;
    message?: {
      content?: Array<{ type: string; text?: string }>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  /** 兼容形状：部分事件/旧版本把 usage 放在顶层（扁平命名） */
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  message?: {
    content?: Array<{ type: string; text?: string }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** dsh Agent 简化接口 */
export interface DshAgent {
  readonly id: string;
  readonly ctx: Context;
  /** 当前生命周期状态（用于判断是否正在生成） */
  readonly status: 'idle' | 'running';
  /** 底层 session（fork 时作为 source；snapshotEvents 用于统计/导出） */
  readonly session: {
    readonly id: string;
    snapshotEvents(): readonly SessionEventLike[];
  };
  cancel(cause: { kind: string }): void;
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
  /** 运行一个非 turn 维护任务（compact 等需要 idle 时串行执行的操作） */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

/** compactNow 返回结果的精简视图（只取展示所需字段） */
export interface CompactionResultLike {
  shadowedSeqs: readonly number[];
  shadowedTokenCount: number;
}

/** ctx.compaction 服务的最小接口（compactNow 依赖，可选注入） */
export interface CompactionServiceLike {
  compactNow(
    agent: unknown,
    signal: AbortSignal,
    sourceCommandId?: string,
  ): Promise<CompactionResultLike | null>;
}

/** compact 操作结果 */
export interface CompactOutcome {
  ok: boolean;
  reason?: 'no-session' | 'busy' | 'unavailable' | 'failed';
  shadowed?: number;
  tokens?: number;
  message?: string;
}

/** preset 切换结果 */
export interface PresetSwitchOutcome {
  ok: boolean;
  reason?: 'unavailable' | 'unknown-preset' | 'broken' | 'failed';
  presetId?: string;
  message?: string;
}

export interface DshAgentHandle {
  agent: DshAgent;
  dispose(): Promise<void>;
}

export interface DshAgentRegistry {
  /** 获取进程内已存活的 agent */
  get(sessionId: string): DshAgent | undefined;
  /** 从持久化存储恢复 session */
  resume(options: {
    resumeSessionId: string;
    agentOptions?: { provider?: string; model?: string };
    setup?: AgentSetup;
  }): Promise<DshAgentHandle>;
  /** 创建全新 session */
  create(options: {
    sessionId: string;
    meta?: { cwd?: string; isSeeded?: boolean; parentSession?: string; agentPreset?: string };
    seed?: readonly unknown[];
    /** 继承前缀长度（seeded fork 用，对齐宿官方 commands.fork） */
    inheritedEventCount?: number;
    agentOptions?: { provider?: string; model?: string };
    setup?: AgentSetup;
  }): Promise<DshAgentHandle>;
}

/** agent-presets 服务接口（可选，部署中可能没有） */
export interface AgentPresetsLike {
  readonly defaultId: string;
  resolve(id?: string): Promise<{ id: string; broken?: string }>;
  mount(agentCtx: Context, id?: string): Promise<unknown>;
  /** 列出所有可用 preset */
  list(): Promise<Array<{ id: string; name?: string; description?: string; broken?: string }>>;
}

/** 可用 preset 条目（/preset 命令展示用） */
export interface PresetEntry {
  id: string;
  name?: string;
  description?: string;
}

/** preset 组合结果 */
export interface PresetComposition {
  agentPreset?: string;
  setup?: AgentSetup;
}

/** 单个会话记录 */
export interface SessionRecord {
  sessionKey: string;
  sessionId: string;
  agent: DshAgent;
  handle: DshAgentHandle;
  replyTarget: ReplyTarget;
  scope: ChatScope;
  peerId: string;
  senderId: string;
  lastActivity: number;
  agentPreset?: string;
}

/** 会话状态信息（/status 用） */
export interface SessionStatus {
  active: boolean;
  sessionId?: string;
  provider?: string;
  model?: string;
  preset?: string;
  lastActivity?: number;
  messageCount?: number;
}

/** token 用量统计（/cost 用） */
export interface TokenUsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * 上下文占用（/cost 用）
 *
 * used 取自最后一条 assistant/message 的 data.usage.totalTokens（= 该轮请求的上下文大小）；
 * window 取自最后一条 request/context 的 data.contextWindow。
 */
export interface SessionContextUsage {
  used?: number;
  window?: number;
  provider?: string;
  model?: string;
}

/** 宿主 sessionId 类型再导出（批量标题查询用） */
export type { SessionId } from '@deepseek-ai/dsh-session';


/**
 * 会话列表条目（/sessions 用）
 *
 * 来源是宿主 `sessionQuery.listSessions()` / `sessionPersistence.list()`，
 * 按 agent 工作目录过滤后与 Web 侧栏看到的会话一致。
 */
export interface WorkspaceSession {
  /** 会话 id（session-<uuid>） */
  id: string;
  /** 日志里的最新标题（可能取不到） */
  title?: string;
  /** 创建时间（Unix epoch ms） */
  createdAt: number;
  /** 是否为本 chat 当前绑定的会话 */
  current: boolean;
  /** 是否正被进程内 agent 占用 */
  live: boolean;
  /** 是否由 fork 派生（/model 换模型产生） */
  isSeeded: boolean;
}

/** 切换会话结果 */
export interface SwitchSessionOutcome {
  ok: boolean;
  reason?: 'same' | 'not-found' | 'in-use' | 'failed';
  message?: string;
}

/** 删除会话的单个结果 */
export interface DeletedSessionInfo {
  id: string;
  path: string;
  bytes: number;
}

/** 删除会话结果 */
export interface DeleteSessionsOutcome {
  ok: boolean;
  reason?: 'no-root' | 'not-found' | 'failed';
  message?: string;
  /** 已删除的会话目录 */
  removed: DeletedSessionInfo[];
  /** 删除失败（多为宿主仍占用文件） */
  failed: Array<{ id: string; path?: string; message: string }>;
  /** 磁盘上没有目录的 id（从未落盘 / 已被删） */
  missing: string[];
  /** 被连带删除的子 agent 会话数 */
  cascaded: number;
  /** 因指向被删会话而被改写的 per-peer 映射数 */
  remapped: number;
}

