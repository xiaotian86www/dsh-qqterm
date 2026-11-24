import { createQQUserMessage } from "../session/user-message.js";
import { isOwner, errorMessage } from "../shared/utils.js";
import { buildRetryKeyboard, formatRetryOffer } from "./retry-renderer.js";
import { decodeButtonData } from "./button-utils.js";
export class RetryChannel {
    /** 待确认的重发：sessionId → 状态（同一会话只留最新一张卡） */
    pending = new Map();
    /** 卡片 / 文本 + 非当前会话署名：署名规则只在 sender 里实现一次 */
    sender;
    config;
    logger;
    constructor(sender, config, logger) {
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
        const sessionId = record.sessionId;
        // 上一张卡还挂着：直接作废，避免两张卡都能点
        this.cancelPending(sessionId);
        let delivered = false;
        try {
            // 带按钮的正文 + 无按钮兜底一起交给 sender：键盘不可用时正文仍有下一步（发 /retry）
            await this.sender.card(record.replyTarget, this.sender.decorate(sessionId, formatRetryOffer(failure, retries, true)), buildRetryKeyboard(sessionId), this.sender.decorate(sessionId, formatRetryOffer(failure, retries, false)));
            delivered = true;
        }
        catch (err) {
            this.logger.error(`qqterm: retry notice send failed: ${errorMessage(err)}`);
        }
        // 降级成纯文本时不再有待确认状态：按钮不存在，等待也没有意义
        if (!delivered)
            return false;
        const timeoutMs = this.config.retryOffer.timeoutMs;
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
        // 重发卡也只认绑定用户：会话记录缺 peerId 时同样不能放行
        if (!isOwner(this.config.access.owner, peerId))
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
            void this.send(record, sessionId, '⚠️ 找不到上一条消息');
            return;
        }
        try {
            record.agent.followup(createQQUserMessage(prompt));
        }
        catch (err) {
            const message = errorMessage(err);
            this.logger.error(`qqterm: retry followup failed sessionId=${sessionId}: ${message}`);
            void this.send(record, sessionId, `⚠️ 重发失败: ${message}`);
            return;
        }
        this.logger.info(`qqterm: prompt resent via retry button sessionId=${sessionId}`);
        void this.send(record, sessionId, '✅ 已重发上一条消息');
    }
    onTimeout(sessionId) {
        const entry = this.pending.get(sessionId);
        if (!entry)
            return;
        this.pending.delete(sessionId);
        entry.timer = undefined;
        this.logger.debug(`qqterm: retry offer expired sessionId=${sessionId}`);
    }
    send(record, sessionId, body) {
        return this.sender
            .text(record.replyTarget, this.sender.decorate(sessionId, body))
            .then(() => { })
            .catch((err) => {
            this.logger.error(`qqterm: retry reply send failed: ${errorMessage(err)}`);
        });
    }
}
//# sourceMappingURL=retry-channel.js.map