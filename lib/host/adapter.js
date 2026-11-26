import { basename } from 'node:path';
import { optionalService, errorMessage } from "../shared/utils.js";
/** 读 HEAD 的超时：本机 git 毫秒级返回，挂住说明目录不可用 */
const HEAD_TIMEOUT_MS = 5_000;
/**
 * 在 `cwd` 里跑一条只读 git 命令，返回裁剪后的 stdout。
 *
 * 不套沙箱包装：策略约束的是写，rev-parse / symbolic-ref 只读。失败、非零退出
 * 或输出为空都返回 undefined，由调用方降级。
 */
async function gitStdout(subprocess, git, cwd, args, signal) {
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
        if (exitCode !== 0)
            return undefined;
        const text = child.collected.stdout.readFrom(0).text.trim();
        return text === '' ? undefined : text;
    }
    finally {
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
 * 把 `sessionQuery.listSessions()` 的 `{ header, live }` 记录转成 {@link HostSessionInfo}。
 */
function hostSessionFrom(record) {
    const raw = record;
    const header = raw?.header;
    if (!header || typeof header !== 'object')
        return undefined;
    const id = header['id'];
    if (typeof id !== 'string' || id === '')
        return undefined;
    const info = {
        id,
        createdAt: typeof header['createdAt'] === 'number' ? header['createdAt'] : 0,
        updatedAt: typeof header['createdAt'] === 'number' ? header['createdAt'] : 0,
        isSeeded: header['isSeeded'] === true,
        live: raw?.live === true,
        blank: false,
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
/**
 * 读宿主会话摘要里的活跃时间与 blank 标记（Web 侧栏用的是同一份摘要）。
 *
 * sessionController 缺失（非 web 组合包）或读取失败时返回空表：
 * 列表回退成按创建时间排，blank 一律按 false 处理。
 */
async function sessionListMeta(controller, logger) {
    const recency = new Map();
    const blank = new Set();
    if (typeof controller?.list !== 'function')
        return { recency, blank };
    try {
        const result = await controller.list({});
        for (const item of result?.items ?? []) {
            const raw = item;
            if (raw === null || typeof raw.sessionId !== 'string')
                continue;
            if (typeof raw.updatedAt === 'number')
                recency.set(raw.sessionId, raw.updatedAt);
            if (raw.blank === true)
                blank.add(raw.sessionId);
        }
    }
    catch (err) {
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
function optionalSessionController(ctx) {
    return optionalService(ctx, 'sessionController');
}
/**
 * 读可选的 workspaceRegistry（只有 web 组合包提供）。
 *
 * 同样走 `ctx.get`；拿不到时列表仍按会话目录分组，只是没有工作区名、置顶与归档。
 */
function optionalWorkspaceRegistry(ctx) {
    return optionalService(ctx, 'workspaceRegistry');
}
export function createHostAdapter(ctx, logger) {
    const host = ctx;
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
    const registryNow = () => optionalWorkspaceRegistry(ctx);
    // 现读而不是建表时定死：forge 组合包可能在插件 apply 之后才注册 worktrees
    const capabilities = () => [
        'sessionEvents(snapshotEvents)',
        'sessionPersistence.stat',
        ...(registryNow() === undefined ? [] : ['workspaceRegistry']),
        ...(optionalService(ctx, 'worktrees') === undefined ? [] : ['worktrees']),
        ...(typeof optionalSessionController(ctx)?.updateQueue === 'function' ? ['sessionController.updateQueue'] : []),
        'sessionQuery',
        'sessionTitle.rename',
    ];
    /**
     * 调宿主 updateQueue 并归一错误码。
     *
     * 插话与删除共用同一条调用路径；这里只回传宿主错误码，由各动作决定
     * 映射成哪种 reason（删除没有 steer-unavailable 这一档）。
     */
    const updateQueueAction = async (sessionId, itemId, action) => {
        // 现读而非用构造期快照：服务可能在 apply 之后才挂载
        const current = optionalSessionController(ctx);
        if (typeof current?.updateQueue !== 'function')
            return { ok: false };
        try {
            const result = await current.updateQueue({ sessionId, itemId, action });
            if (result?.accepted === false)
                return { ok: false };
            return { ok: true };
        }
        catch (err) {
            const code = err?.code;
            return {
                ok: false,
                ...(typeof code === 'string' ? { code } : {}),
                message: errorMessage(err),
            };
        }
    };
    /** registry.list() 收窄成纯数据快照；异常降级为空列表 */
    const workspaceList = () => {
        const registry = registryNow();
        if (registry === undefined)
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
            }
            catch {
                return undefined; // 读不到 preset 不该阻断会话打开，回落到当前 effective preset
            }
        },
        async sessionExists(sessionId) {
            return (await persistence.stat(sessionId)) !== undefined;
        },
        async attachSessionToWorkspace(sessionId, cwd) {
            const registry = registryNow();
            if (registry === undefined)
                return;
            try {
                // 不传 title：宿主按目录最后一段生成显示名（一般规律）
                const workspace = await registry.create(cwd);
                await workspace.attachSession(sessionId);
                logger?.debug?.(`host adapter: attached session ${sessionId} to workspace ${workspace.path ?? cwd}`);
            }
            catch (err) {
                // 仅影响侧边栏展示，绝不打断消息处理；但属异常（cwd 不匹配/目录缺失等），warn 留痕
                logger?.warn?.(`host adapter: workspace attach failed for ${sessionId}: ${errorMessage(err)}`);
            }
        },
        /** 宿主工作区快照（顺序即侧边栏顺序） */
        workspaceList,
        defaultWorkspacePath() {
            // 1) registry 里的默认项目（自动标题 = default-workspace）
            const auto = workspaceList().find((workspace) => workspace.title === DEFAULT_WORKSPACE_TITLE);
            if (auto)
                return auto.path;
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
                    if (typeof dir === 'string' && dir !== '')
                        return dir;
                }
                catch {
                    // 服务形态差异 → 走 header
                }
            }
            const header = session?.header;
            return typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined;
        },
        worktrees() {
            return optionalService(ctx, 'worktrees');
        },
        async headOf(directory) {
            const subprocess = optionalService(ctx, 'subprocess');
            if (subprocess === undefined)
                return undefined;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
            try {
                const git = await subprocess.resolveExecutable('git', undefined, controller.signal);
                const commit = await gitStdout(subprocess, git, directory, ['rev-parse', '--verify', 'HEAD^{commit}'], controller.signal);
                if (commit === undefined)
                    return undefined;
                const branch = await gitStdout(subprocess, git, directory, ['symbolic-ref', '-q', '--short', 'HEAD'], controller.signal);
                return { commit, ...(branch === undefined ? {} : { branch }) };
            }
            catch (err) {
                logger?.debug?.(`host adapter: headOf 失败: ${errorMessage(err)}`);
                return undefined;
            }
            finally {
                clearTimeout(timer);
            }
        },
        sandboxMode() {
            const policy = optionalService(ctx, 'sandboxPolicy');
            if (policy === undefined)
                return undefined;
            try {
                return policy.resolve()?.mode;
            }
            catch (err) {
                logger?.debug?.(`host adapter: sandboxPolicy.resolve 失败: ${errorMessage(err)}`);
                return undefined;
            }
        },
        supportsQueueMutation() {
            // 能力探测已进入每次命令派发的热路径，服务正在挂载时也不能抛穿。
            try {
                return typeof optionalSessionController(ctx)?.updateQueue === 'function';
            }
            catch (err) {
                logger?.debug?.(`host adapter: sessionController 探测失败: ${errorMessage(err)}`);
                return false;
            }
        },
        async steerQueuedMessage(sessionId, itemId) {
            const outcome = await updateQueueAction(sessionId, itemId, { kind: 'steer' });
            if (outcome.ok)
                return { ok: true };
            if (outcome.code === 'session/queue-item-not-found')
                return { ok: false, reason: 'not-found' };
            if (outcome.code === 'session/steer-unavailable')
                return { ok: false, reason: 'steer-unavailable' };
            if (outcome.message !== undefined) {
                logger?.warn?.(`host adapter: sessionController.updateQueue(steer) 失败: ${outcome.message}`);
            }
            return {
                ok: false,
                reason: 'failed',
                ...(outcome.message === undefined ? {} : { message: outcome.message }),
            };
        },
        async removeQueuedMessage(sessionId, itemId) {
            const outcome = await updateQueueAction(sessionId, itemId, { kind: 'remove' });
            if (outcome.ok)
                return { ok: true };
            if (outcome.code === 'session/queue-item-not-found')
                return { ok: false, reason: 'not-found' };
            if (outcome.message !== undefined) {
                logger?.warn?.(`host adapter: sessionController.updateQueue(remove) 失败: ${outcome.message}`);
            }
            return {
                ok: false,
                reason: 'failed',
                ...(outcome.message === undefined ? {} : { message: outcome.message }),
            };
        },
        async listSessions() {
            try {
                const [records, meta] = await Promise.all([
                    query.listSessions(),
                    sessionListMeta(controller, logger),
                ]);
                return records
                    .map((record) => hostSessionFrom(record))
                    .filter((info) => info !== undefined)
                    .map((info) => {
                    const updatedAt = meta.recency.get(info.id);
                    return {
                        ...info,
                        ...(meta.blank.has(info.id) ? { blank: true } : {}),
                        ...(updatedAt === undefined ? {} : { updatedAt }),
                    };
                });
            }
            catch (err) {
                logger?.warn?.(`host adapter: sessionQuery.listSessions 失败: ${errorMessage(err)}`);
                return [];
            }
        },
        async sessionTitles(ids) {
            const titles = new Map();
            if (ids.length === 0)
                return titles;
            try {
                // 标题要读日志（每会话一次完整读取），失败只影响该条，绝不影响列表本身
                collectTitles(await query.readTitleSnapshots(ids), titles);
            }
            catch (err) {
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
            }
            catch (err) {
                return renameFailure(err);
            }
        },
        async archiveSession(sessionId) {
            const registry = registryNow();
            if (registry === undefined)
                return workspaceUnavailable('archive');
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
            const registry = registryNow();
            if (registry === undefined)
                return workspaceUnavailable('unarchive');
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
function renameFailure(err) {
    const name = err instanceof Error ? err.name : '';
    const message = errorMessage(err);
    if (name === 'SessionTitleInvalidError')
        return { ok: false, reason: 'invalid', message };
    if (/not\s+(?:live|active|open)|disposed|closed/i.test(message)) {
        return { ok: false, reason: 'not-live', message };
    }
    return { ok: false, reason: 'failed', message };
}
/** 部署里没有 workspaceRegistry：不归档，也不假装成功 */
function workspaceUnavailable(verb) {
    const action = verb === 'archive' ? '归档' : '取消归档';
    return { ok: false, reason: 'unavailable', message: `当前部署不支持${action}` };
}
/**
 * 把 registry 抛出的错误归一成归档结果。
 *
 * 识别按 `name` 而不是 instanceof：dsh-workspace 可能被宿主装成另一个副本，
 * 跨副本的 instanceof 恒假，按类名判定才稳。
 */
function archiveFailure(err, verb, sessionId) {
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
//# sourceMappingURL=adapter.js.map