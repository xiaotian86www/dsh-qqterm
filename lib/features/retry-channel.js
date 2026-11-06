import { createQQUserMessage } from "../session/user-message.js";
import { sessionSourceHeader } from "../transport/session-source.js";
import { buildRetryKeyboard, formatRetryOffer } from "./retry-renderer.js";
import { decodeButtonData } from "./button-utils.js";
/** 卡片默认有效期：10 分钟 */
const DEFAULT_OFFER_TIMEOUT_MS = 10 * 60 * 1000;
/** 记录所属的会话 id（优先宿主 sessionId） */
function sessionIdOf(record) {
    return record.sessionId ?? record.sessionKey;
}
export class RetryChannel {
    /** 待确认的重发：sessionId → 状态（同一会话只留最新一张卡） */
    pending = new Map();
    manager;
    sender;
    config;
    logger;
    constructor(manager, sender, config, logger) {
        this.manager = manager;
        this.sender = sender;
        this.config = config;
        this.logger = logger;
    }
    /** 是否启用（关闭时调用方直接发普通失败文案） */
    get enabled() {
        return this.config.retryOffer?.enabled !== false;
    }
    /**
     * 询问是否重发上一条消息。
     *
     * @returns true = 卡片（或降级文本）已送达；false = 没有可重发原文 / 未启用 / 发送失败，
     *          调用方应改发普通失败文案。
     */
    async offer(record, failure, retries) {
        if (!this.enabled)
            return false;
        const prompt = record.lastPrompt;
        if (prompt === undefined || prompt.trim() === '')
            return false;
        const sessionId = sessionIdOf(record);
        // 上一张卡还挂着：直接作废，避免两张卡都能点
        this.cancelPending(sessionId);
        let delivered = false;
        try {
            await this.sender.sendMarkdown(record.replyTarget, this.decorate(sessionId, formatRetryOffer(failure, retries, true)), {
                keyboard: buildRetryKeyboard(sessionId),
            });
            delivered = true;
        }
        catch (err) {
            // 键盘通道不可用时，正文仍然要有下一步（发 /retry），不能静默丢消息
            console.warn('[im-qqbot] retry keyboard send failed:', err);
            this.logger.warn(`im-qqbot: retry keyboard send failed, fallback to text: ${err instanceof Error ? err.message : String(err)}`);
            try {
                await this.sender.sendMarkdown(record.replyTarget, this.decorate(sessionId, formatRetryOffer(failure, retries, false)));
                delivered = true;
            }
            catch (fallbackErr) {
                this.logger.error(`im-qqbot: retry notice send failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
            }
        }
        // 降级成纯文本时不再有待确认状态：按钮不存在，等待也没有意义
        if (!delivered)
            return false;
        const timeoutMs = this.config.retryOffer?.timeoutMs ?? DEFAULT_OFFER_TIMEOUT_MS;
        if (timeoutMs > 0) {
            const timer = setTimeout(() => this.onTimeout(sessionId), timeoutMs);
            timer.unref?.();
            this.pending.set(sessionId, { record, timer });
        }
        return true;
    }
    /** 按钮点击：按 button_data 的 `s` 找会话，过期卡片 / 别人的卡片忽略 */
    handleInteraction(event) {
        const peerId = event.user_openid;
        if (!peerId)
            return false;
        const raw = event.data?.resolved?.button_data;
        if (!raw)
            return false;
        const button = decodeButtonData(raw);
        if (!button || button.t !== 'retry')
            return false;
        const sessionId = button.s;
        if (sessionId === undefined)
            return false;
        const entry = this.pending.get(sessionId);
        if (!entry)
            return false;
        if (entry.record.peerId !== undefined && entry.record.peerId !== peerId)
            return false;
        this.cancelPending(sessionId);
        if (button.d === 'discard') {
            void this.send(entry.record, sessionId, '✅ 已放弃重发');
            return true;
        }
        this.resend(entry.record, sessionId);
        return true;
    }
    /** 会话回收 / 卸载时清掉待确认状态，避免 timer 与闭包泄漏 */
    cancelPending(sessionId) {
        const entry = this.pending.get(sessionId);
        if (!entry)
            return;
        this.pending.delete(sessionId);
        if (entry.timer)
            clearTimeout(entry.timer);
    }
    /** 卸载：清掉全部待确认状态 */
    uninstall() {
        for (const [sessionId] of this.pending)
            this.cancelPending(sessionId);
    }
    /** 重发原文：唯一的「开新一轮」入口 */
    resend(record, sessionId) {
        const prompt = record.lastPrompt;
        if (prompt === undefined || prompt.trim() === '') {
            void this.send(record, sessionId, '⚠️ 找不到上一条消息\n重新发一条即可。');
            return;
        }
        try {
            record.agent.followup(createQQUserMessage(prompt));
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error(`im-qqbot: retry followup failed sessionId=${sessionId}: ${message}`);
            void this.send(record, sessionId, `⚠️ 重发失败: ${message}\n稍等片刻再发一次。`);
            return;
        }
        this.logger.info(`im-qqbot: prompt resent via retry button sessionId=${sessionId}`);
        void this.send(record, sessionId, '✅ 已重发上一条消息');
    }
    onTimeout(sessionId) {
        const entry = this.pending.get(sessionId);
        if (!entry)
            return;
        this.pending.delete(sessionId);
        entry.timer = undefined;
        this.logger.debug(`im-qqbot: retry offer expired sessionId=${sessionId}`);
    }
    /** 会话内提示：非当前会话加来源行（与问答 / 审批同一套标记） */
    decorate(sessionId, body) {
        if (this.manager.isCurrentSession?.(sessionId) ?? true)
            return body;
        return `${sessionSourceHeader(sessionId, this.manager.sessionTitle?.(sessionId))}\n\n${body}`;
    }
    send(record, sessionId, body) {
        return this.sender
            .sendMarkdown(record.replyTarget, this.decorate(sessionId, body))
            .then(() => { })
            .catch((err) => {
            this.logger.error(`im-qqbot: retry reply send failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
}
//# sourceMappingURL=retry-channel.js.map