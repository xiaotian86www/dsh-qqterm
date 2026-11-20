import { changedEntries, createSettledWatch, entryReplaced, entryUids, errorText, resolveProfileDir, } from "../shared/index.js";
import { describeReloadState, readReloadState, reloadStatePath, writeReloadState, } from "./state.js";
/** 本插件在组合里的 entry id（bundle patch 与用户配置都按它定位，是兼容契约） */
const ENTRY_ID = 'qqterm';
/** 回复之后再重载：给被动回复留出送达时间 */
const RELOAD_DELAY_MS = 200;
/** 超过这个时长的记录不再播报（避免下次正常重启时冒出陈旧通知） */
const STALE_MS = 600_000;
/** 结论晚于 ready 落盘时的轮询间隔（与插件安装的轮询同一套节奏） */
const POLL_MS = 2_000;
/**
 * 在「不在 HMR 事务里」的上下文执行。
 *
 * 本插件若是上一轮重载装进来的，它整个 async 上下文都继承了 `executing = true`
 * （fiber 是在事务里创建的），再调 `runExclusive` 就会被判成嵌套事务。
 * `exit()` 临时清掉这个继承值，新事务才开得起来。
 */
function outsideTransaction(hmr, operation) {
    const executing = hmr.executing;
    if (executing === undefined || typeof executing.exit !== 'function')
        return operation();
    return Promise.resolve(executing.exit(operation));
}
/** 提交一次重载；拿不到 executing 又撞上嵌套时，退化成直接调用（此时已在事务上下文里） */
async function reloadOnce(hmr) {
    try {
        return await outsideTransaction(hmr, () => hmr.runExclusive(async () => hmr.reconcileProfile()));
    }
    catch (err) {
        if (err instanceof Error && err.message.includes('cannot be nested'))
            return await hmr.reconcileProfile();
        throw err;
    }
}
export function createReloader(ctx, logger, options) {
    const services = ctx;
    /**
     * 按需读服务：hmr 可能晚于本插件的 apply 才注册，启动时快照会误判成不可用。
     * 本插件被换掉之后旧 ctx 不可再访问，所以 run() 入口处取一次并持有到调度结束。
     */
    const service = (name) => services.get?.(name);
    const statePath = options?.statePath ?? reloadStatePath(resolveProfileDir(ctx));
    const notify = options?.notify;
    /**
     * 结果投递串行化：新 fiber 的 ready 补发与「下次命令前补发」可能同时触发，
     * 两条都会把上一轮的结果发一遍。后到的那条直接让位，先到的负责送达。
     */
    let delivering = false;
    /** 发结果通知；成功才清 notify，失败留给下一个 ready 重试 */
    const deliver = async (bot, state) => {
        if (delivering)
            return;
        const notice = state.notify;
        if (notice === undefined || notice.targetId === '')
            return;
        if (Date.now() - state.startedAt > STALE_MS) {
            writeReloadState(statePath, { ...state, notify: undefined }, logger);
            return;
        }
        const text = resultText(state);
        if (text === undefined)
            return;
        delivering = true;
        try {
            // 被动回复凭证由 ReplyStore 提供（msg_id 已落盘），这里只给投递目标
            // 注入过 notify 就走统一发送端口（分片 + 网络类重试）；命令层没有 sender 时退回原样
            const send = notify ?? ((target, body) => bot.sendMarkdown(target, body));
            await send({ scope: 'c2c', targetId: notice.targetId }, text);
            // 只清这一轮的 notify：发送期间可能已有新一轮写下了自己的通知
            const latest = readReloadState(statePath, logger);
            if (latest !== undefined && latest.startedAt === state.startedAt) {
                writeReloadState(statePath, { ...latest, notify: undefined }, logger);
            }
        }
        catch (err) {
            logger.warn(`热重载结果通知失败: ${errorText(err)}`);
        }
        finally {
            delivering = false;
        }
    };
    /** 结论晚于 ready 落盘：后台等它，最长等到陈旧线 */
    const watch = createSettledWatch({
        pollMs: POLL_MS,
        staleMs: STALE_MS,
        read: () => readReloadState(statePath, logger),
        write: (state) => writeReloadState(statePath, state, logger),
        expire: (state) => ({ ...state, phase: 'failed', error: '重载超时' }),
        logger,
    });
    return {
        get available() {
            return service('hmr') !== undefined;
        },
        run(notice, bot) {
            const startedAt = Date.now();
            const hmr = service('hmr');
            const loader = service('loader');
            const before = entryUids(loader);
            // 先只记「往哪回」：结论要等 reconcile 跑完才知道，写在这里的就是待补发记录
            writeReloadState(statePath, {
                startedAt,
                ...(notice === undefined ? {} : { notify: notice }),
            }, logger);
            if (hmr === undefined)
                return;
            // 脱离当前 fiber：命令处理器返回后这个 fiber 就会被 dispose
            const timer = setTimeout(() => {
                void reloadOnce(hmr)
                    .then(async (result) => {
                    const after = entryUids(loader);
                    const replaced = changedEntries(before, after);
                    const done = {
                        phase: 'done',
                        startedAt,
                        ...(notice === undefined ? {} : { notify: notice }),
                        ...(replaced === undefined ? {} : { replaced }),
                        ...(result.restartReason === undefined ? {} : { restartReason: result.restartReason }),
                    };
                    writeReloadState(statePath, done, logger);
                    // 自己没被换掉就没有新的 ready，只能由当前实例补发
                    if (bot !== undefined && entryReplaced(before, after, ENTRY_ID) !== true)
                        await deliver(bot, done);
                })
                    .catch((err) => {
                    const after = entryUids(loader);
                    const replaced = changedEntries(before, after);
                    const failed = {
                        phase: 'failed',
                        startedAt,
                        ...(notice === undefined ? {} : { notify: notice }),
                        ...(replaced === undefined ? {} : { replaced }),
                        error: errorText(err),
                    };
                    writeReloadState(statePath, failed, logger);
                    logger.warn(`插件热重载失败: ${errorText(err)}`);
                    if (bot !== undefined && entryReplaced(before, after, ENTRY_ID) !== true)
                        void deliver(bot, failed);
                });
            }, RELOAD_DELAY_MS);
            timer.unref?.();
        },
        describe() {
            return describeReloadState(readReloadState(statePath, logger));
        },
        async announce(bot) {
            const state = readReloadState(statePath, logger);
            if (state === undefined || state.notify === undefined)
                return;
            // 结论还没落盘：交给后台轮询，别在 ready / 命令路径上等
            if (state.phase === undefined && Date.now() - state.startedAt <= STALE_MS) {
                watch(state.startedAt, (settled) => deliver(bot, settled));
                return;
            }
            await deliver(bot, state);
        },
    };
}
/**
 * 结果文案：一行结论，必要时再补一行下一步。
 *
 * 三种结论分别对应「换掉了谁」「什么都没换」「判不出来」，别把它们合成一句话：
 * 用户要靠这个区分「命令跑了但白跑」和「真的有新代码生效」。
 */
function resultText(state) {
    if (state.phase === 'failed') {
        return state.error === undefined
            ? '❌ 重载失败，重启 dsh 恢复'
            : `❌ 重载失败: ${state.error}\n重启 dsh 恢复。`;
    }
    if (state.phase !== 'done')
        return undefined;
    const applied = describeApplied(state.replaced);
    if (state.restartReason === undefined)
        return applied;
    return `${applied}\n⚠️ 部分改动需重启 dsh 才生效`;
}
/** 「应用了什么」：区分「有替换」与「没有任何变化」 */
function describeApplied(replaced) {
    if (replaced === undefined)
        return '✅ 已应用变更';
    if (replaced.length === 0)
        return '✅ 没有需要应用的变更';
    const names = replaced.slice(0, 3).join(' · ');
    return replaced.length > 3
        ? `✅ 已应用变更: ${names} 等 ${replaced.length} 个`
        : `✅ 已应用变更: ${names}`;
}
//# sourceMappingURL=index.js.map