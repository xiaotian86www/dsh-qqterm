/**
 * 宿主 API 适配层 — 收口所有版本漂移点，一次探测按需复用。
 *
 * 宿主新旧版本 API 形态不同（本插件踩过的漂移：events → snapshotEvents、
 * presets.serviceFor 实例方法 → serviceForAgent 模块函数、./fork 子路径导出）。
 * 调用方只依赖本模块的稳定签名，不再直接假设宿主形态。
 */
import type { Context } from '@deepseek-ai/cordis';
import { resolve } from 'node:path';

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
   * 全部 fail-soft：workspaceRegistry 未挂载（如 headless profile）→ debug；
   * create/attach 失败或宿主接口演进（无 attachSession）→ warn，绝不抛出。
   * `attachSession` 幂等，创建与恢复路径都可安全调用；升级后老会话自动补挂。
   */
  attachSessionToWorkspace(sessionId: string, cwd: string): Promise<void>;
  /**
   * 列出宿主可见的全部会话（与 Web 侧栏同一来源）。
   *
   * 优先 `ctx.sessionQuery.listSessions()`（带 live 标记），回退
   * `ctx.sessionPersistence.list()`（只有持久化快照）。两者都没有时返回空数组；
   * 后端故障时抛错，由调用方决定如何降级展示。
   */
  listSessions(): Promise<HostSessionInfo[]>;
  /**
   * 批量读取会话标题（日志里的 `session/title` 最新值）。
   *
   * 标题是展示性数据：任何失败都按会话隔离并返回已有结果，绝不抛错。
   */
  sessionTitles(ids: readonly string[]): Promise<Map<string, string>>;
  /**
   * 会话存储根目录（JSONL 后端的 `root`）。
   *
   * 宿主没有删除会话的 API，硬删除只能按磁盘布局在 root 下定位目录，因此这里
   * 从服务实例上读取配置值；后端未暴露时返回 undefined，调用方据此拒绝硬删除。
   */
  sessionStoreRoot(): string | undefined;
  /** 探测结果摘要（启动契约检查用） */
  readonly capabilities: string[];
}

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
  readonly path?: string;
  attachSession(sessionId: string): Promise<void>;
}

/** workspaceRegistry 服务最小契约（对齐 dsh-workspace WorkspaceRegistry） */
export interface WorkspaceRegistryLike {
  /** 获取目录对应的现有工作区；不存在时创建（幂等；路径须已存在且为目录） */
  create(path: string, title?: string): Promise<WorkspaceLike>;
}

/** 插件创建的工作区显示名；仅在该 cwd 尚无工作区时生效（幂等 create 不改既有 title） */
const WORKSPACE_TITLE = 'QQBot';

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

/**
 * 取出可用的持久化服务；形态不匹配返回 undefined。
 *
 * 宿主服务是版本漂移点，必须探测方法是否存在再调用：直接调用缺失的方法会抛
 * `TypeError`，与「后端故障」混在一起，让调用方误以为求证过了。
 */
function statCapablePersistence(ctx: Context): SessionPersistenceLike | undefined {
  const persistence = safeGet(ctx, 'sessionPersistence') as SessionPersistenceLike | undefined;
  return typeof persistence?.stat === 'function' ? persistence : undefined;
}

/** ctx.sessionQuery 的最小契约（只要列表与批量标题） */
interface SessionQueryLike {
  listSessions?(signal?: AbortSignal): Promise<readonly unknown[]>;
  readTitleSnapshots?(ids: readonly string[]): Promise<readonly unknown[]>;
}

/** ctx.sessionPersistence 的列举契约（`root` 是 JSONL 后端的配置值，可能不存在） */
interface SessionListPersistenceLike {
  list?(): Promise<readonly unknown[]>;
  root?: unknown;
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

/** 取出可用的 workspaceRegistry；形态不匹配返回 undefined（dsh-workspace 未挂载时无侧边栏） */
function workspaceRegistry(ctx: Context): WorkspaceRegistryLike | undefined {
  const registry = safeGet(ctx, 'workspaceRegistry') as WorkspaceRegistryLike | undefined;
  return typeof registry?.create === 'function' ? registry : undefined;
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
  const capabilities: string[] = [];

  // events 读取路径只有运行时才能确定，sessionEvents 内自适应
  capabilities.push('sessionEvents(s自适应)');

  // 可能在插件启动后才注册，sessionExists/sessionHeader 内每次重新探测；此处仅记录启动时形态
  capabilities.push(statCapablePersistence(ctx)
    ? 'sessionPersistence.stat(可用)'
    : 'sessionPersistence.stat(不可用，会话存在性判定降级)');
  capabilities.push(workspaceRegistry(ctx)
    ? 'workspaceRegistry.create(可用)'
    : 'workspaceRegistry.create(不可用，侧边栏工作区归属降级)');

  // 会话列举/标题/存储根都是「有就用、没有降级」的可选能力
  const query = safeGet(ctx, 'sessionQuery') as SessionQueryLike | undefined;
  capabilities.push(typeof query?.listSessions === 'function'
    ? 'sessionQuery.listSessions(可用)'
    : 'sessionQuery.listSessions(不可用，回退 persistence.list)');
  capabilities.push(typeof query?.readTitleSnapshots === 'function'
    ? 'sessionQuery.readTitleSnapshots(可用)'
    : 'sessionQuery.readTitleSnapshots(不可用，会话列表无标题)');
  const listPersistence = safeGet(ctx, 'sessionPersistence') as SessionListPersistenceLike | undefined;
  capabilities.push(typeof listPersistence?.root === 'string'
    ? 'sessionPersistence.root(可用，可硬删除会话)'
    : 'sessionPersistence.root(不可用，拒绝硬删除会话)');

  let resolveFn: ((agent: { ctx: unknown }, name: string) => unknown | undefined) | undefined;
  const presets = safeGet(ctx, 'agentPresets') as
    | { serviceFor?: (agent: unknown, name: string) => unknown }
    | undefined;
  if (presets && typeof presets.serviceFor === 'function') {
    resolveFn = (agent, name) => presets.serviceFor!(agent, name);
    capabilities.push('serviceFor(presets实例方法)');
  } else {
    capabilities.push('serviceFor(serviceForAgent动态)');
  }

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
      return safeGet(ctx, name);
    },

