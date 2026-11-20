import { errorMessage } from "../shared/utils.js";
/** 网络类错误码：重试有意义 */
const TRANSIENT_CODES = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
]);
/**
 * 「消息太长」：QQ 单聊 v2 明确的两个码，切小重发即可。
 * 文档：发送单聊消息 → 错误码 40054007 / 40054018。
 */
const TOO_LONG_CODES = new Set([40054007, 40054018]);
/**
 * 内容侧确定性拒绝：只能发替代消息告知，重发多少次都一样。
 * 40034006 消息内容违规、40054013 用户拒收消息、40054004 无好友关系。
 */
const BLOCKED_CODES = new Set([40034006, 40054004, 40054013]);
/**
 * 渠道级失效（不只是这条消息发不出去）：机器人已下线、应用权限被封。
 * 401/403 走 HTTP 状态判断，这里补业务码。
 */
const AUTH_CODES = new Set([40054016, 11253, 11254, 11265]);
/** 业务码里明确可重试的：主动消息频控、媒体转存失败、发送异常 */
const RETRY_BIZ_CODES = new Set([40034100, 40034004, 50055002]);
const TOO_LONG_RE = /(too|exceed)\w*\s*(long|length)|length\s*(limit|exceed)|超长|过长|长度\s*(超|限)|消息\s*过长/i;
const BLOCKED_RE = /(sensitive|violat|forbidden|blocked|risk)|审核|风控|敏感|违规|拦截|拒收/i;
/**
 * 收集错误对象里的全部数字码。
 *
 * SDK 的 ApiError 字段是 httpStatus / bizCode / bizMessage（见
 * @tencent-connect/qqbot-nodejs 的 protocol/types.ts），业务码不在 code 上；
 * 这里把 HTTP 状态与业务码一起收，谁命中都算。
 */
function numbersOf(err, depth = 0, out = []) {
    if (typeof err !== 'object' || err === null || depth > 2)
        return out;
    const raw = err;
    for (const key of ['status', 'statusCode', 'httpStatus', 'code', 'errCode', 'bizCode']) {
        const value = raw[key];
        if (typeof value === 'number' && Number.isFinite(value))
            out.push(value);
        else if (typeof value === 'string' && /^\d{3,5}$/.test(value))
            out.push(Number(value));
    }
    const response = raw.response;
    if (typeof response === 'object' && response !== null) {
        const nested = response.status;
        if (typeof nested === 'number')
            out.push(nested);
    }
    return numbersOf(raw.cause, depth + 1, out);
}
/** 从错误对象里取字符串错误码 */
function codeOf(err, depth = 0) {
    if (typeof err !== 'object' || err === null || depth > 2)
        return undefined;
    const raw = err;
    const code = raw.code;
    if (typeof code === 'string' && code !== '')
        return code;
    return codeOf(raw.cause, depth + 1);
}
/**
 * 默认分类。
 *
 * 平台错误码来自 QQ 开放平台「发送单聊消息」错误码表（40034006 内容违规、
 * 40054007/40054018 超长、40054016 机器人下线等），字段名对齐 SDK v1.0.5 的
 * ApiError(httpStatus, bizCode)。判不准的一律落回 transient（多试一次，再排队），
 * 不会把可恢复的失败判死。
 */
export function classifyDeliveryError(err) {
    const codes = numbersOf(err);
    // 先判死的：业务码比 HTTP 状态更具体（内容违规也是 400）
    if (codes.some(code => AUTH_CODES.has(code)))
        return 'auth';
    if (codes.some(code => TOO_LONG_CODES.has(code)))
        return 'too-long';
    if (codes.some(code => BLOCKED_CODES.has(code)))
        return 'blocked';
    const http = codes.find(code => code === 401 || code === 403 || code === 429 || (code >= 500 && code < 600));
    if (http === 401 || http === 403)
        return 'auth';
    if (codes.some(code => code === 429 || (code >= 500 && code < 600)))
        return 'transient';
    if (codes.some(code => RETRY_BIZ_CODES.has(code)))
        return 'transient';
    const code = codeOf(err);
    if (code !== undefined && TRANSIENT_CODES.has(code))
        return 'transient';
    const message = errorMessage(err);
    if (TOO_LONG_RE.test(message))
        return 'too-long';
    if (BLOCKED_RE.test(message))
        return 'blocked';
    return 'transient';
}
function errorText(err) {
    return errorMessage(err);
}
/**
 * 出站投递队列。
 *
 * 队列在内存里（重启即丢），键是会话 id：同一会话的消息保持原顺序，不同会话
 * 互不阻塞。它是「这条消息还没送到」，不是「会话状态」，所以不落盘。
 */
