/**
 * 宿主 API 适配层 — 收口宿主服务的读取与降级。
 *
 * 调用方只依赖本模块的稳定签名，不直接假设宿主形态。
 */
import type { Context } from '@deepseek-ai/cordis';
import { basename } from 'node:path';
import { optionalService, errorMessage } from '../shared/utils.ts';

/** 日志最小接口 */
export interface AdapterLogger {
  info(msg: string): void;
  warn(msg: string): void;
  debug?(msg: string): void;
}

export interface HostAdapter {
  /** 会话事件读取（宿主 snapshotEvents） */
  sessionEvents(session: { snapshotEvents: () => readonly unknown[] }): readonly unknown[];
  /** 会话 header 读取（取 agentPreset 等）；会话不存在、服务缺失或读取失败返回 undefined */
  sessionHeader(sessionId: string): Promise<SessionHeaderLike | undefined>;
  /**
   * 会话是否存在于持久化层。
   *
   * 后端故障时抛错（求证失败 ≠ 不存在）：那正是重建已存在会话、撞出重复 id 的根因。
   */
  sessionExists(sessionId: string): Promise<boolean>;
  /**
   * 将会话挂载到其 cwd 对应的工作区（侧边栏可见性）。
   *
   * 全部 fail-soft：create/attach 失败或宿主接口演进（无 attachSession）→ warn，绝不抛出。
   * `attachSession` 幂等，创建与恢复路径都可安全调用；升级后老会话自动补挂。
   *
   * 不传标题：工作区显示名交给宿主按目录名生成（一般规律，不再硬编码 'QQBot'）。
   */
  attachSessionToWorkspace(sessionId: string, cwd: string): Promise<void>;
  /**
   * 列出宿主持久化的全部会话；`updatedAt` / `blank` 取自
   * `sessionController.list()`（Web 侧栏同一份摘要）。
   * 后端故障时抛错，由调用方决定如何降级展示。
   *
   * 注意：宿主列表**不过滤归档、不按 Web 的可见性裁剪**（live / cwd / blank
   * 的取舍由调用方决定），调用方要自己按 {@link archivedSessionIds} 区分。
   */
  listSessions(): Promise<HostSessionInfo[]>;
  /**
   * 批量读取会话标题（日志里的 `session/title` 最新值）。
   *
   * 标题是展示性数据：任何失败都按会话隔离并返回已有结果，绝不抛错。
   */
  sessionTitles(ids: readonly string[]): Promise<Map<string, string>>;
  /**
   * 修改一个**仍然存活**的会话的标题（`sessionTitle.rename`）。
   *
   * 宿主把用户标题作为显式修订写进 `session/title` 事件，并固定它：之后自动
   * 标题不再覆盖。冷会话（没有 live agent）没有可写的 session，方法返回
   * `not-live`；宿主标题服务异常时返回 `failed`，绝不抛出。
   */
  renameSession(session: unknown, title: string): SessionRenameOutcome;
  /**
   * 归档一个会话（`workspaceRegistry.archiveSession`）。
   *
   * 归档只把会话加进 registry 的全局归档集：Web 侧栏隐藏、聊天不再往它上面
   * 生成，磁盘日志原样保留，可随时取消归档。调用带 `stopActivity`，让宿主先
   * 停掉该会话上仍在跑的工作（否则活跃会话会被宿主以 session-active 拒绝）。
   */
  archiveSession(sessionId: string): Promise<SessionArchiveOutcome>;
  /** 取消归档（幂等：未归档的 id 也按成功处理）。 */
  unarchiveSession(sessionId: string): Promise<SessionArchiveOutcome>;
  /**
   * 当前归档集（registry 里没有归档记录时为空集）。
   *
   * registry 的状态在内存里，同步读取。
   */
  archivedSessionIds(): ReadonlySet<string>;
  /** 当前置顶集（最近置顶在前）；宿主无此能力时为空集 */
  pinnedSessionIds(): ReadonlySet<string>;
  /**
   * 宿主的工作区列表（顺序即侧边栏顺序）。
   *
   * 只读快照；部署里没有 workspaceRegistry 时返回空数组。`sessionIds` 是该
   * 工作区的会话记账。
   */
  workspaceList(): WorkspaceInfo[];
  /**
   * 部署里是否有 workspaceRegistry。
   *
   * 没有这个服务时列表仍按目录路径分组，但没有工作区名、没有置顶 / 归档，
   * 归档子命令按未知子命令处理，也不能按名字新建会话。
   */
  supportsWorkspaceRegistry(): boolean;
  /**
   * 默认工作区目录：宿主的「默认项目」（首次使用时建在 Documents 下，
   * 自动标题为 `default-workspace`）。
   *
   * 找不到默认工作区（未初始化/被改名）时回退到 `workingDirectory.defaultDirectory`
   * （dsh 启动目录）；都没有时返回 undefined，由调用方兜底。
   */
  defaultWorkspacePath(): string | undefined;
  /**
   * 会话当前生效的工作目录。
   *
   * 优先宿主 `workingDirectory.get(session)`（含运行期 cd 变化），回退会话
   * header 的 `cwd`；都拿不到返回 undefined。
   */
  sessionDirectory(session: unknown): string | undefined;
  /**
   * 工作树服务（只有 web / Desktop 的 forge 组合包提供）。
   *
   * 每次现读、不缓存：组合包的服务注册顺序不保证在插件 apply 之前。
   */
  worktrees(): WorktreeServiceLike | undefined;
  /**
   * 目录所在仓库的 HEAD（当前分支名 + 提交）。
   *
   * 建工作树的基点用它：宿主默认取 repository root 的 HEAD，在树里再开会话会
   * 从主检出而不是当前分支拉出。只跑只读的 git 命令，不套沙箱写策略；服务
   * 缺失、超时、非仓库都返回 undefined，调用方据此判定建树失败（不降级）。
   */
  headOf(directory: string): Promise<RepoHead | undefined>;
  /**
   * 部署默认的沙箱模式。
   *
   * 新会话还没有 `sandbox/mode` 事件，不带 session 解析得到的就是它的初始策略；
   * 服务缺失或解析失败返回 undefined。
   */
  sandboxMode(): string | undefined;
  /**
   * 部署里是否有可用的排队消息插话入口（sessionController.updateQueue）。
   *
   * 只有 web 组合包挂载该服务；缺失时 /steer 不注册、排队回执不带插话链接。
   */
  supportsQueueSteer(): boolean;
  /** 把一条仍在 next-turn 的消息改成插话；错误码已归一，绝不抛出 */
  steerQueuedMessage(sessionId: string, itemId: string): Promise<QueueSteerOutcome>;
  /** 探测结果摘要（启动契约检查用） */
  readonly capabilities: string[];
}

