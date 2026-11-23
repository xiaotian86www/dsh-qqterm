import { createSettledWatch, entryReplaced, entryUids, errorText, outsideHmrTransaction, resolveProfileDir, } from "../shared/index.js";
import { describePluginOpState, pluginOpStatePath, pluginUpdateCachePath, readPluginOpState, readPluginUpdateCache, writePluginOpState, writePluginUpdateCache, } from "./state.js";
import { pickLatestVersion, renderPluginResult } from "./format.js";
/** 本插件在组合里的 entry id（与 bundle patch 的 entry id 一致） */
const ENTRY_ID = 'qqterm';
/** 回执之后再开工：给被动回复留出送达时间 */
const OP_DELAY_MS = 200;
/** 超过这个时长的记录不再当作「进行中」（陈旧记录只播报一次失败） */
const STALE_MS = 600_000;
/** 结果轮询间隔（reconcile 通常在一秒内落盘） */
const POLL_MS = 2_000;
/** 带原因码的拒绝：宿主的 listVersions 用返回值表达，这里统一成异常便于收口 */
class PluginRefusal extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** 安装结果 → 状态字段 */
function installOutcome(result) {
    if (result.pendingBuilds !== undefined && result.pendingBuilds.length > 0) {
        return { phase: 'failed', code: 'pending-builds', pendingBuilds: [...result.pendingBuilds] };
    }
    if (result.application === 'failed') {
        return { phase: 'failed', code: result.error?.code, error: result.error?.diagnostic };
    }
    if (result.application === 'cancelled')
        return { phase: 'failed', code: 'cancelled' };
    return {
        phase: 'done',
        application: result.application,
        version: result.version,
        ...(result.bundle === undefined ? {} : { name: result.bundle }),
    };
}
/** 更新结果 → 状态字段 */
function updateOutcome(outcome) {
    if (outcome.kind === 'up-to-date') {
        return { phase: 'done', upToDate: true, version: outcome.version };
    }
    const { from, to, result, restore } = outcome.value;
    const rolledBack = restore?.application === 'applied';
    if (result.application === 'failed') {
        return { phase: 'failed', from, to, code: result.error?.code, error: result.error?.diagnostic, rolledBack };
    }
    if (result.application === 'cancelled') {
        return { phase: 'failed', from, to, code: 'cancelled', rolledBack };
    }
    return { phase: 'done', from, to, application: result.application, version: to };
}
export function createPluginInstaller(ctx, logger, options) {
    const services = ctx;
    const manager = services.get?.('pluginManager');
    // 提前抓 loader：本插件被换掉之后旧 ctx 就不可再访问，而 loader 属于宿主
    const loader = services.get?.('loader');
    const statePath = options?.statePath ?? pluginOpStatePath(resolveProfileDir(ctx));
    const notify = options?.notify;
    const updatesPath = options?.updatesPath ?? pluginUpdateCachePath(resolveProfileDir(ctx));
    /** 结果投递串行化：新 fiber 的 ready 与「下一条命令前补发」可能同时触发 */
    let delivering = false;
    /** 发结果通知；成功才清 notify，失败留给下一次 ready 重试 */
    const deliver = async (bot, state) => {
        if (delivering)
            return;
        const notice = state.notify;
        if (notice === undefined || notice.targetId === '')
            return;
        const text = renderPluginResult(state);
        if (text === undefined)
            return;
        delivering = true;
        try {
            // 被动回复凭证由 ReplyStore 提供（msg_id 已落盘），这里只给投递目标
            // 注入过 notify 就走统一发送端口（分片 + 网络类重试）；命令层没有 sender 时退回原样
            const send = notify ?? ((target, body) => bot.sendMarkdown(target, body));
            await send({ scope: 'c2c', targetId: notice.targetId }, text);
            // 只清这一轮的 notify：发送期间可能已有新一轮写下了自己的通知
            const latest = readPluginOpState(statePath, logger);
            if (latest !== undefined && latest.startedAt === state.startedAt) {
                writePluginOpState(statePath, { ...latest, notify: undefined }, logger);
            }
        }
        catch (err) {
            logger.warn(`插件操作结果通知失败: ${errorText(err)}`);
        }
        finally {
            delivering = false;
        }
    };
    /**
     * 后台等结果：reconcile 在 install 返回前完成，新 fiber 的 ready 常早于落盘，
     * 所以看到「还在跑」不能直接放弃。只等自己这一轮（startedAt 变了就让位）。
     */
    const watch = createSettledWatch({
        pollMs: POLL_MS,
        staleMs: STALE_MS,
        read: () => readPluginOpState(statePath, logger),
        write: (state) => writePluginOpState(statePath, state, logger),
        expire: (state) => ({ ...state, phase: 'failed', code: 'timeout' }),
        logger,
    });
    /** 解析更新目标：没给版本时问 registry，选一个可升级的版本 */
    const resolveUpdate = async (request) => {
        if (manager === undefined)
            throw new PluginRefusal('operation-error', '当前 profile 没有插件管理能力');
        let version = request.version;
        if (version === undefined) {
            const list = await manager.listVersions(request.target);
            if (list.status === 'refused')
                throw new PluginRefusal(list.problem, list.reason);
            const picked = pickLatestVersion(list.versions);
            if (picked === undefined)
                return { kind: 'up-to-date', version: list.installed };
            version = picked.version;
        }
        return { kind: 'result', value: await manager.updateBundle(request.target, version) };
    };
    /** 装到新版本后把该包从「可更新」缓存里划掉，等下一轮检查重新判断 */
    const forgetUpdate = (name) => {
        const cache = readPluginUpdateCache(updatesPath, logger);
        if (cache === undefined || cache.versions[name] === undefined)
            return;
        const versions = { ...cache.versions };
        delete versions[name];
        writePluginUpdateCache(updatesPath, { checkedAt: cache.checkedAt, versions }, logger);
    };
    /** 真正干活：先落状态，再决定由谁补发结果 */
    const execute = async (request, startedAt, before, bot) => {
        if (manager === undefined) {
            const failed = {
                startedAt,
                action: request.action,
                target: request.target,
                phase: 'failed',
                code: 'operation-error',
                error: '当前 profile 没有插件管理能力',
            };
            writePluginOpState(statePath, failed, logger);
            if (bot !== undefined)
                await deliver(bot, failed);
            return;
        }
        let extra;
        try {
            extra = request.action === 'install'
                ? installOutcome(await outsideHmrTransaction(ctx, () => manager.installBundle(request.spec ?? request.target, {
                    ...(request.approvedBuilds === undefined || request.approvedBuilds.length === 0
                        ? {}
                        : { approvedBuilds: request.approvedBuilds }),
                })))
                : updateOutcome(await outsideHmrTransaction(ctx, () => resolveUpdate(request)));
        }
        catch (err) {
            extra = err instanceof PluginRefusal
                ? { phase: 'failed', code: err.code, error: err.message }
                : { phase: 'failed', code: 'operation-error', error: errorText(err) };
        }
        const state = {
            startedAt,
            action: request.action,
            target: request.target,
            ...(request.notify === undefined ? {} : { notify: request.notify }),
            ...extra,
        };
        writePluginOpState(statePath, state, logger);
        if (state.phase === 'done')
            forgetUpdate(state.name ?? request.target);
        const after = entryUids(loader);
        if (bot !== undefined && entryReplaced(before, after, ENTRY_ID) !== true) {
            await deliver(bot, state);
        }
    };
    return {
        async list() {
            if (manager === undefined)
                throw new Error('当前 profile 没有插件管理能力');
            return await manager.listBundles();
        },
        async find(name) {
            if (manager === undefined)
                return undefined;
            const bundles = await manager.listBundles();
            return bundles.find((bundle) => bundle.name === name);
        },
        pending() {
            const state = readPluginOpState(statePath, logger);
            if (state === undefined || state.phase !== undefined)
                return undefined;
            if (Date.now() - state.startedAt > STALE_MS)
                return undefined;
            return state;
        },
        run(request, bot) {
            const startedAt = Date.now();
            const before = entryUids(loader);
            // 先只记「在装什么、往哪回」：结论要等宿主返回才知道，写在这里的是待补发记录
            writePluginOpState(statePath, {
                startedAt,
                action: request.action,
                target: request.target,
                ...(request.notify === undefined ? {} : { notify: request.notify }),
            }, logger);
            // 脱离当前 fiber：命令处理器返回后这个 fiber 可能被 reconcile 掉
            const timer = setTimeout(() => {
                void execute(request, startedAt, before, bot).catch((err) => {
                    logger.warn(`插件操作执行失败: ${errorText(err)}`);
                });
            }, OP_DELAY_MS);
            timer.unref?.();
        },
        describe() {
            return describePluginOpState(readPluginOpState(statePath, logger));
        },
        updates() {
            return readPluginUpdateCache(updatesPath, logger);
        },
        async checkUpdates() {
            if (manager === undefined)
                return { checked: 0, versions: {}, failed: [] };
            const bundles = await manager.listBundles();
            // 旧结果只用来兜单个包的查询失败，不能整体沿用：退装的包要消失
            const previous = readPluginUpdateCache(updatesPath, logger)?.versions ?? {};
            const versions = {};
            const failed = [];
            let checked = 0;
            for (const bundle of bundles) {
                // 只有 registry 安装的包能由 listVersions 查新版本；本地 tgz / 目录、Git 安装都没有 update
                if (!bundle.installed || bundle.official || bundle.update !== 'registry')
                    continue;
                checked += 1;
                try {
                    const list = await manager.listVersions(bundle.name);
                    if (list.status !== 'listed') {
                        // 查不到不等于没有更新：沿用上一轮已知结果，并把这一包记为没查通
                        const kept = previous[bundle.name];
                        if (kept !== undefined)
                            versions[bundle.name] = kept;
                        failed.push(bundle.name);
                        logger.debug(`跳过插件更新检查 (${bundle.name}): ${list.problem}`);
                        continue;
                    }
                    const picked = pickLatestVersion(list.versions);
                    if (picked !== undefined)
                        versions[bundle.name] = picked.version;
                }
                catch (err) {
                    const kept = previous[bundle.name];
                    if (kept !== undefined)
                        versions[bundle.name] = kept;
                    failed.push(bundle.name);
                    logger.debug(`检查插件更新失败 (${bundle.name}): ${errorText(err)}`);
                }
            }
            writePluginUpdateCache(updatesPath, { checkedAt: Date.now(), versions }, logger);
            return { checked, versions, failed };
        },
        async announce(bot) {
            const state = readPluginOpState(statePath, logger);
            if (state === undefined || state.notify === undefined)
                return;
            if (state.phase === undefined) {
                if (Date.now() - state.startedAt > STALE_MS) {
                    const failed = { ...state, phase: 'failed', code: 'timeout' };
                    writePluginOpState(statePath, failed, logger);
                    await deliver(bot, failed);
                    return;
                }
                // 结论还没落盘：后台轮询，不阻塞命令处理
                watch(state.startedAt, (settled) => deliver(bot, settled));
                return;
            }
            await deliver(bot, state);
        },
    };
}
//# sourceMappingURL=index.js.map