import { getScopePeer } from "../shared/index.js";
import { shortSessionId } from "../shared/utils.js";
import { sessionTitleOf, sourceTitle, steeredPromptReceipt, unqueuedPromptReceipt, } from "../transport/session-source.js";
import { sendMarkdownChunked } from "../shared/send-helper.js";
import { ArgError, parseArgs, parseRest } from "./args.js";
import { matchSessionTarget } from "./sessions.js";
import { unavailableCommandReply } from "./availability.js";
/**
 * 中止成功的回执：`⛔ 已中止「标题」 · #短id`，取不到标题时只给 id。
 *
 * 命令的字符串回复按纯文本发出、不渲染 markdown，所以这里不包反引号（正文版
 * 才包）；标题经 `sourceTitle` 压成一行并截断，避免撑破反馈行数。
 */
function cancelledReceipt(record) {
    const id = `#${shortSessionId(record.sessionId)}`;
    const title = sessionTitleOf(record);
    return title === undefined ? `⛔ 已中止 ${id}` : `⛔ 已中止「${sourceTitle(title)}」 · ${id}`;
}
/** /stop — 中止当前生成；`/stop <id>` 中止指定会话；`/stop all` 中止全体（隐藏） */
export function stopCommand({ manager }) {
    return {
        name: 'stop',
        scope: 'all',
        description: '中止生成',
        hidden: true,
        usage: [
            '### 📖 /stop 用法',
            '',
            '`/stop` 中止当前生成',
            '`/stop <id>` 中止指定会话',
            '`/stop all` 中止全部生成',
            '',
            '排队中的消息一并丢弃；只想插队用 /steer',
            '目标用 8 位短 id（行首 `#` 后那串）',
        ].join('\n'),
        handler: (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const arg = parseRest(cmdCtx.command?.raw ?? '');
            if (arg === '') {
                const record = manager.getSessionRecord(scope, peerId);
                // 会话存在不等于正在生成：只有 agent 处于 running 才算有进行中的回复
                if (record === undefined || record.agent.status !== 'running') {
                    return '⚠️ 当前没有进行中的生成';
                }
                // cancel 会让当前轮以 turn/end (kind=interrupted) 收尾，
                // 出站侧据此收尾本轮并投递已生成内容。
                record.agent.cancel({ kind: 'user' });
                return '⛔ 已中止';
            }
            if (arg.toLowerCase() === 'all') {
                const cancelled = manager.cancelAllRunning();
                return cancelled.length === 0
                    ? '⚠️ 当前没有进行中的生成'
                    : `⛔ 已中止 ${cancelled.length} 个会话`;
            }
            // 目标可以是任何一个已获取会话，不限于当前指针；匹配规则与 /sessions 同一份
            const candidates = manager.listAcquiredSessions().map((record) => ({
                id: record.sessionId,
                record,
            }));
            const target = matchSessionTarget(candidates, arg);
            if (!target.ok) {
                return `⚠️ ${target.error} · 用 /sessions 查看会话`;
            }
            const { record } = target.entry;
            if (record.agent.status !== 'running') {
                return `⚠️ 没有进行中的生成 · #${shortSessionId(record.sessionId)}`;
            }
            record.agent.cancel({ kind: 'user' });
            return cancelledReceipt(record);
        },
    };
}
/**
 * /steer 与 /unqueue 共用的目标解析。
 *
 * 0 段取当前会话；1-2 段先按 /sessions 的同一份规则匹配已获取会话，第二段
 * 原样当消息 id。两段以上在调用方先回绝。
 */
function resolveQueuedTarget(manager, scope, peerId, words) {
    if (words.length === 0) {
        const record = manager.getSessionRecord(scope, peerId);
        return record === undefined
            ? { ok: false, text: '⚠️ 当前没有会话 · 用 /sessions 恢复' }
            : { ok: true, record };
    }
    // 目标可以是任何一个已获取会话，不限于当前指针；匹配规则与 /sessions 同一份
    const candidates = manager.listAcquiredSessions().map((entry) => ({
        id: entry.sessionId,
        record: entry,
    }));
    const target = matchSessionTarget(candidates, words[0]);
    if (!target.ok)
        return { ok: false, text: `⚠️ ${target.error} · 用 /sessions 查看会话` };
    const exactId = words[1];
    return {
        ok: true,
        record: target.entry.record,
        ...(exactId === undefined ? {} : { exactId }),
    };
}
/**
 * /steer — 把一条仍在排队的 prompt 改成插话（下一步消费）
 *
 * 只改落点，不中止当前生成、不写当前指针。消息 id 由排队回执带过来，
 * 手输时省略则取该会话最近一条排队消息。
 */