/** 工作区快照（供 /sessions 分组展示） */
export interface WorkspaceInfo {
  id: string;
  title: string;
  path: string;
  /** 该工作区的会话记账（顺序即侧边栏顺序） */
  sessionIds: readonly string[];
}

/** 排队消息改成插话的结果（只暴露命令层要区分的三种） */
export type QueueSteerOutcome =
  | { ok: true }
  | { ok: false; reason: 'not-found' | 'steer-unavailable' | 'failed'; message?: string };

/** 归档 / 取消归档的结果（宿主错误已归一成可展示的文案） */
export type SessionArchiveOutcome =
  | { ok: true }
  | {
    ok: false;
    /** not-found = 会话不存在；busy = 有工作未停；unavailable = 部署没有工作区服务 */
    reason: 'not-found' | 'busy' | 'failed' | 'unavailable';
    message?: string;
  };

/** 修改会话标题的结果（宿主错误已归一成可展示的文案） */
export type SessionRenameOutcome =
  | { ok: true; title: string }
  | {
    ok: false;
    /** invalid = 标题被规范化成空；not-live = 会话已关闭 */
    reason: 'invalid' | 'not-live' | 'failed';
    message?: string;
  };

/** 宿主侧会话摘要（字段对齐 SessionHeader，供列表/删除使用） */
export interface HostSessionInfo {
  /** 会话 id */
  readonly id: string;
  /** 创建时间（Unix epoch ms；缺失按 0） */
  readonly createdAt: number;
  /**
   * 最近人类消息时间（Unix epoch ms）：宿主会话摘要的 `updatedAt`，
   * 即 `max(createdAt, 投影 sessionListMetadata 的 lastPromptAt)`；
   * 宿主不提供时回退成 `createdAt`。列表按它倒序排（与 Web 侧栏一致）。
   */
  readonly updatedAt: number;
  /** 会话创建时的绝对工作目录 */
  readonly cwd?: string;
  /** 派生来源会话（fork / subagent） */
  readonly parentSession?: string;
  /** 是否含 fork 继承前缀 */
  readonly isSeeded: boolean;
  /** 子 agent 会话标记 */
  readonly origin?: 'subagent';
  /** 是否正被宿主进程内的 agent 占用 */
  readonly live: boolean;
  /**
   * 是否还是空白会话（宿主 `sessionListMetadata.blank`：还没有过人类轮次）。
   * Web 侧栏只显示当前打开的那个 blank 会话。
   */
  readonly blank: boolean;
}

