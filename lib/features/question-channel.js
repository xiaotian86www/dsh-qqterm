import { isOwner, shortSessionId, errorMessage } from "../shared/utils.js";
import { sessionSourceHeader, sourceTitle } from "../transport/session-source.js";
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
 * 与「用户没答/超时」区分：只有投递失败才允许退回 `next()` 交给 Web 端。
 * 发送失败不做重试（凭证过期时重试只会再失败一次），任一题投递失败都把
 * 整个请求退回宿主链；已经答过的题不保留，Web 端会从头重问一遍整组。
 */
class QuestionDeliveryError extends Error {
    constructor(message) {
        super(message);
        this.name = 'QuestionDeliveryError';
    }
}
export class QuestionChannel {
    /** 待答问题：sessionId → 状态机（不再按 chatKey，切走 current 不会撞 key） */
    pending = new Map();
    /** `/to #id` 空文本进入的「下一条消息作为回答」模式：peerId → sessionId */
    answerTargets = new Map();
    /** 正在投递首题（entry 还没建）的会话：渠道在这期间被释放要记下来 */
    inFlight = new Map();
    /** 投递期间收到释放请求的会话：首题发完立刻交回宿主 */
    handoffRequested = new Set();
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
    /** 记录所属的会话 id（优先宿主 id） */
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
            // 投递失败才退回宿主链（Web 弹窗）：任一题失败都整组退回，不重试、不保留已答答案
            return self.askViaQQ(record, request, nextFn).catch(async (err) => {
                if (!(err instanceof QuestionDeliveryError))
                    throw err;
                self.logger.warn(`qqterm: QQ question delivery failed, falling back to the host answerer: ${err.message}`);
                try {
                    return await nextFn();
                }
                catch (nextErr) {
                    // 链上已没有 answerer（或请求已结束）：两条通道都投不出去，按中断结束，
                    // 不能让这个 rejection 冒成宿主的未捕获错误（宿主里那是致命错误）。
                    const msg = errorMessage(nextErr);
                    self.logger.error(`qqterm: no answerer accepted the question after QQ delivery failed: ${msg}`);
                    throw new QuestionChannelError(`question was not delivered on any channel: ${msg}`, ASK_ABORTED);
                }
            });
        }, { global: true, prepend: true });
        this.logger.info('qqterm: QQ question channel installed (user-questions/request)');
    }
    uninstall() {
        for (const [, entry] of this.pending) {
            this.clearTimer(entry);
            this.removeAbort(entry);
            entry.reject(new QuestionChannelError('QQ question channel was unloaded before the user answered', ASK_ABORTED));
        }
        this.pending.clear();
        this.answerTargets.clear();
        this.inFlight.clear();
        this.handoffRequested.clear();
    }
    /** 会话回收时清理其待答问题，避免 pending 悬挂导致 Promise 与闭包泄漏 */
    cancelPending(sessionId) {
        const entry = this.pending.get(sessionId);
        this.clearAnswerTargets(sessionId);
        this.handoffRequested.delete(sessionId);
        if (!entry)
            return;
        this.pending.delete(sessionId);
        this.clearTimer(entry);
        this.removeAbort(entry);
        entry.reject(new QuestionChannelError('ask_user_question was cancelled before the user answered', ASK_ABORTED));
    }
    /**
     * 渠道释放时把待答问题交回宿主（Web 端仍能弹窗）。
     *
     * 不 await：Web 端可能很久之后才回答，卸载 / 释放流程不能卡在这里。
     * 已答过的题不保留，宿主会从头重问整组——与投递失败退回宿主时的行为一致。
     */
    handoffPending(sessionId) {
        this.clearAnswerTargets(sessionId);
        const entry = this.pending.get(sessionId);
        if (entry === undefined) {
            // 首题正在发：等发完由 askViaQQ 自己交回
            if (this.inFlight.has(sessionId))
                this.handoffRequested.add(sessionId);
            return;
        }
        this.pending.delete(sessionId);
        this.clearTimer(entry);
        this.removeAbort(entry);
        if (entry.handoff === undefined) {
            entry.reject(new QuestionChannelError('QQ question channel was released before the user answered', ASK_ABORTED));
            return;
        }
        void entry.handoff().then(entry.resolve, (err) => {
            entry.reject(err instanceof Error ? err : new Error(String(err)));
        });
    }
    /** 交回宿主 answerer；链上没有 answerer 时按「未作答」结束 */
    async handoffToHost(nextFn) {
        if (nextFn === undefined) {
            throw new QuestionChannelError('QQ question channel was released before the question was delivered', ASK_ABORTED);
        }
        return nextFn();
    }
    /** 该会话是否有待答问题（`/to` 判断走答案通道还是普通 prompt） */
    hasPending(sessionId) {
        return this.pending.has(sessionId);
    }
    /** `/to #id` 空文本：下一条该 peer 的普通文本作为这个会话的答案 */
    beginAnswerMode(peerId, sessionId) {
        this.answerTargets.set(peerId, sessionId);
        this.logger.info(`qqterm: answer mode armed peer=${peerId} sessionId=${sessionId}`);
    }
    /** 显式答复指定会话（`/to #id -- <答案>`），不依赖 current */
    answer(sessionId, text) {
        const entry = this.pending.get(sessionId);
        if (!entry || !text)
            return false;
        const current = entry.request.questions[entry.index];
        if (!current)
            return false;
        this.advance(entry, sessionId, parseAnswer(current, text));
        return true;
    }
    /**
     * 入站文本作答：显式 answer target > current 的 pending > 非 current 待答提示。
     *
     * 第三步只消费并提示、不转发给 current 模型：一条没有路由信息的文本不能
     * 猜着送给另一个会话（设计 §6.3）。
     */
    tryAnswer(scope, peerId, text, replyTarget) {
        const explicit = this.answerTargets.get(peerId);
        if (explicit) {
            const entry = this.pending.get(explicit);
            if (!entry) {
                // 整组已经结束（答完/超时/取消）：退出模式，这条消息走常规流程
                this.answerTargets.delete(peerId);
            }
            else if (!text) {
                return false;
            }
            else {
                const current = entry.request.questions[entry.index];
                if (!current) {
                    this.answerTargets.delete(peerId);
                    return false;
                }
                this.advance(entry, explicit, parseAnswer(current, text));
                return true;
            }
        }
        const record = this.manager.getSessionRecord(scope, peerId);
        const currentId = record?.sessionId;
        if (currentId) {
            const entry = this.pending.get(currentId);
            if (entry && text) {
                const current = entry.request.questions[entry.index];
                if (!current)
                    return false;
                this.advance(entry, currentId, parseAnswer(current, text));
                return true;
            }
        }
        // 当前会话没在等答案，但有别的已获取会话在等：提示路由，不转发给 current。
        // 只提示属于这个 QQ 用户的会话，别人的待答问题不阻塞当前用户。
        const others = [...this.pending.entries()].filter(([id, entry]) => id !== currentId
            && (entry.record.peerId === undefined || entry.record.peerId === peerId));
        if (others.length === 0 || !text)
            return false;
        this.sendRouteHint(others.map(([id]) => id), replyTarget ?? record?.replyTarget);
        return true;
    }
    /** 按钮点击作答：按 button_data 的 `s` 找会话，旧卡片/旧题按钮忽略 */
    handleInteraction(event) {
        const peerId = event.user_openid;
        if (!peerId)
            return false;
        // 按钮只认唯一绑定用户；未绑定或身份不匹配直接忽略
        if (!isOwner(this.config.access.owner, peerId))
            return false;
        const data = event.data?.resolved?.button_data;
        if (!data)
            return false;
        const button = decodeButtonData(data);
        if (!button || button.t !== 'question')
            return false;
        const sessionId = button.s;
        if (!sessionId)
            return false;
        const entry = this.pending.get(sessionId);
        if (!entry)
            return false;
        if (entry.record.peerId !== undefined && entry.record.peerId !== peerId)
            return false;
        return this.consumeButton(entry, sessionId, button.q, button.i);
    }
    /** 校验按钮归属题并推进状态机 */
    consumeButton(entry, sessionId, questionId, idx) {
        const current = entry.request.questions[entry.index];
        if (!current)
            return false;
        // 旧题按钮在新题推进后被点击（误点/延迟事件），其 q 不等于当前题 id，直接忽略
        if (questionId !== current.id)
            return false;
        const opts = current.options ?? [];
        if (idx < 0 || idx >= opts.length)
            return false;
        this.advance(entry, sessionId, { id: current.id, selected: [opts[idx].label] });
        return true;
    }
    /**
     * 会话名：`#短id`，有标题时补上名字（提示语里指认会话用）。
     *
     * 只出现在「没有转发给你当前会话」这类提示里；它不是在转述另一个会话的
     * 内容，所以不套来源行。
     */
    sessionLabel(sessionId) {
        const label = `\`#${shortSessionId(sessionId)}\``;
        const title = this.manager.sessionTitle?.(sessionId);
        return title === undefined ? label : `${label}（${sourceTitle(title)}）`;
    }
    /** 会话内提示：非当前会话加来源行，用户才知道这条提示是哪条会话的事 */
    noticeText(record, body) {
        const sessionId = record.sessionId;
        if (this.manager.isCurrentSession?.(sessionId) ?? true)
            return body;
        return `${sessionSourceHeader(sessionId, this.manager.sessionTitle?.(sessionId))}\n\n${body}`;
    }
    /** 非 current 会话在等答案、但用户直接发了纯文本：提示用按钮或 /to，不转发 */
    sendRouteHint(sessionIds, target) {
        if (target === undefined)
            return;
        const text = sessionIds.length === 1
            ? [
                `⚠️ 这条属于 ${this.sessionLabel(sessionIds[0])}，没有转发给当前会话`,
                `用问题里的按钮或 \`/to #${shortSessionId(sessionIds[0])} --\` 回答。`,
            ].join('\n')
            : [
                `⚠️ 有 ${sessionIds.length} 个会话在等回答，没有转发给当前会话`,
                '用各自问题里的按钮或 `/to <会话> --` 回答。',
            ].join('\n');
        void this.sender.text(target, text).catch(() => { });
    }
    /** 清理指向某会话的 answer target（整组结束/取消时） */
    clearAnswerTargets(sessionId) {
        for (const [peerId, target] of this.answerTargets) {
            if (target === sessionId)
                this.answerTargets.delete(peerId);
        }
    }
    /** 走 QQ 通道：发送首题 + 挂起 Promise，等待逐题作答 */
    async askViaQQ(record, request, nextFn) {
        const sessionId = record.sessionId;
        // 会话回收/取消可能在发送前发生：signal 已 abort 则直接失败，避免悬挂
        if (request.signal?.aborted) {
            throw new QuestionChannelError('ask_user_question was aborted before delivery', ASK_ABORTED);
        }
        // 同会话已有待答问题（理论上不会发生：回合阻塞在第一个问题上）→ 拒绝旧的
        const prev = this.pending.get(sessionId);
        if (prev) {
            this.pending.delete(sessionId);
            this.clearTimer(prev);
            this.removeAbort(prev);
            prev.reject(new QuestionChannelError('superseded by a new question', ASK_ABORTED));
        }
        const first = request.questions[0];
        if (!first)
            throw new Error('ask_user_question with empty questions');
        this.inFlight.set(sessionId, nextFn);
        try {
            await this.sendQuestion(record, first);
        }
        finally {
            this.inFlight.delete(sessionId);
        }
        // 发送期间渠道被释放：QQ 已经收不到回答，直接把整组问题交回宿主
        if (this.handoffRequested.delete(sessionId))
            return this.handoffToHost(nextFn);
        return new Promise((resolve, reject) => {
            const entry = {
                record,
                request,
                resolve,
                reject,
                index: 0,
                collected: [],
                handoff: nextFn,
            };
            if (request.signal) {
                const onAbort = () => {
                    if (this.pending.get(sessionId) !== entry)
                        return;
                    this.pending.delete(sessionId);
                    this.clearTimer(entry);
                    reject(new QuestionChannelError('ask_user_question was aborted before the user answered', ASK_ABORTED));
                };
                entry.onAbort = onAbort;
                request.signal.addEventListener('abort', onAbort, { once: true });
            }
            if (this.config.askTimeoutMs > 0) {
                entry.timer = setTimeout(() => this.onTimeout(sessionId), this.config.askTimeoutMs);
            }
            this.pending.set(sessionId, entry);
            this.logger.info(`qqterm: question sent to QQ, waiting for answer sessionId=${sessionId}`);
        });
    }
    /** 推进状态机：收集答案 → 有下一题则发送，否则 resolve 全部答案 */
    advance(entry, sessionId, answer) {
        entry.collected.push(answer);
        entry.index += 1;
        if (entry.index < entry.request.questions.length) {
            const next = entry.request.questions[entry.index];
            this.resetTimer(entry, sessionId);
            void this.sendQuestion(entry.record, next).catch((err) => {
                this.pending.delete(sessionId);
                this.clearAnswerTargets(sessionId);
                this.clearTimer(entry);
                this.removeAbort(entry);
                entry.reject(err instanceof Error ? err : new Error(String(err)));
            });
            return;
        }
        this.pending.delete(sessionId);
        this.clearAnswerTargets(sessionId);
        this.clearTimer(entry);
        this.removeAbort(entry);
        this.logger.info(`qqterm: question answered via QQ sessionId=${sessionId}`);
        entry.resolve({ answers: entry.collected });
    }
    /** 发送单个问题：优先带按钮，按钮发送失败降级纯文本 */
    async sendQuestion(record, question) {
        const sessionId = record.sessionId;
        const isCurrent = this.manager.isCurrentSession?.(sessionId) ?? true;
        const context = { sessionId, isCurrent, title: this.manager.sessionTitle?.(sessionId) };
        // 非当前会话的兜底入口写在正文引用行里（回答 / 恢复），键盘只放选项按钮；
        // 当前会话的回复入口就是输入框，连链接都不需要。
        const keyboard = buildKeyboard(question, sessionId);
        try {
            if (keyboard) {
                // 带按钮的正文 + 无按钮兜底一起交给 sender：键盘通道不可用时自动降级
                await this.sender.card(record.replyTarget, formatQuestion(question, true, context), keyboard, formatQuestion(question, false, context));
                return;
            }
            await this.sender.text(record.replyTarget, formatQuestion(question, false, context));
        }
        catch (err) {
            const msg = errorMessage(err);
            this.logger.error(`qqterm: question send failed sessionId=${sessionId}: ${msg}`);
            throw new QuestionDeliveryError(`failed to deliver question to QQ: ${msg}`);
        }
    }
    onTimeout(sessionId) {
        const entry = this.pending.get(sessionId);
        if (!entry)
            return;
        this.pending.delete(sessionId);
        this.clearAnswerTargets(sessionId);
        this.removeAbort(entry);
        entry.timer = undefined;
        void this.sender.text(entry.record.replyTarget, this.noticeText(entry.record, '⚠️ 提问已超时，未收到回答。')).catch(() => { });
        entry.reject(new QuestionChannelError('ask_user_question timed out before the user answered', ASK_ABORTED));
    }
    resetTimer(entry, sessionId) {
        if (entry.timer)
            clearTimeout(entry.timer);
        entry.timer = this.config.askTimeoutMs > 0
            ? setTimeout(() => this.onTimeout(sessionId), this.config.askTimeoutMs)
            : undefined;
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