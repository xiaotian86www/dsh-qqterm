/**
 * 会话管理层类型定义
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ChatScope, ReplyTarget } from '../types.ts';
import type { EffortOption } from '../model/types.ts';

export type { EffortOption } from '../model/types.ts';

/** create / resume 传给宿主的 agentOptions（宿主 AgentOptions 的子集） */
export interface AgentOptionsLike {
  provider?: string;
  model?: string;
  /** 思考强度档位（宿主直接放进请求配置，缺省用 provider 默认值） */
  reasoningEffort?: string;
}

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
    /** 最近一次请求头：读会话实际的 provider/model/思考强度 */
    requestHeader?(): RequestHeaderLike | undefined;
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
  reason?: 'no-session' | 'busy' | 'failed';
  shadowed?: number;
  tokens?: number;
  message?: string;
}

/** preset 切换结果 */
export interface PresetSwitchOutcome {
  ok: boolean;
  reason?: 'unknown-preset' | 'broken' | 'failed';
  presetId?: string;
  /** true = 目标就是当前值，未写覆盖 */
  unchanged?: boolean;
  message?: string;
}

/** 模型切换结果 */
export interface ModelSwitchOutcome {
  provider: string;
  model: string;
  /** true = 目标就是当前模型，未写偏好、未 fork 会话 */
  unchanged?: boolean;
}

/** 宿主请求头的精简视图（读会话实际用的选择） */
export interface RequestHeaderLike {
  config?: {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    [key: string]: unknown;
  };
  /** 哪些控制项是 adapter 默认值（不是用户选择） */
  adapterDefaults?: {
    reasoningEffort?: boolean;
    [key: string]: unknown;
  };
}

/** 思考强度视图（/reasoning、/model、/status 共用；来源是宿主的 modelSelection 状态） */
export interface EffortView {
  /** 模型支持的档位；undefined = 当前模型不支持思考强度（或宿主没给元数据） */
  options?: EffortOption[];
  /** 当前生效档位（会话选择合法时是它，否则模型默认值） */
  current?: EffortOption;
  /** true = 显示的是模型默认值（会话与部署都没有显式设置） */
  defaulted: boolean;
}