/** 会话 header 的最小结构（只读插件关心的字段；`agentPreset` 在 header 顶层） */
export interface SessionHeaderLike {
  agentPreset?: string;
}

/** 工作区实体最小契约（对齐 dsh-workspace Workspace） */
export interface WorkspaceLike {
  /** 稳定记录 id（uuid） */
  readonly id?: string;
  readonly path?: string;
  /** 显示标题（宿主的自动标题 = 目录名） */
  readonly title?: string;
  /** 该工作区的会话记账（顺序即侧边栏顺序） */
  readonly sessionIds?: readonly string[];
  attachSession(sessionId: string): Promise<void>;
}

/** workspaceRegistry 服务最小契约（对齐 dsh-workspace WorkspaceRegistry） */
export interface WorkspaceRegistryLike {
  /** 获取目录对应的现有工作区；不存在时创建（幂等；路径须已存在且为目录） */
  create(path: string, title?: string): Promise<WorkspaceLike>;
  /** 工作区列表（按侧边栏顺序） */
  list(): readonly WorkspaceLike[];
  /** registry 全局归档集（只读） */
  readonly archivedSessionIds: readonly string[];
  /** registry 全局置顶集（最近置顶在前） */
  readonly pinnedSessionIds: readonly string[];
  /** 归档一个会话；`stopActivity` 为真时先让 providers 停掉该会话的工作 */
  archiveSession(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>;
  /** 取消归档（幂等） */
  unarchiveSession(sessionId: string): Promise<void>;
}

/** 目录所在仓库的 HEAD（分支可能没有：detached HEAD） */
export interface RepoHead {
  readonly commit: string;
  readonly branch?: string;
}

/** 宿主建出来的检出（对齐 dsh-experimental-worktree 的 CreatedWorktree） */
export interface CreatedWorktreeLike {
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly repositoryRoot: string;
}

/**
 * worktrees 服务最小契约（对齐 dsh-experimental-worktree WorktreeService）。
 *
 * 只有 web / Desktop 的 forge 组合包提供；插件只用 create 与 restore，删除归
 * 宿主的归档清理（服务没有公共 remove）。
 */
export interface WorktreeServiceLike {
  create(
    agent: unknown,
    request?: { name?: string; from?: string },
    signal?: AbortSignal,
    onPhase?: (phase: 'prepare' | 'checkout') => void,
  ): Promise<CreatedWorktreeLike>;
  restore(
    agent: unknown,
    request: CreatedWorktreeLike,
    signal?: AbortSignal,
  ): Promise<{ path: string; branchRecreated: boolean }>;
}

/** sandboxPolicy 服务最小契约：只读当前沙箱模式（`/status` 与只读判定用，不在这里发起执行） */
interface SandboxPolicyLike {
  resolve(): { mode?: string } | undefined;
}

/** subprocess 服务最小契约（只跑只读命令：解析可执行文件 + 收集 stdout） */
interface SubprocessLike {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>;
  spawn(spec: {
    argv: readonly string[];
    cwd: string;
    env?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
    graceMs: number;
    stdio: {
      stdin: 'ignore';
      stdout: { maxBytes: number };
      stderr: { maxBytes: number };
    };
  }): SubprocessHandleLike;
}

interface SubprocessHandleLike {
  readonly collected: { readonly stdout: { readFrom(fromByte: number): { text: string } } };
  readonly done: Promise<{ exitCode: number | null }>;
  terminate(): void;
  waitForExit(): Promise<unknown>;
}

/** 读 HEAD 的超时：本机 git 毫秒级返回，挂住说明目录不可用 */
const HEAD_TIMEOUT_MS = 5_000;

/**
 * 在 `cwd` 里跑一条只读 git 命令，返回裁剪后的 stdout。
 *
 * 不套沙箱包装：策略约束的是写，rev-parse / symbolic-ref 只读。失败、非零退出
 * 或输出为空都返回 undefined，由调用方降级。
 */
async function gitStdout(
  subprocess: SubprocessLike,
  git: string,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string | undefined> {
  const child = subprocess.spawn({
    argv: [git, '-C', cwd, ...args],
    cwd,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    signal,
    graceMs: 1_000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4_096 }, stderr: { maxBytes: 4_096 } },
  });
  try {
    const { exitCode } = await child.done;
    if (exitCode !== 0) return undefined;
    const text = child.collected.stdout.readFrom(0).text.trim();
    return text === '' ? undefined : text;
  } finally {
    child.terminate();
    await child.waitForExit().catch(() => undefined);
  }
}

