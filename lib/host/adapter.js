var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { basename } from 'node:path';
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
 * 取出可用的持久化服务；形态不匹配返回 undefined。
 *
 * 宿主服务是版本漂移点，必须探测方法是否存在再调用：直接调用缺失的方法会抛
 * `TypeError`，与「后端故障」混在一起，让调用方误以为求证过了。
 */
function statCapablePersistence(ctx) {
    const persistence = safeGet(ctx, 'sessionPersistence');
    return typeof persistence?.stat === 'function' ? persistence : undefined;
}
/**
 * 把宿主的会话记录/快照统一成 {@link HostSessionInfo}。
 *
 * 两种形态：`sessionQuery.listSessions()` 返回 `{ header, live }`；
 * `sessionPersistence.list()` 返回 `{ header, revision }`（无 live）。
 */
function hostSessionFrom(record, liveFallback) {
    const raw = record;
    const header = (raw?.header ?? raw);
    if (!header || typeof header !== 'object')
        return undefined;
    const id = header['id'];
    if (typeof id !== 'string' || id === '')
        return undefined;
    const info = {
        id,
        createdAt: typeof header['createdAt'] === 'number' ? header['createdAt'] : 0,
        isSeeded: header['isSeeded'] === true,
        live: raw?.live === true || liveFallback,
        ...(typeof header['cwd'] === 'string' ? { cwd: header['cwd'] } : {}),
        ...(typeof header['parentSession'] === 'string' ? { parentSession: header['parentSession'] } : {}),
        ...(header['origin'] === 'subagent' ? { origin: 'subagent' } : {}),
    };
    return info;
}
/** 从批量标题结果里取出 (id, title)；失败/缺标题的条目忽略 */
function collectTitles(results, sink) {
    for (const result of results) {
        const item = result;
        if (item?.status !== 'fulfilled')
            continue;
        const id = typeof item.sessionId === 'string' ? item.sessionId : undefined;
        const title = item.value?.title?.title;
        if (id !== undefined && typeof title === 'string' && title !== '')
            sink.set(id, title);
    }
}
/** 取出可用的 workspaceRegistry；形态不匹配返回 undefined（dsh-workspace 未挂载时无侧边栏） */
function workspaceRegistry(ctx) {
    const registry = safeGet(ctx, 'workspaceRegistry');
    if (!registry)
        return undefined;
    // 工作区归属要 create；归档只要 archiveSession。任一可用就返回，由调用点自判
    return typeof registry.create === 'function' || typeof registry.archiveSession === 'function'
        ? registry
        : undefined;
}
/** 模块级函数的动态 import 结果缓存（spec 变量路径绕开本地依赖类型检查） */
const moduleCache = new Map();
async function importModule(spec, logger) {
    if (moduleCache.has(spec))
        return moduleCache.get(spec);
    let mod;
    try {
        mod = (await import(__rewriteRelativeImportExtension(spec)));
    }
    catch {
        mod = undefined;
        logger?.warn(`host adapter: module not resolvable: ${spec}`);
    }
    moduleCache.set(spec, mod);
    return mod;
}
export function createHostAdapter(ctx, logger) {
    const capabilities = [];
    // events 读取路径只有运行时才能确定，sessionEvents 内自适应
    capabilities.push('sessionEvents(s自适应)');
    // 可能在插件启动后才注册，sessionExists/sessionHeader 内每次重新探测；此处仅记录启动时形态
    capabilities.push(statCapablePersistence(ctx)
        ? 'sessionPersistence.stat(可用)'
        : 'sessionPersistence.stat(不可用，会话存在性判定降级)');
    capabilities.push(workspaceRegistry(ctx)
        ? 'workspaceRegistry.create(可用)'
        : 'workspaceRegistry.create(不可用，侧边栏工作区归属降级)');
    // 会话列举/标题/归档都是「有就用、没有降级」的可选能力
    const query = safeGet(ctx, 'sessionQuery');
    capabilities.push(typeof query?.listSessions === 'function'
        ? 'sessionQuery.listSessions(可用)'
        : 'sessionQuery.listSessions(不可用，回退 persistence.list)');
    capabilities.push(typeof query?.readTitleSnapshots === 'function'
        ? 'sessionQuery.readTitleSnapshots(可用)'
        : 'sessionQuery.readTitleSnapshots(不可用，会话列表无标题)');
    const archiveProbe = workspaceRegistry(ctx);
    capabilities.push(typeof archiveProbe?.archiveSession === 'function'
        ? 'workspaceRegistry.archiveSession(可用，可归档会话)'
        : 'workspaceRegistry.archiveSession(不可用，/sessions archive 降级只读)');
    let resolveFn;
    const presets = safeGet(ctx, 'agentPresets');
    if (presets && typeof presets.serviceFor === 'function') {
        resolveFn = (agent, name) => presets.serviceFor(agent, name);
        capabilities.push('serviceFor(presets实例方法)');
    }
    else {
        capabilities.push('serviceFor(serviceForAgent动态)');
    }
    /** registry.list() 收窄成纯数据快照；任何异常都降级为空列表 */
    const workspaceList = () => {
        const registry = workspaceRegistry(ctx);
        if (typeof registry?.list !== 'function')
            return [];
        try {
            return registry.list().flatMap((workspace) => {
                if (typeof workspace?.path !== 'string' || typeof workspace.id !== 'string')
                    return [];
                const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
                const title = typeof workspace.title === 'string' && workspace.title !== ''
                    ? workspace.title
                    : basename(workspace.path);
                return [{ id: workspace.id, title, path: workspace.path, sessionIds: [...sessionIds] }];
            });
        }
        catch (err) {
            logger?.warn?.(`host adapter: workspaceRegistry.list 失败: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    };
    return {
        capabilities,
        sessionEvents(session) {
            if (typeof session.snapshotEvents === 'function')
                return session.snapshotEvents();
            const legacy = session.events;
            return Array.isArray(legacy) ? legacy : [];
        },
        async serviceFor(agent, name) {
            if (resolveFn) {
                try {
                    const found = resolveFn(agent, name);
                    if (found)
                        return found;
                }
                catch { /* 宿主实现差异，走模块函数 */ }
            }
            const mod = await importModule('@deepseek-ai/dsh-agent-presets', logger);
            const fn = mod?.serviceForAgent;
            if (typeof fn !== 'function')
                return undefined;
            try {
                return fn(ctx, agent, name);
            }
            catch {
                return undefined;
            }
        },
        globalService(name) {
            return safeGet(ctx, name);
        },
        async sessionHeader(sessionId) {
            const persistence = statCapablePersistence(ctx);
            if (!persistence)
                return undefined;
            try {
                return (await persistence.stat(sessionId))?.header;
            }
            catch {
                return undefined; // 读不到 preset 不该阻断会话打开，回落到当前 effective preset
            }
        },
        async sessionExists(sessionId) {
            const persistence = statCapablePersistence(ctx);
            if (!persistence)
                return undefined;
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
                if (typeof registry.create !== 'function') {
                    logger?.debug?.(`host adapter: workspaceRegistry 无 create，跳过会话 ${sessionId} 的工作区归属`);
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
            }
            catch (err) {
                // 仅影响侧边栏展示，绝不打断消息处理；但属异常（cwd 不匹配/目录缺失等），warn 留痕
                logger?.warn?.(`host adapter: workspace attach failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
        /** 宿主工作区快照（顺序即侧边栏顺序）；registry 未挂载时为空数组 */
        workspaceList,
        defaultWorkspacePath() {
            // 1) registry 里的默认项目（自动标题 = default-workspace）
            const auto = workspaceList().find((workspace) => workspace.title === DEFAULT_WORKSPACE_TITLE);
            if (auto)
                return auto.path;
            // 2) 宿主 workingDirectory.defaultDirectory（默认 = dsh 启动目录）
            const working = safeGet(ctx, 'workingDirectory');
            if (typeof working?.defaultDirectory === 'string' && working.defaultDirectory !== '') {
                return working.defaultDirectory;
            }
            return undefined;
        },
        sessionDirectory(session) {
            // workingDirectory.get(session) 覆盖运行期 cd；拿不到再退回 header.cwd
            const working = safeGet(ctx, 'workingDirectory');
            if (typeof working?.get === 'function') {
                try {
                    const dir = working.get(session);
                    if (typeof dir === 'string' && dir !== '')
                        return dir;
                }
                catch {
                    // 服务形态差异（旧版本/未挂载）→ 走 header
                }
            }
            const header = session?.header;
            return typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined;
        },
        async buildForkSeed(events, boundary) {
            const mod = await importModule('@deepseek-ai/dsh-session/fork', logger);
            const fn = mod?.buildForkSeed;
            if (typeof fn !== 'function')
                return undefined;
            try {
                return fn(events, boundary);
            }
            catch {
                return undefined;
            }
        },
        async listSessions() {
            const engine = safeGet(ctx, 'sessionQuery');
            if (typeof engine?.listSessions === 'function') {
                try {
                    return (await engine.listSessions())
                        .map((record) => hostSessionFrom(record, false))
                        .filter((info) => info !== undefined);
                }
                catch (err) {
                    // 索引后端（sqlite）损坏时降级到持久化列举，别让会话列表整体不可用
                    logger?.warn?.(`host adapter: sessionQuery.listSessions 失败，回退 persistence.list: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            const persistence = safeGet(ctx, 'sessionPersistence');
            if (typeof persistence?.list !== 'function')
                return [];
            return (await persistence.list())
                .map((snapshot) => hostSessionFrom(snapshot, false))
                .filter((info) => info !== undefined);
        },
        async sessionTitles(ids) {
            const titles = new Map();
            if (ids.length === 0)
                return titles;
            const engine = safeGet(ctx, 'sessionQuery');
            if (typeof engine?.readTitleSnapshots !== 'function')
                return titles;
            try {
                // 标题要读日志（每会话一次完整读取），失败只影响该条，绝不影响列表本身
                collectTitles(await engine.readTitleSnapshots(ids), titles);
            }
            catch (err) {
                logger?.warn?.(`host adapter: 批量读取会话标题失败: ${err instanceof Error ? err.message : String(err)}`);
            }
            return titles;
        },
        async archiveSession(sessionId) {
            const registry = workspaceRegistry(ctx);
            if (typeof registry?.archiveSession !== 'function') {
                logger?.warn?.('host adapter: workspaceRegistry.archiveSession 不可用，/sessions archive 无法执行');
                return {
                    ok: false,
                    reason: 'unavailable',
                    message: '当前 profile 没装会话归档接口（web / desktop 自带）',
                };
            }
            try {
                // stopActivity：宿主先让 providers 停掉该会话的工作再写归档集，避免
                // 活跃会话被 session-active 拒绝；进程内的 agent 由 manager 先释放
                await registry.archiveSession(sessionId, { stopActivity: true });
                logger?.debug?.(`host adapter: archived session ${sessionId}`);
                return { ok: true };
            }
            catch (err) {
                return archiveFailure(err, 'archive', sessionId);
            }
        },
        async unarchiveSession(sessionId) {
            const registry = workspaceRegistry(ctx);
            if (typeof registry?.unarchiveSession !== 'function') {
                logger?.warn?.('host adapter: workspaceRegistry.unarchiveSession 不可用，/sessions unarchive 无法执行');
                return {
                    ok: false,
                    reason: 'unavailable',
                    message: '当前 profile 没装会话归档接口（web / desktop 自带）',
                };
            }
            try {
                await registry.unarchiveSession(sessionId);
                logger?.debug?.(`host adapter: unarchived session ${sessionId}`);
                return { ok: true };
            }
            catch (err) {
                return archiveFailure(err, 'unarchive', sessionId);
            }
        },
        archivedSessionIds() {
            const archived = workspaceRegistry(ctx)?.archivedSessionIds;
            return new Set(Array.isArray(archived) ? archived : []);
        },
        pinnedSessionIds() {
            const pinned = workspaceRegistry(ctx)?.pinnedSessionIds;
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
async function migrateLegacyTitle(workspace, cwd, logger) {
    if (workspace.title !== LEGACY_WORKSPACE_TITLE)
        return;
    if (typeof workspace.setTitle !== 'function')
        return;
    const path = workspace.path ?? cwd;
    const derived = basename(path);
    if (derived === '' || derived === workspace.title)
        return;
    try {
        await workspace.setTitle(derived);
        logger?.debug?.(`host adapter: 工作区标题已迁移 ${LEGACY_WORKSPACE_TITLE} → ${derived} (${path})`);
    }
    catch (err) {
        logger?.debug?.(`host adapter: 工作区标题迁移失败（不影响使用）: ${err instanceof Error ? err.message : String(err)}`);
    }
}
/**
 * 把 registry 抛出的错误归一成归档结果。
 *
 * 识别按 `name` 而不是 instanceof：dsh-workspace 可能被宿主装成另一个副本，
 * 跨副本的 instanceof 恒假，按类名判定才稳。
 */
function archiveFailure(err, verb, sessionId) {
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
/** ctx.get 的非抛出版本 */
function safeGet(ctx, name) {
    try {
        return ctx.get(name);
    }
    catch {
        return undefined;
    }
}
/** 测试辅助：清空模块缓存 */
export function _resetAdapterCache() {
    moduleCache.clear();
}
//# sourceMappingURL=adapter.js.map