/** 思考强度切换结果 */
export interface EffortSwitchOutcome {
  ok: boolean;
  reason?: 'unsupported' | 'unknown-effort' | 'no' | 'failed';
  /** 切换后生效的档位 id（恢复默认时为模型解析出的默认值） */
  effort?: string;
  /** true = 目标就是当前值，未改动会话 */
  unchanged?: boolean;
  /** reason=unknown-effort 时的可选项 */
  options?: EffortOption[];
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
    agentOptions?: AgentOptionsLike;
    setup?: AgentSetup;
  }): Promise<DshAgentHandle>;
  /** 创建全新 session */
  create(options: {
    sessionId: string;
    meta?: { cwd?: string; isSeeded?: boolean; parentSession?: string; agentPreset?: string };
    seed?: readonly unknown[];
    /** 继承前缀长度（seeded fork 用，对齐宿官方 commands.fork） */
    inheritedEventCount?: number;
    agentOptions?: AgentOptionsLike;
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

/**
 * permission-presets 服务接口（可选，部署中可能没有）
 *
 * 它是「一个预设 = 沙箱模式 + 审批策略」的执行入口；`names` 里除配置表之外，
 * 实验 Auto 审查集成在线时还会多一个 `auto`（选择它要求集成仍在准入期）。
 */
export interface PermissionPresetsLike {
  /** 可切换的预设名（配置表顺序 + 在线的 auto） */
  readonly names: readonly string[];
  /** 未来会话的默认预设（会话还没起来时按它展示当前值） */
  readonly defaultPreset: string;
  /** 某会话当前生效的预设 */
  current(session: unknown): string;
  /** 切换某会话的沙箱模式与审批策略（未知名字抛错） */
  set(session: unknown, name: string): void;
  /** 单条预设的展示信息（可选，缺失时按 id 展示） */
  optionOf?(name: string): { value: string; name?: string; description?: string };
}

/** 权限预设条目（/permission 展示用） */
export interface PermissionPresetEntry {
  id: string;
  name?: string;
  description?: string;
}

/** 权限预设切换结果 */
export interface PermissionSwitchOutcome {
  ok: boolean;
  reason?: 'unknown-preset' | 'no-session' | 'failed';
  preset?: string;
  /** true = 目标就是当前预设，未写会话 */
  unchanged?: boolean;
  message?: string;
}

/** preset 组合结果 */
export interface PresetComposition {
  agentPreset?: string;
  setup?: AgentSetup;
}

/**
 * 单个已获取会话记录。
 *
 * `handle` 只在 create/resume 时存在：`agents.get()` 借来的 live agent 没有
 * dispose capability，只能 cancel，插件卸载时丢引用即可。
 */
export interface SessionRecord {
  sessionKey: string;
  sessionId: string;
  agent: DshAgent;
  handle?: DshAgentHandle;
  replyTarget: ReplyTarget;
  scope: ChatScope;
  peerId: string;
  senderId: string;
  agentPreset?: string;
  /** 加入已获取集合的时间（运行期排序 / 排查用） */
  acquiredAt: number;
}

/** 会话状态信息（/status 用） */
export interface SessionStatus {
  active: boolean;
  sessionId?: string;
  provider?: string;
  model?: string;
  preset?: string;
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
  /** 是否已由 QQ 获取（运行期 records；决定输出/提问/审批是否回 QQ） */
  held: boolean;
  /** 已获取且 agent 正在生成（只在 held 时有意义） */
  running: boolean;
  /** 是否由 fork 派生（/model 换模型产生） */
  isSeeded: boolean;
  /** 是否在宿主的归档集里（归档 = 从列表/侧栏隐藏，日志仍在，可取消归档） */
  archived: boolean;
  /** 所属工作区标题（分组列举时填充；归档页用来区分同名会话） */
  workspace?: string;
  /** 所属工作区路径（默认持有列表按工作区分组用；未分组时为空） */
  workspacePath?: string;
  /** 所属工作区目录是否已不存在（分组标题行补 ⚠️ 用） */
  workspaceMissing?: boolean;
}

/** 切换会话结果 */
export interface SwitchSessionOutcome {
  ok: boolean;
  reason?: 'same' | 'not-found' | 'locked' | 'failed';
  message?: string;
  /** 目标会话原先已归档，本次恢复时顺带取消了归档 */
  unarchived?: boolean;
}

/**
 * 向指定会话发 prompt / 回答的结果。
 *
 * - sent：作为普通 prompt 交给目标会话；
 * - answered：目标在等答案，文本已作为答案提交；
 * - answer-mode：目标在等答案，已进入「下一条消息作为回答」模式；
 * - not-running：目标既不在已获取集合里，也没有 live agent；
 * - empty：没有待答问题，也没给文本；
 * - failed：followup / 答案解析失败。
 */
export type SendToOutcome =
  | { ok: true; kind: 'sent' | 'answered' | 'answer-mode'; sessionId: string }
  | {
    ok: false;
    reason: 'not-running' | 'empty' | 'forbidden' | 'failed';
    sessionId: string;
    message?: string;
  };

/**
 * 修改会话标题的结果。
 *
 * - no-session：当前聊天没有已获取的会话（或目标不在已获取集合里）；
 * - invalid：标题规范化后为空；
 * - not-live：会话已关闭，写不了日志；
 * - failed：宿主读写失败。
 */
export type RenameSessionOutcome =
  | { ok: true; title: string }
  | {
    ok: false;
    reason: 'no-session' | 'invalid' | 'not-live' | 'failed';
    message?: string;
  };

/** 归档 / 取消归档结果 */
export interface ArchiveSessionOutcome {
  ok: boolean;
  /** not-found = 会话不存在；busy = 有工作停不下来 */
  reason?: 'not-found' | 'busy' | 'failed';
  message?: string;
  /** 因指向该会话而被改写的 per-chat 映射数（归档当前会话时 > 0） */
  remapped?: number;
  /** 归档前是否已经处于归档状态（幂等命中，未产生写入） */
  alreadyArchived?: boolean;
}

/** 一个工作区的展示信息（`/new <工作区>` 按标题 / 路径匹配用） */
export interface WorkspaceInfo {
  /** 显示标题（宿主自动标题 = 目录名） */
  title: string;
  /** 规范化目录路径 */
  path: string;
  /** 目录是否已不存在 */
  missing: boolean;
}

/**
 * 切换工作区结果（按 `reason` 区分失败原因）
 *
 * - has-session：这个聊天已经有落盘的会话，cwd 改不动；
 * - missing：目标目录不存在 / 不是目录；
 * - ambiguous：标题匹配到多个工作区；
 * - not-found：既不是绝对路径，也没有同名工作区。
 */
export type ChangeWorkspaceOutcome =
  | {
    ok: true;
    /** 生效的工作区标题与绝对路径 */
    title: string;
    path: string;
    /** 宿主还没有这个工作区，会在下一条消息时创建 */
    isNew: boolean;
  }
  | { ok: false; reason: 'has-session'; /** 挡住本次修改的会话 id */ sessionId?: string }
  | { ok: false; reason: 'missing'; path: string }
  | { ok: false; reason: 'ambiguous'; matches: string[] }
  | { ok: false; reason: 'not-found'; arg: string };

/** 一个工作区分组（/sessions all 用） */
export interface WorkspaceGroup {
  /** 工作区 id；「未分组」固定为 `ungrouped` */
  id: string;
  /** 显示标题（宿主自动标题 = 目录名；未分组为「未分组」） */
  title: string;
  /** 规范化目录路径；未分组为空串 */
  path: string;
  /** 目录是否已不存在（未分组恒 false） */
  missing: boolean;
  /** 组内会话（先置顶、再按记账/创建时间顺序） */
  sessions: WorkspaceSession[];
}