/**
 * 宿主「默认工作区」的自动标题（= 首次使用时创建的目录名，见
 * dsh-api-workspace-controller 的 DEFAULT_WORKSPACE_DIRECTORY）。
 * 用户改过名就匹配不到，此时退回启动目录。
 */
const DEFAULT_WORKSPACE_TITLE = 'default-workspace';

/**
 * 持久化服务的最小只读契约。
 *
 * 只用 `stat`：它不读事件日志、不取写所有权，且**会话不存在时返回 `undefined`
 * 而非抛错**，正好是存在性判定需要的语义。不用 `open`（会争写所有权）、不用
 * `list`（全量扫描）。
 */
interface SessionPersistenceLike {
  stat(id: string): Promise<{ header?: SessionHeaderLike } | undefined>;
}

/** ctx.sessionQuery 的最小契约（只要列表与批量标题） */
interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<readonly unknown[]>;
  readTitleSnapshots(ids: readonly string[]): Promise<readonly unknown[]>;
}

/** ctx.sessionTitle 的最小写契约（只要 rename；读标题走 sessionQuery） */
interface SessionTitleLike {
  rename(session: unknown, title: string): { title?: unknown } | undefined;
}

/**
 * ctx.sessionController 的最小读契约（只用到 list）。
 *
 * 可选：只有 web 组合包挂载该服务，不在 qqterm 的 inject 里。`list()` 返回
 * Web 侧栏同一份会话摘要：`updatedAt = max(createdAt, lastPromptAt)`，其中
 * `lastPromptAt` 是投影 `sessionListMetadata` 记录的最近一条人类消息时间。
 *
 * 保留软读而不是删掉：base 里没有等价数据（会话 header 只有 createdAt，该投影
 * 由 controller 自己注册），自己逐会话读事件日志取 `user/message` 的 `time`
 * 在 `/sessions all` 上等于每次命令扫全量日志。缺服务时只丢排序与 blank，
 * 列表本身照常返回。
 */
interface SessionControllerLike {
  list?(request: object, signal?: AbortSignal): Promise<{ items?: readonly unknown[] } | undefined>;
  /**
   * 改一条仍在队列里的消息（宿主 SessionController.updateQueue）。
   *
   * 只支持把 next-turn 的消息改成插话；已消费或回合已结束时宿主抛
   * session/queue-item-not-found / session/steer-unavailable。
   */
  updateQueue?(request: {
    sessionId: string;
    itemId: string;
    action: { kind: 'steer' };
  }): Promise<{ accepted?: boolean } | undefined>;
}

