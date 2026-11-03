import { parseAnswer } from "./answer-parser.js";
import { buildKeyboard, formatQuestion } from "./question-renderer.js";
import { decodeButtonData } from "./button-utils.js";
// ── 错误语义（对齐 dsh-user-questions 的 UserQuestionError code 约定） ──
/** 问答中断错误码：上层（如 plan-mode）按 code 区分「用户未作答」与普通发送/网络错误 */
const ASK_ABORTED = 'ASK_ABORTED';
class QuestionChannelError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'QuestionChannelError';
    }
}
/**
 * QQ 投递失败（发送接口报错）。
 *
 * 与「用户没答/超时」区分：只有投递失败才允许退回 `next()` 交给 Web 端，
 * 已送达的问题再退回会导致同一个问题在两个通道各弹一次。
 */
class QuestionDeliveryError extends Error {
    constructor(message) {
        super(message);
        this.name = 'QuestionDeliveryError';
    }
}
export class QuestionChannel {
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
    /**
     * 注册 `user-questions/request` waterfall answerer。
     *
     * 不探测服务是否存在：seam 未挂载时不会有请求到达，监听本身无副作用。
     * `global` 必需——该事件按 agent 作用域派发，根作用域监听器不带 global 会被
     * 过滤掉；`prepend` 让 QQ 先于 Web 端 answerer 取得请求。
     *
     * @param ctx 宿主上下文（只需 on）
     */
    install(ctx) {
        const self = this;
        ctx.on('user-questions/request', (req, next) => {
            const request = req;
            const nextFn = next;
            const sessionId = request.agent?.id;
            const record = sessionId ? self.manager.findBySessionId(sessionId) : undefined;
            if (!record)
                return nextFn();
            // 投递失败才退回 Web：已送达的问题不能再次弹出（见 QuestionDeliveryError）
            return self.askViaQQ(record, request).catch((err) => {
                if (err instanceof QuestionDeliveryError) {
                    self.logger.warn(`im-qqbot: QQ question delivery failed, falling back to the host answerer: ${err.message}`);
                    return nextFn();
                }
                throw err;
            });
        }, { global: true, prepend: true });
        this.logger.info('im-qqbot: QQ question channel installed (user-questions/request)');
    }
    uninstall() {
        for (const [, entry] of this.pending) {
            this.clearTimer(entry);
            this.removeAbort(entry);
            entry.reject(new QuestionChannelError('QQ question channel was unloaded before the user answered', ASK_ABORTED));
        }
        this.pending.clear();
    }
    /** 会话回收时清理其待答问题，避免 pending 悬挂导致 Promise 与闭包泄漏 */
    cancelPending(sessionKey) {
        const entry = this.pending.get(sessionKey);
        if (!entry)
            return;
        this.pending.delete(sessionKey);
        this.clearTimer(entry);
        this.removeAbort(entry);
        entry.reject(new QuestionChannelError('ask_user_question was cancelled before the user answered', ASK_ABORTED));
    }
    /** 入站文本作答：该会话若有待答问题且本条消息有文本，解析为答案并推进 */
    tryAnswer(scope, peerId, text) {
        const record = this.manager.getSessionRecord(scope, peerId);
        if (!record)
            return false;
        const key = record.sessionKey;
        const entry = this.pending.get(key);
        if (!entry)
            return false;
        if (!text)
            return false; // 纯图片/表情等：继续等待，消息走常规流程
        const current = entry.request.questions[entry.index];
        if (!current)
            return false;
        const answer = parseAnswer(current, text);
        this.advance(entry, key, answer);
        return true;
    }
    /** 按钮点击作答：解码 button_data 选项下标，推进状态机 */
    handleInteraction(event) {
        const peerId = event.group_openid ?? event.user_openid;
        if (!peerId)
            return false;
        const scope = event.group_openid ? 'group' : 'c2c';
        const record = this.manager.getSessionRecord(scope, peerId);
        if (!record)
            return false;
        const entry = this.pending.get(record.sessionKey);
        if (!entry)
            return false;
        const data = event.data?.resolved?.button_data;
        if (!data)
            return false;
        const button = decodeButtonData(data);
        if (!button || button.t !== 'question')
            return false;
        const current = entry.request.questions[entry.index];
        if (!current)
            return false;
        // 校验按钮归属题：旧题按钮在新题推进后被点击（误点/延迟事件），
        // 其 q 不等于当前题 id，直接忽略，避免错位映射到当前题选项。
        if (button.q !== current.id)
            return false;
        const idx = button.i;
        const opts = current.options ?? [];
        if (idx < 0 || idx >= opts.length)
            return false;
        this.advance(entry, record.sessionKey, { id: current.id, selected: [opts[idx].label] });
        return true;
    }
    /** 走 QQ 通道：发送首题 + 挂起 Promise，等待逐题作答 */
    async askViaQQ(record, request) {
        const key = record.sessionKey;
        // 会话回收/取消可能在发送前发生：signal 已 abort 则直接失败，避免悬挂
        if (request.signal?.aborted) {
            throw new QuestionChannelError('ask_user_question was aborted before delivery', ASK_ABORTED);
        }
        // 同会话已有待答问题（理论上不会发生：回合阻塞在第一个问题上）→ 拒绝旧的
        const prev = this.pending.get(key);
        if (prev) {
            this.pending.delete(key);
            this.clearTimer(prev);
            this.removeAbort(prev);
            prev.reject(new QuestionChannelError('superseded by a new question', ASK_ABORTED));
        }
        const first = request.questions[0];
        if (!first)
            throw new Error('ask_user_question with empty questions');
        await this.sendQuestion(record, first);
        return new Promise((resolve, reject) => {
            const entry = { record, request, resolve, reject, index: 0, collected: [] };
            if (request.signal) {
                const onAbort = () => {
                    if (this.pending.get(key) !== entry)
                        return;
                    this.pending.delete(key);
                    this.clearTimer(entry);
                    reject(new QuestionChannelError('ask_user_question was aborted before the user answered', ASK_ABORTED));
                };
                entry.onAbort = onAbort;
                request.signal.addEventListener('abort', onAbort, { once: true });
            }
            entry.timer = setTimeout(() => this.onTimeout(key), this.config.askTimeoutMs);
            this.pending.set(key, entry);
            this.logger.info(`im-qqbot: question sent to QQ, waiting for answer key=${key}`);
        });
    }
    /** 推进状态机：收集答案 → 有下一题则发送，否则 resolve 全部答案 */
    advance(entry, key, answer) {
        entry.collected.push(answer);
        entry.index += 1;
        if (entry.index < entry.request.questions.length) {
            const next = entry.request.questions[entry.index];
            this.resetTimer(entry, key);
            void this.sendQuestion(entry.record, next).catch((err) => {
                this.pending.delete(key);
                this.clearTimer(entry);
                this.removeAbort(entry);
                entry.reject(err instanceof Error ? err : new Error(String(err)));
            });
            return;
        }
        this.pending.delete(key);
        this.clearTimer(entry);
        this.removeAbort(entry);
        this.logger.info(`im-qqbot: question answered via QQ key=${key}`);
        entry.resolve({ answers: entry.collected });
    }
    /** 发送单个问题：优先带按钮，按钮发送失败降级纯文本 */
    async sendQuestion(record, question) {
        const hint = record.scope === 'group' && this.config.requireMention === true;
        const keyboard = buildKeyboard(question);
        try {
            if (keyboard) {
                try {
                    await this.sender.sendMarkdown(record.replyTarget, formatQuestion(question, hint, true), { keyboard });
                    return;
                }
                catch (err) {
                    // 同上：宿主 logger 在 headless profile 不可见，stderr 才是唯一线索
                    console.warn('[im-qqbot] keyboard send failed:', err);
                    this.logger.warn(`im-qqbot: keyboard send failed, fallback to text: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            await this.sender.sendMarkdown(record.replyTarget, formatQuestion(question, hint, false));
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(`im-qqbot: question send failed key=${record.sessionKey}: ${msg}`);
            throw new QuestionDeliveryError(`failed to deliver question to QQ: ${msg}`);
        }
    }
    onTimeout(key) {
        const entry = this.pending.get(key);
        if (!entry)
            return;
        this.pending.delete(key);
        this.removeAbort(entry);
        entry.timer = undefined;
        void this.sender.sendMarkdown(entry.record.replyTarget, '⚠️ 提问已超时，未收到回答。').catch(() => { });
        entry.reject(new QuestionChannelError('ask_user_question timed out before the user answered', ASK_ABORTED));
    }
    resetTimer(entry, key) {
        if (entry.timer)
            clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.onTimeout(key), this.config.askTimeoutMs);
    }
    clearTimer(entry) {
        if (entry.timer)
            clearTimeout(entry.timer);
        entry.timer = undefined;
    }
    removeAbort(entry) {
        if (entry.onAbort && entry.request.signal) {
            entry.request.signal.removeEventListener('abort', entry.onAbort);
        }
    }
}
//# sourceMappingURL=question-channel.js.map