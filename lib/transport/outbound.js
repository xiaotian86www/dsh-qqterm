import { createSender } from "./send.js";
import { Outbox } from "./outbox.js";
import { formatToolResult } from "./tool-presenter.js";
import { segmentMessageContent, splitMarkdownImages, } from "./outbound-images.js";
import { rewriteLocalFileLinks } from "./file-links.js";
import { RETRY_NOTICE_AFTER, RETRYABLE_FAILURE_CODES, formatRetryNotice, formatTurnFailure, } from "../features/retry-renderer.js";
import { parseEvent, extractTurnError, } from "./events.js";
import { errorMessage } from "../shared/utils.js";
/** 不展示给用户的轮次错误码（底层传输/网络错误，对用户无意义，且常被重试兜住） */
const SILENT_TURN_ERROR_CODES = new Set(['STREAM_CLOSED']);
/**
 * 出站路由器：持有会话级状态，按事件类型分发到处理器
 */
class OutboundRouter {
    toolCalls = new Map();
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
    /** 发送端口：署名 / 分片 / 入队重试全在它内部，路由只管事件与顺序 */
    sender;
    config;
    logger;
    toolsRegistry;
    deliverer;
    /** assistant/message 里的 image 块 → QQ 图片；未注入时不发图 */
    images;
    constructor(manager, sender, config, logger, toolsRegistry, deliverer, images) {
        this.manager = manager;
        this.sender = sender;
        this.config = config;
        this.logger = logger;
        this.toolsRegistry = toolsRegistry;
        this.deliverer = deliverer;
        this.images = images;
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
            case 'assistant/message':
                this.onMessage(record, event);
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
    /**
     * 完整 assistant 消息：按内容块顺序发送，图片留在它出现的位置。
     * 文本段各自成消息，图片组交给图片转发器。
     */
    onMessage(record, event) {
        // 正文里的 ![alt](本地图片) 是模型直接写的 markdown，QQ 不渲染，换成真图片消息
        const cwd = this.manager.directoryForAgent(record.agent);
        const segments = segmentMessageContent(event.content).flatMap((segment) => segment.kind === 'text' ? splitMarkdownImages(segment.text, cwd) : [segment]);
        this.queueSegments(record.sessionId, record, segments);
    }
    /** 按顺序把片段排进发送链：文本段各发一条，图片组交给图片转发器 */
    queueSegments(sessionId, record, segments) {
        for (const segment of segments) {
            if (segment.kind === 'image') {
                this.queueImages(sessionId, record, segment.refs);
                continue;
            }
            if (segment.kind === 'image-file') {
                this.queueImageFiles(sessionId, record, segment.paths);
                continue;
            }
            if (segment.text.trim() === '')
                continue;
            this.trackText(sessionId, this.enqueue(sessionId, () => this.sender.session(sessionId, record.replyTarget, this.compose(record, segment.text), 'sendMarkdown')));
        }
    }
    /** 把图片发送排到本次文本之后（文本可能为空：只有图片的消息也要发出去） */
    queueImages(sessionId, record, refs) {
        const sender = this.images;
        if (refs.length === 0 || sender === undefined)
            return;
        this.trackText(sessionId, this.enqueue(sessionId, () => sender.send(record, refs)));
    }
    /** 正文里引用的本地图片：路径已验真，交给图片转发器按本地文件发送 */
    queueImageFiles(sessionId, record, paths) {
        const sender = this.images;
        if (paths.length === 0 || sender === undefined)
            return;
        this.trackText(sessionId, this.enqueue(sessionId, () => sender.sendPaths(record, paths)));
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
        const files = this.presentedFiles.get(sessionId) ?? [];
        this.presentedFiles.delete(sessionId);
        this.presentedCalls.delete(sessionId);
        // assistant/message 已在轮内先行发送的文本可能仍在途：轮末等待其完成再投递文件
        const pending = this.pendingText.get(sessionId) ?? Promise.resolve();
        this.pendingText.delete(sessionId);
        const failure = extractTurnError(event.reason);
        const retries = this.retryCounts.get(sessionId)?.retry ?? 0;
        this.retryCounts.delete(sessionId);
        void this.enqueue(sessionId, async () => {
            await pending;
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
        await this.sender.session(record.sessionId, record.replyTarget, this.compose(record, formatTurnFailure(failure, canRetry)), 'sendTurnEndError');
    }
    /**
     * 每会话发送链：同一会话的分片连续发送，不与别的会话交错。
     * 任务内部不要再调用 `send()`（会再次入队并等待自己），直接调 sender。
     */
    enqueue(sessionId, task) {
        const previous = this.sendChains.get(sessionId) ?? Promise.resolve();
        const next = previous.then(task).catch((err) => {
            this.logger.error(`qqterm: send chain failed: ${errorMessage(err)}`);
        });
        this.sendChains.set(sessionId, next);
        void next.then(() => {
            if (this.sendChains.get(sessionId) === next)
                this.sendChains.delete(sessionId);
        });
        return next;
    }
    /**
     * 组装正文：本地文件链接换成 /get 命令。
     *
     * 署名不在这里做——sender.session 统一加来源行与尾部动作行，避免两条路径各写一遍。
     */
    compose(record, text) {
        return rewriteLocalFileLinks(text, this.manager.directoryForAgent(record.agent));
    }
    /** 统一发送：入队 → 组装 → 交给发送端口（署名 / 分片 / 入队重试都在端口里） */
    send(record, text, tag) {
        return this.enqueue(record.sessionId, () => this.sender.session(record.sessionId, record.replyTarget, this.compose(record, text), tag));
    }
    /** 网络恢复：把积压在队列里的消息按原顺序补发 */
    async flushPending() {
        await this.sender.flush();
    }
    /** 渠道失效：积压消息不会再送达 */
    clearPending() {
        this.sender.clear();
    }
    hasPendingDelivery(sessionId) {
        return this.sender.hasPending(sessionId);
    }
}
/** 传入的是发送端口还是裸 bot：端口有 session/text，裸 bot 只有 sendMarkdown */
function isSender(value) {
    return typeof value.session === 'function' && typeof value.text === 'function';
}
/** 从 SessionManager 取署名需要的三件事（可选服务缺失时按单会话部署兜底） */
function sessionViewOf(manager) {
    const optional = manager;
    return {
        isCurrent: (sessionId) => manager.isCurrentSession(sessionId),
        titleOf: (sessionId) => optional.sessionTitle?.(sessionId),
        // 归档入口只在部署有 workspaceRegistry 时给：没有该服务时命令不认这个子命令
        canArchive: () => optional.workspaceRegistryAvailable?.() ?? false,
    };
}
/**
 * 创建出站事件处理器
 *
 * 返回事件入口，注册到 ctx.on('session/event')。
 * sender 传 Sender（bootstrap 用）或裸 bot（单测 / 旧调用方）：裸 bot 会在内部
 * 组装发送端口与失败队列，行为与 bootstrap 一致。
 * toolsRegistry 用于工具结果的结构化展示；deliverer 用于轮末投递 present 声明的交付文件；
 * images 用于把 assistant/message 里的 image 块与正文引用的本地图片发成 QQ 图片。
 */
export function createOutboundHandler(manager, sender, config, logger, toolsRegistry, deliverer, images, onChannelBroken) {
    // 旧调用方只给 bot：内部自建端口与队列，鉴权失败仍能通过 onChannelBroken 上报
    const port = isSender(sender)
        ? sender
        : createSender({
            bot: sender,
            config,
            logger,
            sessions: sessionViewOf(manager),
            outbox: new Outbox({ logger, ...(onChannelBroken === undefined ? {} : { onChannelBroken }) }),
        });
    const router = new OutboundRouter(manager, port, config, logger, toolsRegistry, deliverer, images);
    return {
        routeSessionEvent: (session, event) => router.route(session, event),
        flushPending: () => router.flushPending(),
        clearPending: () => router.clearPending(),
        hasPendingDelivery: (sessionId) => router.hasPendingDelivery(sessionId),
    };
}
//# sourceMappingURL=outbound.js.map