/**
 * ctx.workingDirectory 的最小只读契约（dsh-base 的 working-directory）。
 *
 * `defaultDirectory` 是 dsh 启动目录；`get(session)` 取会话当前 cwd，覆盖运行期
 * `cd`。服务已写进 `inject`，属性访问不再需要软读。
 */
interface WorkingDirectoryLike {
  defaultDirectory?: unknown;
  get?: (target: unknown) => unknown;
}

/**
 * 把 `sessionQuery.listSessions()` 的 `{ header, live }` 记录转成 {@link HostSessionInfo}。
 */
function hostSessionFrom(record: unknown): HostSessionInfo | undefined {
  const raw = record as { header?: unknown; live?: unknown } | null | undefined;
  const header = raw?.header as Record<string, unknown> | null | undefined;
  if (!header || typeof header !== 'object') return undefined;

  const id = header['id'];
  if (typeof id !== 'string' || id === '') return undefined;

  const info: HostSessionInfo = {
    id,
    createdAt: typeof header['createdAt'] === 'number' ? header['createdAt'] : 0,
    updatedAt: typeof header['createdAt'] === 'number' ? header['createdAt'] : 0,
    isSeeded: header['isSeeded'] === true,
    live: raw?.live === true,
    blank: false,
    ...(typeof header['cwd'] === 'string' ? { cwd: header['cwd'] } : {}),
    ...(typeof header['parentSession'] === 'string' ? { parentSession: header['parentSession'] } : {}),
    ...(header['origin'] === 'subagent' ? { origin: 'subagent' as const } : {}),
  };
  return info;
}

/** 从批量标题结果里取出 (id, title)；失败/缺标题的条目忽略 */
function collectTitles(results: readonly unknown[], sink: Map<string, string>): void {  for (const result of results) {
    const item = result as {
      sessionId?: unknown;
      status?: unknown;
      value?: { title?: { title?: unknown } };
    } | null;
    if (item?.status !== 'fulfilled') continue;
    const id = typeof item.sessionId === 'string' ? item.sessionId : undefined;
    const title = item.value?.title?.title;
    if (id !== undefined && typeof title === 'string' && title !== '') sink.set(id, title);
  }
}

/**
 * 读宿主会话摘要里的活跃时间与 blank 标记（Web 侧栏用的是同一份摘要）。
 *
 * sessionController 缺失（非 web 组合包）或读取失败时返回空表：
 * 列表回退成按创建时间排，blank 一律按 false 处理。
 */
async function sessionListMeta(
  controller: SessionControllerLike | undefined,
  logger?: AdapterLogger,
): Promise<{ recency: Map<string, number>; blank: Set<string> }> {
  const recency = new Map<string, number>();
  const blank = new Set<string>();
  if (typeof controller?.list !== 'function') return { recency, blank };
  try {
    const result = await controller.list({});
    for (const item of result?.items ?? []) {
      const raw = item as { sessionId?: unknown; updatedAt?: unknown; blank?: unknown } | null;
      if (raw === null || typeof raw.sessionId !== 'string') continue;
      if (typeof raw.updatedAt === 'number') recency.set(raw.sessionId, raw.updatedAt);
      if (raw.blank === true) blank.add(raw.sessionId);
    }
  } catch (err) {
    logger?.warn?.(`host adapter: sessionController.list 失败，活跃时间回退成创建时间: ${errorMessage(err)}`);
  }
  return { recency, blank };
}

/**
 * 读可选的 sessionController（只有 web 组合包提供）。
 *
 * 走 `ctx.get` 而不是属性读取：不在 inject 里时 Cordis 代理在属性访问处直接抛
 * `cannot get property "sessionController" without inject`。拿不到就只用
 * sessionQuery / sessionPersistence 的会话摘要（丢排序与 blank）。
 */
function optionalSessionController(ctx: Context): SessionControllerLike | undefined {
  return optionalService<SessionControllerLike>(ctx, 'sessionController');
}