    async sessionHeader(sessionId) {
      const persistence = statCapablePersistence(ctx);
      if (!persistence) return undefined;
      try {
        return (await persistence.stat(sessionId))?.header;
      } catch {
        return undefined; // 读不到 preset 不该阻断会话打开，回落到当前 effective preset
      }
    },

    async sessionExists(sessionId) {
      const persistence = statCapablePersistence(ctx);
      if (!persistence) return undefined;
      return (await persistence.stat(sessionId)) !== undefined;
    },

    async attachSessionToWorkspace(sessionId, cwd) {
      const registry = workspaceRegistry(ctx);
      if (!registry) {
        // 未挂载 dsh-workspace（如 headless profile）→ 无侧边栏，属预期降级
        logger?.debug?.(`host adapter: workspaceRegistry 未挂载，跳过会话 ${sessionId} 的工作区归属`);
        return;
      }
      try {
        const workspace = await registry.create(cwd, WORKSPACE_TITLE);
        if (!workspace || typeof workspace.attachSession !== 'function') {
          // 宿主接口演进：返回对象不含 attachSession → warn 避免静默失效
          logger?.warn?.(`host adapter: workspaceRegistry.create 返回了无 attachSession 的对象，跳过会话 ${sessionId}`);
          return;
        }
        await workspace.attachSession(sessionId);
        logger?.debug?.(`host adapter: attached session ${sessionId} to workspace ${workspace.path ?? cwd}`);
      } catch (err) {
        // 仅影响侧边栏展示，绝不打断消息处理；但属异常（cwd 不匹配/目录缺失等），warn 留痕
        logger?.warn?.(`host adapter: workspace attach failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
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
      const engine = safeGet(ctx, 'sessionQuery') as SessionQueryLike | undefined;
      if (typeof engine?.listSessions === 'function') {
        try {
          return (await engine.listSessions())
            .map((record) => hostSessionFrom(record, false))
            .filter((info): info is HostSessionInfo => info !== undefined);
        } catch (err) {
          // 索引后端（sqlite）损坏时降级到持久化列举，别让会话列表整体不可用
          logger?.warn?.(`host adapter: sessionQuery.listSessions 失败，回退 persistence.list: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const persistence = safeGet(ctx, 'sessionPersistence') as SessionListPersistenceLike | undefined;
      if (typeof persistence?.list !== 'function') return [];
      return (await persistence.list())
        .map((snapshot) => hostSessionFrom(snapshot, false))
        .filter((info): info is HostSessionInfo => info !== undefined);
    },

    async sessionTitles(ids) {
      const titles = new Map<string, string>();
      if (ids.length === 0) return titles;

      const engine = safeGet(ctx, 'sessionQuery') as SessionQueryLike | undefined;
      if (typeof engine?.readTitleSnapshots !== 'function') return titles;

      try {
        // 标题要读日志（每会话一次完整读取），失败只影响该条，绝不影响列表本身
        collectTitles(await engine.readTitleSnapshots(ids), titles);
      } catch (err) {
        logger?.warn?.(`host adapter: 批量读取会话标题失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      return titles;
    },

    sessionStoreRoot() {
      const persistence = safeGet(ctx, 'sessionPersistence') as SessionListPersistenceLike | undefined;
      const root = persistence?.root;
      return typeof root === 'string' && root !== '' ? resolve(root) : undefined;
    },
  };
}

/** ctx.get 的非抛出版本 */
function safeGet(ctx: Context, name: string): unknown {
  try {
    return ctx.get(name) as unknown;
  } catch {
    return undefined;
  }
}

/** 测试辅助：清空模块缓存 */
export function _resetAdapterCache(): void {
  moduleCache.clear();
}
