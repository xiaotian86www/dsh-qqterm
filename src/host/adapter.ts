/**
 * 宿主 API 适配层 — 收口所有版本漂移点，一次探测按需复用。
 *
 * 宿主新旧版本 API 形态不同（本插件踩过的漂移：events → snapshotEvents、
 * presets.serviceFor 实例方法 → serviceForAgent 模块函数、./fork 子路径导出）。
 * 调用方只依赖本模块的稳定签名，不再直接假设宿主形态。
 */
import type { Context } from '@deepseek-ai/cordis';
import { basename } from 'node:path';

/** 日志最小接口 */
export interface AdapterLogger {
  info(msg: string): void;
  warn(msg: string): void;
  debug?(msg: string): void;
}

export interface HostAdapter {
  /** 会话事件读取：新宿主 snapshotEvents()，旧宿主 events getter */
  sessionEvents(session: { snapshotEvents?: () => readonly unknown[]; events?: readonly unknown[] }): readonly unknown[];
  /** preset 作用域服务解析：旧宿主实例方法 / 新宿主模块函数 */
  serviceFor(agent: { ctx: unknown }, name: string): Promise<unknown | undefined>;
  /** 全局服务读取（未注册返回 undefined，不抛） */
  globalService(name: string): unknown | undefined;
  /** 官方 fork seed 构造；旧宿主无导出时返回 undefined */
  buildForkSeed(events: readonly unknown[], boundary: number): Promise<readonly unknown[] | undefined>;
  /** 会话 header 读取（取 agentPreset 等）；会话不存在、服务缺失或读取失败返回 undefined */
  sessionHeader(sessionId: string): Promise<SessionHeaderLike | undefined>;
  /**
   * 会话是否存在于持久化层。
   *
   * `undefined` = 没有求证手段（宿主未注册 sessionPersistence，或其形态不含
   * `stat`）。调用方不得把它当成「不存在」——那正是重建已存在会话、撞出重复
   * id 的根因。后端真故障时照常抛出。
   */
  sessionExists(sessionId: string): Promise<boolean | undefined>;
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
   * 列出宿主可见的全部会话（与 Web 侧栏同一来源）。
   *
   * 优先 `ctx.sessionQuery.listSessions()`（带 live 标记），回退
   * `ctx.sessionPersistence.list()`（只有持久化快照）。两者都没有时返回空数组；
   * 后端故障时抛错，由调用方决定如何降级展示。
   *
   * 注意：宿主列表**不过滤归档**（过滤是客户端的活），调用方要自己按
   * {@link archivedSessionIds} 区分。
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
   * 只读快照，registry 为空时返回空数组；`sessionIds` 是该工作区的会话记账。
   */
  workspaceList(): WorkspaceInfo[];
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

/** 归档 / 取消归档的结果（宿主错误已归一成可展示的文案） */
export type SessionArchiveOutcome =
  | { ok: true }
  | {
    ok: false;
    /** not-found = 会话不存在；busy = 有工作未停 */
    reason: 'not-found' | 'busy' | 'failed';
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
  /** 改显示标题（旧版本可能没有） */
  setTitle?(title: string): Promise<void>;
}

/** workspaceRegistry 服务最小契约（对齐 dsh-workspace WorkspaceRegistry） */
export interface WorkspaceRegistryLike {
  /** 获取目录对应的现有工作区；不存在时创建（幂等；路径须已存在且为目录） */
  create?(path: string, title?: string): Promise<WorkspaceLike>;
  /** 工作区列表（按侧边栏顺序） */
  list?(): readonly WorkspaceLike[];
  /** registry 全局归档集（只读；宿主早期版本没有该字段） */
  readonly archivedSessionIds?: readonly string[];
  /** registry 全局置顶集（最近置顶在前） */
  readonly pinnedSessionIds?: readonly string[];
  /** 归档一个会话；`stopActivity` 为真时先让 providers 停掉该会话的工作 */
  archiveSession?(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>;
  /** 取消归档（幂等） */
  unarchiveSession?(sessionId: string): Promise<void>;
}

/**
 * 宿主「默认工作区」的自动标题（= 首次使用时创建的目录名，见
 * dsh-api-workspace-controller 的 DEFAULT_WORKSPACE_DIRECTORY）。
 * 用户改过名就匹配不到，此时退回启动目录。
 */
const DEFAULT_WORKSPACE_TITLE = 'default-workspace';

/**
 * 历史版本硬编码过的工作区标题。
 *
 * 0.5.x 的插件在 create 时传了 `title: 'QQBot'`，导致侧边栏里这个项目一直叫
 * QQBot 而不是目录名；现在 create 不再传标题，遇到旧标题就地迁移成目录名。
 */
const LEGACY_WORKSPACE_TITLE = 'QQBot';

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
 * 把宿主的会话记录/快照统一成 {@link HostSessionInfo}。
 *
 * 两种形态：`sessionQuery.listSessions()` 返回 `{ header, live }`；
 * `sessionPersistence.list()` 返回 `{ header, revision }`（无 live）。
 */
function hostSessionFrom(record: unknown, liveFallback: boolean): HostSessionInfo | undefined {
  const raw = record as { header?: unknown; live?: unknown } | null | undefined;
  const header = (raw?.header ?? raw) as Record<string, unknown> | null | undefined;
  if (!header || typeof header !== 'object') return undefined;

  const id = header['id'];
  if (typeof id !== 'string' || id === '') return undefined;

  const info: HostSessionInfo = {
    id,
    createdAt: typeof header['createdAt'] === 'number' ? header['createdAt'] : 0,
    isSeeded: header['isSeeded'] === true,
    live: raw?.live === true || liveFallback,
    ...(typeof header['cwd'] === 'string' ? { cwd: header['cwd'] } : {}),
    ...(typeof header['parentSession'] === 'string' ? { parentSession: header['parentSession'] } : {}),
    ...(header['origin'] === 'subagent' ? { origin: 'subagent' as const } : {}),
  };
  return info;
}

/** 从批量标题结果里取出 (id, title)；失败/缺标题的条目忽略 */
function collectTitles(results: readonly unknown[], sink: Map<string, string>): void {
  for (const result of results) {
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

/** 模块级函数的动态 import 结果缓存（spec 变量路径绕开本地依赖类型检查） */
const moduleCache = new Map<string, Record<string, unknown> | undefined>();

async function importModule(spec: string, logger?: AdapterLogger): Promise<Record<string, unknown> | undefined> {
  if (moduleCache.has(spec)) return moduleCache.get(spec);
  let mod: Record<string, unknown> | undefined;
  try {
    mod = (await import(spec)) as Record<string, unknown>;
  } catch {
    mod = undefined;
    logger?.warn(`host adapter: module not resolvable: ${spec}`);
  }
  moduleCache.set(spec, mod);
  return mod;
}

export function createHostAdapter(ctx: Context, logger?: AdapterLogger): HostAdapter {
  const host = ctx as unknown as {
    sessionPersistence: SessionPersistenceLike;
    sessionQuery: SessionQueryLike;
    sessionTitle: SessionTitleLike;
    workspaceRegistry: WorkspaceRegistryLike;
    agentPresets: { serviceFor?(agent: unknown, name: string): unknown };
  };
  const persistence = host.sessionPersistence;
  const query = host.sessionQuery;
  const titleService = host.sessionTitle;
  const registry = host.workspaceRegistry;
  const presets = host.agentPresets;

  const resolveFn: ((agent: { ctx: unknown }, name: string) => unknown | undefined) | undefined =
    typeof presets.serviceFor === 'function'
      ? (agent, name) => presets.serviceFor!(agent, name)
      : undefined;

  const capabilities: string[] = [
    'sessionEvents(s自适应)',
    'sessionPersistence.stat',
    'workspaceRegistry',
    'sessionQuery',
    'sessionTitle.rename',
    resolveFn ? 'serviceFor(presets实例方法)' : 'serviceFor(serviceForAgent动态)',
  ];

  /** registry.list() 收窄成纯数据快照；异常降级为空列表 */
  const workspaceList = (): WorkspaceInfo[] => {
    if (typeof registry.list !== 'function') return [];
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
      logger?.warn?.(`host adapter: workspaceRegistry.list 失败: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  };

  return {
    capabilities,

    sessionEvents(session) {
      if (typeof session.snapshotEvents === 'function') return session.snapshotEvents();
      const legacy = session.events;
      return Array.isArray(legacy) ? legacy : [];
    },

    async serviceFor(agent, name) {
      if (resolveFn) {
        try {
          const found = resolveFn(agent, name);
          if (found) return found;
        } catch { /* 宿主实现差异，走模块函数 */ }
      }
      const mod = await importModule('@deepseek-ai/dsh-agent-presets', logger);
      const fn = mod?.serviceForAgent as
        | ((ctx: unknown, agent: { ctx: unknown }, name: string) => unknown)
        | undefined;
      if (typeof fn !== 'function') return undefined;
      try {
        return fn(ctx, agent, name);
      } catch {
        return undefined;
      }
    },

    globalService(name) {
      return (ctx as unknown as Record<string, unknown>)[name];
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
      try {
        if (typeof registry.create !== 'function') {
          logger?.warn?.(`host adapter: workspaceRegistry 无 create，跳过会话 ${sessionId} 的工作区归属`);
          return;
        }
        // 不传 title：宿主按目录最后一段生成显示名（一般规律）
        const workspace = await registry.create(cwd);
        if (!workspace || typeof workspace.attachSession !== 'function') {
          // 宿主接口演进：返回对象不含 attachSession → warn 避免静默失效
          logger?.warn?.(`host adapter: workspaceRegistry.create 返回了无 attachSession 的对象，跳过会话 ${sessionId}`);
          return;
        }
        await migrateLegacyTitle(workspace, cwd, logger);
        await workspace.attachSession(sessionId);
        logger?.debug?.(`host adapter: attached session ${sessionId} to workspace ${workspace.path ?? cwd}`);
      } catch (err) {
        // 仅影响侧边栏展示，绝不打断消息处理；但属异常（cwd 不匹配/目录缺失等），warn 留痕
        logger?.warn?.(`host adapter: workspace attach failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    /** 宿主工作区快照（顺序即侧边栏顺序） */
    workspaceList,

    defaultWorkspacePath() {
      // 1) registry 里的默认项目（自动标题 = default-workspace）
      const auto = workspaceList().find((workspace) => workspace.title === DEFAULT_WORKSPACE_TITLE);
      if (auto) return auto.path;

      // 2) workingDirectory.defaultDirectory（默认 = dsh 启动目录）；0.2.1 无服务声明，按可选读
      const working = (ctx as unknown as { workingDirectory?: { defaultDirectory?: unknown } }).workingDirectory;
      if (typeof working?.defaultDirectory === 'string' && working.defaultDirectory !== '') {
        return working.defaultDirectory;
      }
      return undefined;
    },

    sessionDirectory(session) {
      // workingDirectory.get(session) 覆盖运行期 cd；拿不到再退回 header.cwd
      const working = (ctx as unknown as { workingDirectory?: { get?: (target: unknown) => unknown } }).workingDirectory;
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

    async buildForkSeed(events, boundary) {
      const mod = await importModule('@deepseek-ai/dsh-session/fork', logger);
      const fn = mod?.buildForkSeed as
        | ((events: readonly unknown[], boundary: number) => readonly unknown[])
        | undefined;
      if (typeof fn !== 'function') return undefined;
      try {
        return fn(events, boundary);
      } catch {
        return undefined;
      }
    },

    async listSessions() {
      try {
        return (await query.listSessions())
          .map((record) => hostSessionFrom(record, false))
          .filter((info): info is HostSessionInfo => info !== undefined);
      } catch (err) {
        logger?.warn?.(`host adapter: sessionQuery.listSessions 失败: ${err instanceof Error ? err.message : String(err)}`);
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
        logger?.warn?.(`host adapter: 批量读取会话标题失败: ${err instanceof Error ? err.message : String(err)}`);
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
      try {
        // stopActivity：宿主先让 providers 停掉该会话的工作再写归档集，避免
        // 活跃会话被 session-active 拒绝；进程内的 agent 由 manager 先释放
        await registry.archiveSession!(sessionId, { stopActivity: true });
        logger?.debug?.(`host adapter: archived session ${sessionId}`);
        return { ok: true };
      } catch (err) {
        return archiveFailure(err, 'archive', sessionId);
      }
    },

    async unarchiveSession(sessionId) {
      try {
        await registry.unarchiveSession!(sessionId);
        logger?.debug?.(`host adapter: unarchived session ${sessionId}`);
        return { ok: true };
      } catch (err) {
        return archiveFailure(err, 'unarchive', sessionId);
      }
    },

    archivedSessionIds() {
      const archived = registry.archivedSessionIds;
      return new Set(Array.isArray(archived) ? archived : []);
    },

    pinnedSessionIds() {
      const pinned = registry.pinnedSessionIds;
      return new Set(Array.isArray(pinned) ? pinned : []);
    },
  };
}

/**
 * 把旧版本硬编码的 `QQBot` 标题迁移成目录名。
 *
 * 只处理标题仍是我们当初写入的 `QQBot` 的记录：用户自己改过的标题（包括刻意
 * 改成别的名字）一律不动，避免覆盖人的意图。迁移只影响侧栏显示，失败仅 debug。
 */
async function migrateLegacyTitle(
  workspace: WorkspaceLike,
  cwd: string,
  logger?: AdapterLogger,
): Promise<void> {
  if (workspace.title !== LEGACY_WORKSPACE_TITLE) return;
  if (typeof workspace.setTitle !== 'function') return;
  const path = workspace.path ?? cwd;
  const derived = basename(path);
  if (derived === '' || derived === workspace.title) return;
  try {
    await workspace.setTitle(derived);
    logger?.debug?.(`host adapter: 工作区标题已迁移 ${LEGACY_WORKSPACE_TITLE} → ${derived} (${path})`);
  } catch (err) {
    logger?.debug?.(`host adapter: 工作区标题迁移失败（不影响使用）: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 把标题服务抛出的错误归一成改名结果。
 *
 * 类名判定（不用 instanceof）与归档一致：宿主可能装了同一个包的另一个副本。
 * 会话已关闭时宿主的报错文本不统一，按关键字识别成 `not-live`，让调用方给出
 * 「先发一条消息再改名」这种可执行提示，而不是把原始英文抛给用户。
 */
function renameFailure(err: unknown): SessionRenameOutcome {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'SessionTitleInvalidError') return { ok: false, reason: 'invalid', message };
  if (/not\s+(?:live|active|open)|disposed|closed/i.test(message)) {
    return { ok: false, reason: 'not-live', message };
  }
  return { ok: false, reason: 'failed', message };
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
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  if (name === 'WorkspaceUnknownSessionError') {
    return { ok: false, reason: 'not-found', message: `宿主找不到会话 ${sessionId}（可能已被删除）` };
  }
  if (name === 'WorkspaceActiveSessionError') {
    return { ok: false, reason: 'busy', message: `会话仍在运行: ${message}` };
  }
  return { ok: false, reason: 'failed', message: `${verb === 'archive' ? '归档' : '取消归档'}失败: ${message}` };
}

/** 测试辅助：清空模块缓存 */
export function _resetAdapterCache(): void {
  moduleCache.clear();
}