/**
 * 读可选的 workspaceRegistry（只有 web 组合包提供）。
 *
 * 同样走 `ctx.get`；拿不到时列表仍按会话目录分组，只是没有工作区名、置顶与归档。
 */
function optionalWorkspaceRegistry(ctx: Context): WorkspaceRegistryLike | undefined {
  return optionalService<WorkspaceRegistryLike>(ctx, 'workspaceRegistry');
}

export function createHostAdapter(ctx: Context, logger?: AdapterLogger): HostAdapter {
  const host = ctx as unknown as {
    sessionPersistence: SessionPersistenceLike;
    sessionQuery: SessionQueryLike;
    sessionTitle: SessionTitleLike;
    workingDirectory: WorkingDirectoryLike;
  };
  const persistence = host.sessionPersistence;
  const query = host.sessionQuery;
  const controller = optionalSessionController(ctx);
  const titleService = host.sessionTitle;
  /**
   * 每次现读，不在构造期定死：组合包注册服务与插件 apply 是并发的。
   *
   * 构造这一刻服务可能还没提供，存成常量就会把「此刻没有」固化成「整台部署
   * 永远没有」，归档入口再不出现；软依赖一律在使用点现查。
   */
  const registryNow = (): WorkspaceRegistryLike | undefined => optionalWorkspaceRegistry(ctx);

  // 现读而不是建表时定死：forge 组合包可能在插件 apply 之后才注册 worktrees
  const capabilities = (): string[] => [
    'sessionEvents(snapshotEvents)',
    'sessionPersistence.stat',
    ...(registryNow() === undefined ? [] : ['workspaceRegistry']),
    ...(optionalService<WorktreeServiceLike>(ctx, 'worktrees') === undefined ? [] : ['worktrees']),
    ...(typeof optionalSessionController(ctx)?.updateQueue === 'function' ? ['sessionController.updateQueue'] : []),
    'sessionQuery',
    'sessionTitle.rename',
  ];

  /** registry.list() 收窄成纯数据快照；异常降级为空列表 */
  const workspaceList = (): WorkspaceInfo[] => {
    const registry = registryNow();
    if (registry === undefined) return [];
    try {
      return registry.list().flatMap((workspace) => {
        if (typeof workspace?.path !== 'string' || typeof workspace.id !== 'string') return [];
        const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
        const title = typeof workspace.title === 'string' && workspace.title !== ''
          ? workspace.title
          : basename(workspace.path);
        return [{ id: workspace.id, title, path: workspace.path, sessionIds: [...sessionIds] }];
      });
    } catch (err) {
      logger?.warn?.(`host adapter: workspaceRegistry.list 失败: ${errorMessage(err)}`);
      return [];
    }
  };

  return {
    get capabilities() {
      return capabilities();
    },

    sessionEvents(session) {
      return session.snapshotEvents();
    },

    async sessionHeader(sessionId) {
      try {
        return (await persistence.stat(sessionId))?.header;
      } catch {
        return undefined; // 读不到 preset 不该阻断会话打开，回落到当前 effective preset
      }
    },

    async sessionExists(sessionId) {
      return (await persistence.stat(sessionId)) !== undefined;
    },

    async attachSessionToWorkspace(sessionId, cwd) {
      const registry = registryNow();
      if (registry === undefined) return;
      try {
        // 不传 title：宿主按目录最后一段生成显示名（一般规律）
        const workspace = await registry.create(cwd);
        await workspace.attachSession(sessionId);
        logger?.debug?.(`host adapter: attached session ${sessionId} to workspace ${workspace.path ?? cwd}`);
      } catch (err) {
        // 仅影响侧边栏展示，绝不打断消息处理；但属异常（cwd 不匹配/目录缺失等），warn 留痕
        logger?.warn?.(`host adapter: workspace attach failed for ${sessionId}: ${errorMessage(err)}`);
      }
    },

    /** 宿主工作区快照（顺序即侧边栏顺序） */
    workspaceList,

    defaultWorkspacePath() {
      // 1) registry 里的默认项目（自动标题 = default-workspace）
      const auto = workspaceList().find((workspace) => workspace.title === DEFAULT_WORKSPACE_TITLE);
      if (auto) return auto.path;

      // 2) workingDirectory.defaultDirectory（默认 = dsh 启动目录）
      const working = host.workingDirectory;
      if (typeof working?.defaultDirectory === 'string' && working.defaultDirectory !== '') {
        return working.defaultDirectory;
      }
      return undefined;
    },

    sessionDirectory(session) {
      // workingDirectory.get(session) 覆盖运行期 cd；拿不到再退回 header.cwd
      const working = host.workingDirectory;
      if (typeof working?.get === 'function') {
        try {
          const dir = working.get(session);
          if (typeof dir === 'string' && dir !== '') return dir;
        } catch {
          // 服务形态差异 → 走 header
        }
      }
      const header = (session as { header?: { cwd?: unknown } } | null | undefined)?.header;
      return typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined;
    },

    worktrees() {
      return optionalService<WorktreeServiceLike>(ctx, 'worktrees');
    },

    async headOf(directory) {
      const subprocess = optionalService<SubprocessLike>(ctx, 'subprocess');
      if (subprocess === undefined) return undefined;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
      try {
        const git = await subprocess.resolveExecutable('git', undefined, controller.signal);
        const commit = await gitStdout(subprocess, git, directory, ['rev-parse', '--verify', 'HEAD^{commit}'], controller.signal);
        if (commit === undefined) return undefined;
        const branch = await gitStdout(subprocess, git, directory, ['symbolic-ref', '-q', '--short', 'HEAD'], controller.signal);
        return { commit, ...(branch === undefined ? {} : { branch }) };
      } catch (err) {
        logger?.debug?.(`host adapter: headOf 失败: ${errorMessage(err)}`);
        return undefined;
      } finally {
        clearTimeout(timer);
      }
    },

    sandboxMode() {
      const policy = optionalService<SandboxPolicyLike>(ctx, 'sandboxPolicy');
      if (policy === undefined) return undefined;
      try {
        return policy.resolve()?.mode;
      } catch (err) {
        logger?.debug?.(`host adapter: sandboxPolicy.resolve 失败: ${errorMessage(err)}`);
        return undefined;
      }
    },

    supportsQueueSteer() {
      return typeof optionalSessionController(ctx)?.updateQueue === 'function';
    },

    async steerQueuedMessage(sessionId, itemId) {
      // 现读而非用构造期快照：服务可能在 apply 之后才挂载
      const controller = optionalSessionController(ctx);
      if (typeof controller?.updateQueue !== 'function') {
        return { ok: false, reason: 'failed' };
      }
      try {
        const result = await controller.updateQueue({
          sessionId,
          itemId,
          action: { kind: 'steer' },
        });
        if (result?.accepted === false) return { ok: false, reason: 'failed' };
        return { ok: true };
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        if (code === 'session/queue-item-not-found') return { ok: false, reason: 'not-found' };
        if (code === 'session/steer-unavailable') return { ok: false, reason: 'steer-unavailable' };
        logger?.warn?.(`host adapter: sessionController.updateQueue 失败: ${errorMessage(err)}`);
        return { ok: false, reason: 'failed', message: errorMessage(err) };
      }
    },

    async listSessions() {
      try {
        const [records, meta] = await Promise.all([
          query.listSessions(),
          sessionListMeta(controller, logger),
        ]);
        return records
          .map((record) => hostSessionFrom(record))
          .filter((info): info is HostSessionInfo => info !== undefined)
          .map((info) => {
            const updatedAt = meta.recency.get(info.id);
            return {
              ...info,
              ...(meta.blank.has(info.id) ? { blank: true } : {}),
              ...(updatedAt === undefined ? {} : { updatedAt }),
            };
          });
      } catch (err) {
        logger?.warn?.(`host adapter: sessionQuery.listSessions 失败: ${errorMessage(err)}`);
        return [];
      }
    },

    async sessionTitles(ids) {
      const titles = new Map<string, string>();
      if (ids.length === 0) return titles;

      try {
        // 标题要读日志（每会话一次完整读取），失败只影响该条，绝不影响列表本身
        collectTitles(await query.readTitleSnapshots(ids), titles);
      } catch (err) {
        logger?.warn?.(`host adapter: 批量读取会话标题失败: ${errorMessage(err)}`);
      }
      return titles;
    },

    renameSession(session, title) {
      try {
        const accepted = titleService.rename(session, title);
        const acceptedTitle = typeof accepted?.title === 'string' && accepted.title !== ''
          ? accepted.title
          : title;
        logger?.debug?.(`host adapter: renamed session title: ${acceptedTitle}`);
        return { ok: true, title: acceptedTitle };
      } catch (err) {
        return renameFailure(err);
      }
    },

    async archiveSession(sessionId) {
      const registry = registryNow();
      if (registry === undefined) return workspaceUnavailable('archive');
      try {
        // stopActivity：宿主先让 providers 停掉该会话的工作再写归档集，避免
        // 活跃会话被 session-active 拒绝；进程内的 agent 由 manager 先释放
        await registry.archiveSession(sessionId, { stopActivity: true });
        logger?.debug?.(`host adapter: archived session ${sessionId}`);
        return { ok: true };
      } catch (err) {
        return archiveFailure(err, 'archive', sessionId);
      }
    },

    async unarchiveSession(sessionId) {
      const registry = registryNow();
      if (registry === undefined) return workspaceUnavailable('unarchive');
      try {
        await registry.unarchiveSession(sessionId);
        logger?.debug?.(`host adapter: unarchived session ${sessionId}`);
        return { ok: true };
      } catch (err) {
        return archiveFailure(err, 'unarchive', sessionId);
      }
    },

    archivedSessionIds() {
      return new Set(registryNow()?.archivedSessionIds ?? []);
    },

    pinnedSessionIds() {
      return new Set(registryNow()?.pinnedSessionIds ?? []);
    },

    supportsWorkspaceRegistry() {
      return registryNow() !== undefined;
    },
  };
}

