import { chunkMarkdownText, splitForLimit } from "./chunker.js";
import { classifyDeliveryError } from "./outbox.js";
import { decorateSessionMessage } from "./session-source.js";
import { errorMessage } from "../shared/utils.js";
/** 风控拦截后的替代文案（只发一次） */
const BLOCKED_NOTICE = '❌ 上一条消息被 QQ 拦截，未送达。原文见 Web 会话。';
/** 一次发送的失败分类：只对网络类重试，其它原样抛给调用方 */
async function sendOnceWithRetry(run) {
    try {
        await run();
    }
    catch (err) {
        if (classifyDeliveryError(err) !== 'transient')
            throw err;
        await run();
    }
}
/**
 * 分片发送（命令回复 / 公告共用）：按 markdown 结构切，网络类失败重试一次。
 *
 * 导出给斜杠命令用：命令拿不到 Sender（SDK 只注入 bot 与 replyTarget），
 * 但切分与重试必须是同一份实现。
 */
export async function sendChunkedText(bot, target, body, limit) {
    if (body === '')
        return;
    for (const chunk of chunkMarkdownText(body, limit)) {
        await sendOnceWithRetry(() => bot.sendMarkdown(target, chunk));
    }
}
/** 组装发送端口：持有 bot、切分上限、会话视图与失败队列 */
export function createSender(options) {
    const { bot, config, logger, sessions, outbox } = options;
    const decorate = (sessionId, body) => (sessions.isCurrent(sessionId)
        ? body
        : decorateSessionMessage(body, sessionId, sessions.titleOf(sessionId), sessions.canArchive(), sessions.isRunning?.(sessionId) ?? false));
    const text = async (target, body) => {
        await sendChunkedText(bot, target, body, config.textChunkLimit);
    };
    /**
     * 会话输出：
     *   - 非当前会话先署名，再按上限切分（切分点感知 qqbot-cmd-input 标签）；
     *   - 每片交给 Outbox：网络抖动重试一次、仍失败入队并停发后续分片；
     *   - 超长按本条长度减半重切；风控拦截只发一次替代文案。
     */
    const session = async (sessionId, target, body, tag) => {
        if (body === '')
            return;
        const composed = decorate(sessionId, body);
        const queue = splitForLimit(composed, config.textChunkLimit);
        const send = (value) => bot.sendMarkdown(target, value);
        let blockedNotified = false;
        while (queue.length > 0) {
            const part = queue.shift();
            const outcome = await outbox.deliver(sessionId, tag, () => send(part));
            // 暂不可用：本条与后续分片一起排队，恢复后按原顺序补发
            if (outcome === 'queued') {
                for (const rest of queue)
                    outbox.enqueue(sessionId, tag, () => send(rest));
                return;
            }
            // 渠道判死：后续分片已经没有任何意义
            if (outcome === 'broken')
                return;
            if (outcome === 'sent')
                continue;
            // 内容类失败：超长按本条长度减半重切，风控只告知一次
            if (outcome === 'too-long') {
                const smaller = splitForLimit(part, Math.floor(part.length / 2));
                if (smaller.length > 1) {
                    queue.unshift(...smaller);
                    continue;
                }
            }
            if (!blockedNotified) {
                blockedNotified = true;
                await outbox.deliver(sessionId, 'sendBlockedNotice', () => send(BLOCKED_NOTICE));
            }
        }
    };
    const card = async (target, body, keyboard, fallbackBody) => {
        try {
            await bot.sendMarkdown(target, body, { keyboard });
        }
        catch (err) {
            if (fallbackBody === undefined)
                throw err;
            // 键盘通道不可用时正文仍要有下一步（例如「发 /retry」），不能静默丢消息
            logger.warn('qqterm: keyboard send failed, fallback to text: '
                + (errorMessage(err)));
            await text(target, fallbackBody);
        }
    };
    return {
        text,
        session,
        card,
        decorate,
        flush: () => outbox.flush(),
        clear: () => outbox.clear(),
        hasPending: (sessionId) => outbox.hasPending(sessionId),
    };
}
//# sourceMappingURL=send.js.map