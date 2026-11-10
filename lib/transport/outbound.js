import { chunkMarkdownText } from "./chunker.js";
import { chunkDecoratedSessionMessage, sessionTitleOf, } from "./session-source.js";
import { OutboundBuffer } from "./outbound-buffer.js";
import { formatToolResult } from "./tool-presenter.js";
import { RETRY_NOTICE_AFTER, RETRYABLE_FAILURE_CODES, formatRetryNotice, formatTurnFailure, } from "../features/retry-renderer.js";
import { parseEvent, extractTurnError, } from "./events.js";
export { parseStreamFrame } from "./events.js";
/** 不展示给用户的轮次错误码（底层传输/网络错误，对用户无意义，且常被重试兜住） */
const SILENT_TURN_ERROR_CODES = new Set(['STREAM_CLOSED']);
/**
 * 出站路由器：持有会话级状态，按事件类型分发到处理器
 */
class OutboundRouter {
    buffers = new Map();
    toolCalls = new Map();
    /** 每会话当前流式 attemptId：LLM 重试会发布新 attempt，用于 reset 与迟到帧过滤 */
    streamAttempts = new Map();
    /** 每会话本轮已声明的交付文件（deliverables/presented，轮末清空） */
    presentedFiles = new Map();
    /** 每会话已见过的 present callId（轮内去重，防事件重放导致重复投递） */
    presentedCalls = new Map();
    /**
     * 每会话最后一笔在途文本发送（assistant/message 的 flush 是 fire-and-forget，
     * turn/end 时需等待其完成再投递交付文件，保证回复文本先于文件到达用户）。
     */
    pendingText = new Map();
    /** 每会话发送链：同一会话的分片连续发送，不与别的会话交错 */
    sendChains = new Map();
    /** 每会话本轮的重试次数（llm/retry 事件喂，turn/end 消费） */
    retryCounts = new Map();
    manager;
    bot;
    config;
    logger;
    toolsRegistry;
    deliverer;
    constructor(manager, bot, config, logger, toolsRegistry, deliverer) {
        this.manager = manager;
        this.bot = bot;
        this.config = config;
        this.logger = logger;
        this.toolsRegistry = toolsRegistry;
        this.deliverer = deliverer;
    }
    /** 事件分发入口 */
    route(session, raw) {
        const event = parseEvent(raw);
        if (event === undefined)
            return;
        // 重试事件：计数 + 第 4 次起每条都告诉用户还在等（前三次静默，避免刷屏）
        if (event.type === 'llm/retry') {
            this.retryCounts.set(session.header.id, event);
            if (event.retry > RETRY_NOTICE_AFTER) {
                const record = this.manager.findBySessionId(session.header.id);
                if (record !== undefined) {
                    void this.send(record, formatRetryNotice(event), 'sendRetryNotice');
                }
            }
            return;
        }
        const record = this.manager.findBySessionId(session.header.id);
        if (record === undefined)
            return;
        switch (event.type) {
            case 'assistant/chunk':
                this.onChunk(session.header.id, record, event);
                break;
            case 'assistant/message':
                this.onMessage(session.header.id, record, event);
                break;
            case 'tool/call':
                this.onToolCall(event);
                break;
            case 'tool/result':
                this.onToolResult(record, event);
                break;
            case 'deliverables/presented':
                this.onPresented(session.header.id, event);
                break;
            case 'turn/end':
                this.onTurnEnd(session.header.id, record, event);
                break;
        }
    }
    /** durable assistant/chunk 事件的流式增量（历史格式兼容保留，当前宿主不再生产该事件） */
    onChunk(sessionId, record, event) {
        this.appendChunk(sessionId, record, event.text);
    }
    /**
     * 实时流式帧入口（瞬态 agent/assistant-stream 事件）。
     *
     * attempt 语义：start 帧即新内容起点，无条件重置 buffer——清空旧 attempt 的
     * 累积文本但保留流式会话（QQ 流式 update 是全量替换，用户看到同一条消息被
     * 新内容重写）。不用 attemptId 对比判断"新 attempt"：agent replacement 后
     * attempt 计数重启、attemptId 可能与旧 agent 重叠（官方按 frame revision 的
     * gap 检测处理同一问题）。迟到帧（attemptId 不匹配）仍直接丢弃，防止旧
     * attempt 的尾巴混进新内容。
     */
    routeStreamFrame(agentId, delta) {
        if (delta.kind === 'attempt-start') {
            this.streamAttempts.set(agentId, delta.attemptId);
            this.buffers.get(agentId)?.reset();
            return;
        }
        // text-delta：首帧未见 start 时自愈记录，迟到帧丢弃
        const current = this.streamAttempts.get(agentId);
        if (current === undefined) {
            this.streamAttempts.set(agentId, delta.attemptId);
        }
        else if (current !== delta.attemptId) {
            return;
        }
        const record = this.manager.findBySessionId(agentId);
        if (record === undefined)
            return;
        this.appendChunk(agentId, record, delta.text);
    }
    /** 获取或创建会话 buffer 并追加增量 */
    appendChunk(sessionId, record, text) {
        let buffer = this.buffers.get(sessionId);
        if (buffer === undefined) {
            // 流式只给 current；非当前会话走静态消息，来源头 / 回复链接在 sendNow 里加
            buffer = new OutboundBuffer(record, this.bot, this.config.textChunkLimit, this.logger, this.shouldStream(record));
            this.buffers.set(sessionId, buffer);
        }
        buffer.append(text);
    }
    /** 是否启用流式：配置开启 + 当前会话（有没有被动凭证由 openStream 决定） */
    shouldStream(record) {
        return this.config.streaming && this.manager.isCurrentSession(record.sessionId);
    }
    /** 完整 assistant 消息：有流式 buffer 则 flush，否则直接发送文本块 */
    onMessage(sessionId, record, event) {
        const buffer = this.buffers.get(sessionId);
        if (buffer !== undefined && buffer.text.trim()) {
            const text = buffer.text;
            this.buffers.delete(sessionId);
            if (buffer.isStreaming) {
                this.trackText(sessionId, this.enqueue(sessionId, () => buffer.flush()));
            }
            else {
                // 非当前会话：buffer 只负责累积，发送交给 sendNow 统一加来源头 / 回复链接
                buffer.cancel();
                this.trackText(sessionId, this.enqueue(sessionId, () => this.sendNow(record, text, 'sendMarkdown')));
            }
            return;
        }
        const textParts = [];
        for (const block of event.content) {
            if (block.type === 'text' && block.text)
                textParts.push(block.text);
        }
        const fullText = textParts.join('\n');
        if (!fullText.trim())
            return;
        this.trackText(sessionId, this.send(record, fullText, 'sendMarkdown'));
        this.buffers.delete(sessionId);
    }
    /** 记录每会话最后一笔在途文本任务（自身吞错：错误已由 send/flush 内部记录） */
    trackText(sessionId, task) {
        this.pendingText.set(sessionId, task.catch(() => { }));
    }
    /** 工具调用：仅记录，不发送（避免刷屏，等待结果） */
    onToolCall(event) {
        this.toolCalls.set(event.callId, { name: event.name, args: event.arguments });
    }
    /** 工具结果：成功与失败都受 showToolResults 开关控制（失败消息里带目标与原因） */
    onToolResult(record, event) {
        const call = this.toolCalls.get(event.callId);
        this.toolCalls.delete(event.callId);
        if (call === undefined)
            return;
        if (!this.config.showToolResults)
            return;
        const text = formatToolResult(call.name, call.args, event.raw, this.toolsRegistry, record.agent);
        if (!text)
            return;
        void this.send(record, text, 'sendToolResult');
    }
    /** 收集本轮声明的交付文件：事件总是先于 turn/end 到达，轮末统一投递 */
    onPresented(sessionId, event) {
        if (this.config.sendFile?.sendPresentedFiles === false)
            return;
        let calls = this.presentedCalls.get(sessionId);
        if (calls === undefined) {
            calls = new Set();
            this.presentedCalls.set(sessionId, calls);
        }
        if (calls.has(event.callId))
            return;
        calls.add(event.callId);
        const files = this.presentedFiles.get(sessionId) ?? [];
        files.push(...event.files);
        this.presentedFiles.set(sessionId, files);
    }
    /**
     * 轮次结束：文本先送达、再投递交付文件、最后清理状态，异常结束时告知用户。
     * 外层轮次失败不撤销已完成的声明（宿主契约），故失败轮的文件仍投递。
     */
    onTurnEnd(sessionId, record, event) {
        const buffer = this.buffers.get(sessionId);
        // 文本 flush 可等待，保证回复先于交付文件到达用户
        let flushTask = Promise.resolve();
        if (buffer !== undefined) {
            const text = buffer.text;
            if (text.trim()) {
                if (buffer.isStreaming) {
                    flushTask = this.enqueue(sessionId, () => buffer.flush());
                }
                else {
                    buffer.cancel();
                    flushTask = this.enqueue(sessionId, () => this.sendNow(record, text, 'sendMarkdown'));
                }
            }
            else {
                buffer.cancel();
            }
            this.buffers.delete(sessionId);
        }
        this.streamAttempts.delete(sessionId);
        const files = this.presentedFiles.get(sessionId) ?? [];
        this.presentedFiles.delete(sessionId);
        this.presentedCalls.delete(sessionId);
        // assistant/message 已在轮内先行发送的文本可能仍在途：与 turn/end 自身的 flush 一起等待
        const pending = this.pendingText.get(sessionId) ?? Promise.resolve();
        this.pendingText.delete(sessionId);
        const failure = extractTurnError(event.reason);
        const retries = this.retryCounts.get(sessionId)?.retry ?? 0;
        this.retryCounts.delete(sessionId);
        void this.enqueue(sessionId, async () => {
            await Promise.all([flushTask, pending]);
            if (failure !== undefined && !SILENT_TURN_ERROR_CODES.has(failure.code)) {
                await this.reportFailure(record, failure, retries);
            }
            if (files.length > 0 && this.deliverer !== undefined) {
                await this.deliverer.deliver(record, files);
            }
            this.logger.debug(`qqterm: turn/end sessionId=${sessionId}`);
        });
    }
    /**
     * 轮次失败告知：可重试错误优先挂「重发 / 放弃」卡片，其余只讲原因。
     *
     * 宿主 raw 里是错误码 + JSON，直出对用户没有可执行信息（旧实现就是原样转）；
     * 配置类失败重发也不会变好，所以不给 `/retry` 这种「下一步」。
     */
    async reportFailure(record, failure, retries) {
        const channel = this.manager.retryChannel;
        if (channel !== undefined && RETRYABLE_FAILURE_CODES.has(failure.code)) {
            if (await channel.offer(record, failure, retries))
                return;
        }
        const canRetry = RETRYABLE_FAILURE_CODES.has(failure.code) && (record.lastPrompt ?? '').trim() !== '';
        await this.sendNow(record, formatTurnFailure(failure, canRetry), 'sendTurnEndError');
    }
    /**
     * 每会话发送链：同一会话的分片连续发送，不与别的会话交错。
     * 任务内部不要再调用 `send()`（会再次入队并等待自己），用 `sendNow()`。
     */
    enqueue(sessionId, task) {
        const previous = this.sendChains.get(sessionId) ?? Promise.resolve();
        const next = previous.then(task).catch((err) => {
            this.logger.error(`qqterm: send chain failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        this.sendChains.set(sessionId, next);
        void next.then(() => {
            if (this.sendChains.get(sessionId) === next)
                this.sendChains.delete(sessionId);
        });
        return next;
    }
    /** 统一发送：入队 → 切分 + 逐 chunk 发送 + 错误记录 */
    send(record, text, tag) {
        return this.enqueue(record.sessionId, () => this.sendNow(record, text, tag));
    }
    /**
     * 在当前发送链内发送：非当前会话整段加来源头与尾部动作。
     * 来源头只在首片、尾部动作只在末片，避免长回复每片都重复标注。
     */
    async sendNow(record, text, tag) {
        const current = this.manager.isCurrentSession(record.sessionId);
        const chunks = current
            ? chunkMarkdownText(text, this.config.textChunkLimit)
            : chunkDecoratedSessionMessage(text, record.sessionId, sessionTitleOf(record), this.config.textChunkLimit);
        for (const chunk of chunks) {
            try {
                await this.bot.sendMarkdown(record.replyTarget, chunk);
            }
            catch (err) {
                this.logger.error(`qqterm: ${tag} failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
}
/**
 * 创建出站事件处理器
 *
 * 返回 durable 事件与实时流式帧两个入口，分别注册到
 * ctx.on('session/event') 与 ctx.on('agent/assistant-stream', ..., { global: true })。
 * toolsRegistry 用于工具结果的结构化展示；deliverer 用于轮末投递 present 声明的交付文件。
 */
export function createOutboundHandler(manager, bot, config, logger, toolsRegistry, deliverer) {
    const router = new OutboundRouter(manager, bot, config, logger, toolsRegistry, deliverer);
    return {
        routeSessionEvent: (session, event) => router.route(session, event),
        routeStreamFrame: (agentId, delta) => router.routeStreamFrame(agentId, delta),
    };
}
//# sourceMappingURL=outbound.js.map