export function steerCommand({ manager, config }) {
    return {
        name: 'steer',
        scope: 'all',
        // sessionController 可能晚于插件挂载；每次现查，不在构造期固化缺失
        available: () => manager.canMutateQueue(),
        description: '插话排队消息',
        usage: [
            '### 📖 /steer 用法',
            '',
            '/steer 插话当前会话最近一条排队消息',
            '/steer <id> 插话指定会话最近一条排队消息',
            '/steer <id> <消息id> 插话指定的那条消息',
            '',
            '只改落点，不中止当前生成；目标用 8 位短 id',
        ].join('\n'),
        handler: async (cmdCtx) => {
            // SDK 的命令表是注册期快照：能力翻转到不可用时由 handler 自己按未知指令回绝
            if (!manager.canMutateQueue())
                return unavailableCommandReply(cmdCtx, 'steer');
            const { scope, peerId } = getScopePeer(cmdCtx);
            let parsed;
            try {
                parsed = parseArgs(cmdCtx.command?.raw ?? '', { command: 'steer' });
            }
            catch (error) {
                if (error instanceof ArgError)
                    return error.message;
                throw error;
            }
            const words = parsed.words;
            if (words.length > 2)
                return '⚠️ 参数过多 · 用法: /help steer';
            const target = resolveQueuedTarget(manager, scope, peerId, words);
            if (!target.ok)
                return target.text;
            const { record, exactId } = target;
            let itemId;
            const { agent } = record;
            const short = `#${shortSessionId(record.sessionId)}`;
            const queued = agent.inbox.nextTurn;
            const stepping = agent.inbox.nextStep;
            if (exactId !== undefined) {
                // 已经插过的不重复提交：队列项已被移到 next-step
                if (stepping.some((item) => item.id === exactId))
                    return `✅ 已经插话 · ${short}`;
                if (!queued.some((item) => item.id === exactId)) {
                    return '⚠️ 这条消息已不在队列';
                }
                if (agent.status !== 'running') {
                    return '⚠️ 本轮已结束 · 排队消息会继续发送';
                }
                itemId = exactId;
            }
            else {
                if (queued.length === 0)
                    return `⚠️ 没有排队消息 · ${short}`;
                if (agent.status !== 'running') {
                    return '⚠️ 本轮已结束 · 排队消息会继续发送';
                }
                itemId = queued[queued.length - 1].id;
            }
            const outcome = await manager.steerQueued(record.sessionId, itemId);
            if (outcome.ok) {
                const text = steeredPromptReceipt(record.sessionId, sessionTitleOf(record), manager.isCurrentSession(record.sessionId));
                // 命令的字符串回复按纯文本发出；非当前会话的署名行带反引号，走 markdown
                if (manager.isCurrentSession(record.sessionId))
                    return text;
                await sendMarkdownChunked(cmdCtx, text, config.textChunkLimit);
                return { kind: 'noop' };
            }
            if (outcome.reason === 'not-found')
                return '⚠️ 这条消息已不在队列';
            if (outcome.reason === 'steer-unavailable') {
                return '⚠️ 本轮已结束 · 排队消息会继续发送';
            }
            return '❌ 插话失败';
        },
    };
}
/**
 * /unqueue — 取消一条仍在排队的 prompt
 *
 * 只删这一条，不中止当前生成、不写当前指针。消息 id 由排队回执带过来；
 * 手输时省略则取消该会话最近一条排队消息。
 */
export function unqueueCommand({ manager, config }) {
    return {
        name: 'unqueue',
        scope: 'all',
        // sessionController 可能晚于插件挂载；每次现查，不在构造期固化缺失
        available: () => manager.canMutateQueue(),
        description: '取消排队消息',
        usage: [
            '### 📖 /unqueue 用法',
            '',
            '/unqueue 取消当前会话最近一条排队消息',
            '/unqueue <id> 取消指定会话最近一条排队消息',
            '/unqueue <id> <消息id> 取消指定的那条消息',
            '',
            '只删这一条，不中止当前生成；目标用 8 位短 id',
        ].join('\n'),
        handler: async (cmdCtx) => {
            // SDK 的命令表是注册期快照：能力翻转到不可用时由 handler 自己按未知指令回绝
            if (!manager.canMutateQueue())
                return unavailableCommandReply(cmdCtx, 'unqueue');
            const { scope, peerId } = getScopePeer(cmdCtx);
            let parsed;
            try {
                parsed = parseArgs(cmdCtx.command?.raw ?? '', { command: 'unqueue' });
            }
            catch (error) {
                if (error instanceof ArgError)
                    return error.message;
                throw error;
            }
            const words = parsed.words;
            if (words.length > 2)
                return '⚠️ 参数过多 · 用法: /help unqueue';
            const target = resolveQueuedTarget(manager, scope, peerId, words);
            if (!target.ok)
                return target.text;
            const { record, exactId } = target;
            const { agent } = record;
            const short = `#${shortSessionId(record.sessionId)}`;
            const queued = agent.inbox.nextTurn;
            const stepping = agent.inbox.nextStep;
            let itemId;
            if (exactId !== undefined) {
                // 已经插话的队列项已移到 next-step，撤不回来
                if (stepping.some((item) => item.id === exactId)) {
                    return '⚠️ 这条消息已插话 · 不能取消';
                }
                if (!queued.some((item) => item.id === exactId)) {
                    return '⚠️ 这条消息已不在队列';
                }
                itemId = exactId;
            }
            else {
                if (queued.length === 0)
                    return `⚠️ 没有排队消息 · ${short}`;
                itemId = queued[queued.length - 1].id;
            }
            const outcome = await manager.removeQueued(record.sessionId, itemId);
            if (outcome.ok) {
                const text = unqueuedPromptReceipt(record.sessionId, sessionTitleOf(record), manager.isCurrentSession(record.sessionId));
                // 命令的字符串回复按纯文本发出；非当前会话的署名行带反引号，走 markdown
                if (manager.isCurrentSession(record.sessionId))
                    return text;
                await sendMarkdownChunked(cmdCtx, text, config.textChunkLimit);
                return { kind: 'noop' };
            }
            if (outcome.reason === 'not-found')
                return '⚠️ 这条消息已不在队列';
            return '❌ 取消失败';
        },
    };
}
//# sourceMappingURL=misc.js.map