export class Outbox {
    queues = new Map();
    logger;
    classify;
    onChannelBroken;
    /** 冲刷中（ready 与入站消息可能同时触发） */
    flushing = false;
    constructor(options) {
        this.logger = options.logger;
        this.classify = options.classify ?? classifyDeliveryError;
        this.onChannelBroken = options.onChannelBroken;
    }
    /** 该会话（或缺省时任意会话）还有消息在等 */
    hasPending(key) {
        if (key !== undefined)
            return (this.queues.get(key)?.length ?? 0) > 0;
        for (const queue of this.queues.values()) {
            if (queue.length > 0)
                return true;
        }
        return false;
    }
    /** 直接排队，不尝试发送（前一条已经证明网络不通） */
    enqueue(key, tag, run) {
        const queue = this.queues.get(key);
        if (queue === undefined) {
            this.queues.set(key, [{ tag, run }]);
        }
        else {
            queue.push({ tag, run });
        }
    }
    /**
     * 发送一条：成功返回 sent；暂不可用先重试一次，仍失败入队返回 queued；
     * 内容类失败原样返回，由调用方决定切分还是发替代消息；鉴权失败触发渠道释放。
     */
    async deliver(key, tag, run) {
        if (this.hasPending(key)) {
            this.enqueue(key, tag, run);
            return 'queued';
        }
        let failure;
        try {
            await run();
            return 'sent';
        }
        catch (err) {
            failure = this.classify(err);
            if (failure === 'auth')
                return this.breakChannel(err);
            if (failure !== 'transient') {
                this.logger.warn(`qqterm: ${tag} rejected by QQ (${failure}): ${errorText(err)}`);
                return failure;
            }
            this.logger.warn(`qqterm: ${tag} failed, retrying once: ${errorText(err)}`);
        }
        try {
            await run();
            return 'sent';
        }
        catch (err) {
            if (this.classify(err) === 'auth')
                return this.breakChannel(err);
            this.logger.error(`qqterm: ${tag} failed twice, queued until the channel recovers: ${errorText(err)}`);
            this.enqueue(key, tag, run);
            return 'queued';
        }
    }
    /**
     * 冲刷队列：按会话、按原顺序补发。
     *
     * 遇到仍然暂不可用就停在这条上（网络没回来，继续发只会更糟）；内容类失败
     * 单条丢弃、不挡后面的消息。鉴权失败直接清队并释放渠道。
     */
    async flush() {
        if (this.flushing || this.queues.size === 0)
            return;
        this.flushing = true;
        try {
            for (const [key, queue] of this.queues) {
                while (queue.length > 0) {
                    const item = queue[0];
                    try {
                        await item.run();
                        queue.shift();
                    }
                    catch (err) {
                        const failure = this.classify(err);
                        if (failure === 'auth') {
                            this.breakChannel(err);
                            return;
                        }
                        if (failure === 'too-long' || failure === 'blocked') {
                            queue.shift();
                            this.logger.error(`qqterm: ${item.tag} dropped after recovery (${failure}): ${errorText(err)}`);
                            continue;
                        }
                        this.logger.warn(`qqterm: ${item.tag} still failing (${queue.length} message(s) waiting): ${errorText(err)}`);
                        break;
                    }
                }
                if (queue.length === 0)
                    this.queues.delete(key);
            }
        }
        finally {
            this.flushing = false;
        }
    }
    /** 渠道没了：队列里的消息再也不会送达，直接丢掉 */
    clear() {
        if (this.queues.size > 0)
            this.logger.warn(`qqterm: dropping ${this.pendingCount()} queued message(s)`);
        this.queues.clear();
    }
    /** 等待中的条数（日志与 /status 用） */
    pendingCount() {
        let total = 0;
        for (const queue of this.queues.values())
            total += queue.length;
        return total;
    }
    breakChannel(err) {
        const reason = errorText(err);
        this.logger.error(`qqterm: QQ channel is no longer usable (${reason})`);
        this.queues.clear();
        this.onChannelBroken?.(reason);
        return 'broken';
    }
}
//# sourceMappingURL=outbox.js.map