/**
 * 把标题服务抛出的错误归一成改名结果。
 *
 * 类名判定（不用 instanceof）与归档一致：宿主可能装了同一个包的另一个副本。
 * 会话已关闭时宿主的报错文本不统一，按关键字识别成 `not-live`，让调用方给出
 * 「会话已关闭」这类可读提示，而不是把原始英文抛给用户。
 */
function renameFailure(err: unknown): SessionRenameOutcome {
  const name = err instanceof Error ? err.name : '';
  const message = errorMessage(err);
  if (name === 'SessionTitleInvalidError') return { ok: false, reason: 'invalid', message };
  if (/not\s+(?:live|active|open)|disposed|closed/i.test(message)) {
    return { ok: false, reason: 'not-live', message };
  }
  return { ok: false, reason: 'failed', message };
}

/** 部署里没有 workspaceRegistry：不归档，也不假装成功 */
function workspaceUnavailable(verb: 'archive' | 'unarchive'): SessionArchiveOutcome {
  const action = verb === 'archive' ? '归档' : '取消归档';
  return { ok: false, reason: 'unavailable', message: `当前部署不支持${action}` };
}

/**
 * 把 registry 抛出的错误归一成归档结果。
 *
 * 识别按 `name` 而不是 instanceof：dsh-workspace 可能被宿主装成另一个副本，
 * 跨副本的 instanceof 恒假，按类名判定才稳。
 */
function archiveFailure(
  err: unknown,
  verb: 'archive' | 'unarchive',
  sessionId: string,
): SessionArchiveOutcome {
  const message = errorMessage(err);
  const name = err instanceof Error ? err.name : '';
  if (name === 'WorkspaceUnknownSessionError') {
    return { ok: false, reason: 'not-found', message: `宿主找不到会话 ${sessionId}（可能已被删除）` };
  }
  if (name === 'WorkspaceActiveSessionError') {
    return { ok: false, reason: 'busy', message: `会话仍在运行: ${message}` };
  }
  return { ok: false, reason: 'failed', message: `${verb === 'archive' ? '归档' : '取消归档'}失败: ${message}` };
}
