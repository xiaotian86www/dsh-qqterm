/**
 * 出站事件解析 — 将 dsh session/event 归一化为强类型
 *
 * 原始事件（ctx.on('session/event') 回调参数）是弱类型：
 *   { type: string, data: Record<string, unknown> }
 * 这里把可识别的事件解析为 discriminated union，未知类型或字段缺失返回 undefined。
 */
/** llm/retry 的 failure 是宿主的错误对象，只取 code / message 并保持原文 */
function parseRetryFailure(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return undefined;
    const { code, message } = raw;
    if (typeof code !== 'string' && typeof message !== 'string')
        return undefined;
    return {
        code: typeof code === 'string' ? code : 'UNKNOWN',
        message: typeof message === 'string' ? message : '',
    };
}
/**
 * 解析原始事件为强类型
 *
 * 未知类型或缺失关键字段时返回 undefined，由调用方直接跳过。
 */
export function parseEvent(raw) {
    switch (raw.type) {
        case 'assistant/message': {
            const message = raw.data.message;
            if (message === undefined || !Array.isArray(message.content))
                return undefined;
            return { type: 'assistant/message', content: message.content };
        }
        case 'tool/call': {
            const data = raw.data;
            if (!data.callId || !data.name)
                return undefined;
            return { type: 'tool/call', callId: data.callId, name: data.name, arguments: data.arguments ?? '' };
        }
        case 'tool/result': {
            const data = raw.data;
            const callId = data.message?.source?.callId;
            if (!callId)
                return undefined;
            return { type: 'tool/result', callId, error: data.error, raw: raw.data };
        }
        case 'turn/end': {
            const reason = raw.data.reason ?? {};
            return { type: 'turn/end', reason };
        }
        case 'llm/retry': {
            const data = raw.data;
            if (typeof data.retry !== 'number' || data.retry <= 0)
                return undefined;
            const failure = parseRetryFailure(data.failure);
            return {
                type: 'llm/retry',
                retry: data.retry,
                ...(typeof data.maxRetries === 'number' ? { maxRetries: data.maxRetries } : {}),
                provider: typeof data.provider === 'string' ? data.provider : '',
                ...(typeof data.delayMs === 'number' ? { delayMs: data.delayMs } : {}),
                ...(failure !== undefined ? { failure } : {}),
            };
        }
        case 'deliverables/presented': {
            const data = raw.data;
            if (typeof data.turn !== 'number' || typeof data.callId !== 'string' || !data.callId)
                return undefined;
            if (!Array.isArray(data.files) || data.files.length === 0)
                return undefined;
            const files = [];
            for (const file of data.files) {
                if (file === null || typeof file !== 'object' || Array.isArray(file))
                    return undefined;
                const { path, description } = file;
                if (typeof path !== 'string' || !path)
                    return undefined;
                if (description !== undefined && typeof description !== 'string')
                    return undefined;
                files.push(description === undefined ? { path } : { path, description });
            }
            return { type: 'deliverables/presented', turn: data.turn, callId: data.callId, files };
        }
        default:
            return undefined;
    }
}
/**
 * 从 turn/end reason 提取错误信息
 *
 * 兼容三种形态：error（新格式）、failure（旧格式）、顶层 message/code（最旧格式）。
 */
export function extractTurnError(reason) {
    if (reason.kind !== 'error')
        return undefined;
    const detail = reason.error ?? reason.failure;
    return {
        code: detail?.code ?? reason.code ?? 'UNKNOWN',
        message: detail?.message ?? reason.message ?? 'unknown error',
    };
}
//# sourceMappingURL=events.js.map