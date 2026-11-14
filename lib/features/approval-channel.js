import { randomUUID } from 'node:crypto';
import { decodeButtonData } from "./button-utils.js";
import { buildApprovalKeyboard, buildApprovalText } from "./approval-renderer.js";
const COMMAND_CLIP = 500;
/**
 * 从 session log 按 callId 找回被 gate 的命令（审批请求本身不重复携带 arguments）。
 * 对齐 TUI/web 的 `commandOf` 语义。
 */
function commandOf(req) {
    if (req.callId === undefined)
        return undefined;
    // 审批请求可能来自没有 live session 的上下文（例如跨进程/投影后的 Agent），
    // 此时只是拿不到命令原文，不能因此让整个审批失败。
    const events = req.agent.session?.snapshotEvents?.();
    if (!Array.isArray(events))
        return undefined;
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (!event || event.type !== 'tool/call')
            continue;
        const data = event.data;
        if (String(data?.callId) !== String(req.callId))
            continue;
        const raw = data?.arguments;
        if (typeof raw !== 'string')
            return undefined;
        try {
            const parsed = JSON.parse(raw);
            if (parsed !== null && typeof parsed === 'object' && 'command' in parsed) {
                const command = parsed.command;
                if (typeof command === 'string')
                    return command;
            }
        }
        catch {
            // 非 JSON，回退到原始字符串
        }
        return raw.length <= COMMAND_CLIP ? raw : `${raw.slice(0, COMMAND_CLIP)}…`;
    }
    return undefined;
}
export class ApprovalChannel {
    pending = new Map();
    manager;
    sender;
    logger;
    config;
    constructor(manager, sender, config, logger) {
        this.manager = manager;
        this.sender = sender;
        this.config = config;
        this.logger = logger;
    }
    /**
     * 注册 approval/request waterfall answerer。
     *
     * 不再探测 approval 服务是否已挂载：它是 optional peer，挂载时机可能晚于
     * 本插件的 apply，一次性探测失败会让通道永久失效。监听事件本身不依赖服务
     * 存在——服务就绪后请求自然经过同一条瀑布，未挂载时不会有请求到达。
     *
     * `global` 是必需的：approval/request 按 agent 作用域派发，根作用域注册的
     * 监听器不带 global 会被作用域过滤掉。
     */
    install(ctx) {
        const self = this;
        ctx.on('approval/request', (req, next) => {
            const request = req;
            const nextFn = next;
            const record = self.manager.findBySessionId(request.agent.id);
            if (record)
                return self.park(record, request, nextFn);
            return nextFn();
        }, { global: true, prepend: true });
        this.logger.info('qqterm: QQ approval channel installed');
    }
    /** 会话回收时清理其 pending 审批，避免 Promise 悬挂 */
    cancelPending(sessionId) {
        const entry = this.pending.get(sessionId);
        if (!entry)
            return;
        this.pending.delete(sessionId);
        this.removeAbort(entry);
        entry.resolve('cancelled');
    }
    /** 按钮点击决策：按 button_data 的 `s` 找会话，校验点击者后 settle pending 审批 */
    handleInteraction(event) {
        const peerId = event.user_openid;
        if (!peerId)
            return false;
        const data = event.data?.resolved?.button_data;
        if (!data)
            return false;
        const button = decodeButtonData(data);
        if (!button || button.t !== 'approval')
            return false;
        const sessionId = button.s;
        if (!sessionId)
            return false;
        const entry = this.pending.get(sessionId);
        if (!entry)
            return false;
        // 按钮属于哪个会话，就只能由那个会话的 QQ 用户点
        if (entry.record.peerId !== undefined && entry.record.peerId !== peerId)
            return false;
        // nonce 必须匹配 pending：旧卡片/其它会话的卡片点击不 settle（#94-3）
        if (button.n !== entry.nonce) {
            this.logger.warn(`qqterm: approval button nonce mismatch: sessionId=${entry.record.sessionId}`);
            return false;
        }
        // 审批只认唯一绑定用户；点击者身份缺失同样拒绝（fail-closed）
        const clicker = event.user_openid;
        const owner = this.config.access.owner.trim();
        if (owner === '' || clicker !== owner) {
            this.logger.warn(`qqterm: approval button rejected (clicker not owner): user=${clicker ?? '(missing)'} sessionId=${entry.record.sessionId}`);
            return false;
        }
        this.pending.delete(entry.record.sessionId);
        this.removeAbort(entry);
        entry.resolve(button.d === 'allow' ? 'allowed-once' : 'rejected');
        return true;
    }
    /** 走 QQ 通道：发审批消息 + 挂起 Promise，等待用户决策 */
    async park(record, request, delegate) {
        const sessionId = record.sessionId;
        // 会话回收/取消可能在发送前发生：signal 已 abort 则直接失败
        if (request.signal?.aborted)
            return 'cancelled';
        const command = commandOf(request);
        const nonce = randomUUID().slice(0, 8);
        const isCurrent = this.manager.isCurrentSession?.(sessionId) ?? true;
        const title = this.manager.sessionTitle?.(sessionId);
        try {
            await this.sender.sendMarkdown(record.replyTarget, buildApprovalText(request, command, { sessionId, isCurrent, title }), { keyboard: buildApprovalKeyboard(nonce, sessionId) });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(`qqterm: approval send failed sessionId=${sessionId}: ${msg}`);
            // 卡片没送到 QQ 时不能把请求吞掉：交回链上其他通道（Web GUI 仍可弹窗）。
            this.logger.warn('qqterm: QQ approval delivery failed, falling back to the host answerer');
            try {
                return await delegate();
            }
            catch (nextErr) {
                // 链上也没有 answerer 了：两条通道都投不出去，按「未决策」结束（fail-closed），
                // 不让 rejection 冒成宿主的未捕获错误。
                const nextMsg = nextErr instanceof Error ? nextErr.message : String(nextErr);
                this.logger.error(`qqterm: no answerer accepted the approval: ${nextMsg}`);
                return 'cancelled';
            }
        }
        return new Promise((resolve) => {
            const entry = { record, request, resolve, nonce };
            if (request.signal) {
                const onAbort = () => {
                    if (this.pending.get(sessionId) !== entry)
                        return;
                    this.pending.delete(sessionId);
                    resolve('cancelled');
                };
                entry.onAbort = onAbort;
                request.signal.addEventListener('abort', onAbort, { once: true });
            }
            this.pending.set(sessionId, entry);
            this.logger.info(`qqterm: approval sent to QQ, waiting for decision sessionId=${sessionId}`);
        });
    }
    removeAbort(entry) {
        if (entry.onAbort && entry.request.signal) {
            entry.request.signal.removeEventListener('abort', entry.onAbort);
        }
    }
}
//# sourceMappingURL=approval-channel.js.map