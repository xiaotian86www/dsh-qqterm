import { buttonLabel, encodeButtonData } from "./button-utils.js";
/** 值得询问「是否重发」的失败码（瞬时故障；鉴权/参数类错误重发也不会变好） */
export const RETRYABLE_FAILURE_CODES = new Set([
    'RATE_LIMIT',
    'SERVER',
    'TIMEOUT',
    'TRANSPORT',
    'EMPTY_RESPONSE',
    'MALFORMED_RESPONSE',
]);
/** 重试提示从第几次开始（含）——前三次静默，之后每次都告诉用户还在等 */
export const RETRY_NOTICE_AFTER = 3;
/** 原因行里上游原文的最大字符数（再长就截断，避免一条消息被堆栈撑爆） */
const MESSAGE_MAX = 1500;
/**
 * 失败原因行：`原因: \`CODE\` · 429: {"type":...}`。
 *
 * 默认保留上游原文的完整内容（只把换行压成空格、超长截断），
 * 排查 429 时要看到 provider / 网关的原话，删掉就看不出是本地限流还是真过载。
 */
export function formatReason(code, message) {
    const text = message.replace(/\s+/g, ' ').trim();
    if (text === '')
        return `原因: \`${code}\``;
    const clipped = text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX)}…（已截断）` : text;
    return `原因: \`${code}\` · ${clipped}`;
}
/** 退避时长：`4.0s` / `500ms` */
function formatDelay(delayMs) {
    return delayMs >= 1000 ? `${(delayMs / 1000).toFixed(1)}s` : `${Math.round(delayMs)}ms`;
}
/**
 * 重试进行中的提示（第 4 次起每条重试都发）。
 *
 * 只讲「第几次、等多久、上游到底报什么」，不发按钮——这时候还没有结论。
 */
export function formatRetryNotice(event) {
    const total = event.maxRetries === undefined ? '' : `/${event.maxRetries}`;
    const wait = event.delayMs === undefined || event.delayMs <= 0 ? '' : ` · ${formatDelay(event.delayMs)} 后发起`;
    const lines = [`⏳ 第 ${event.retry}${total} 次重试${wait}`];
    if (event.failure !== undefined)
        lines.push(formatReason(event.failure.code, event.failure.message));
    return lines.join('\n');
}
/**
 * 不可重试失败的两行告知（宿主原始 JSON 不再直出）。
 *
 * `canRetry` 由调用方按「这个失败重发有没有意义」决定：只有可重试码才传 true，
 * 配置类失败（`NO_ADAPTER`、`AUTH` 等）重发也是同一个结果，只给原因，不给下一步。
 */
export function formatTurnFailure(failure, canRetry) {
    const lines = ['❌ 本轮失败', formatReason(failure.code, failure.message)];
    if (canRetry)
        lines.push('', '> 💡 发送 `/retry` 重跑上一条消息');
    return lines.join('\n');
}
/**
 * 可重试失败的卡片正文。
 *
 * `retries` 是宿主本轮实际重试次数（0 = 一次都没重试，如 Retry-After 超限直接放弃），
 * 不要写死配置里的配额。
 */
export function formatRetryOffer(failure, retries, withButtons) {
    const title = retries > 0 ? `⚠️ 上游服务异常，重试 ${retries} 次未成功` : '⚠️ 上游服务异常';
    const hint = withButtons
        ? '> 👇 点「重发」重跑上一条消息'
        : '> 💡 发送 `/retry` 重跑上一条消息';
    return [title, formatReason(failure.code, failure.message), '', hint].join('\n');
}
/**
 * 「重发 / 放弃」键盘。
 *
 * button_data 编码 `{"t":"retry","s":<会话id>,"d":<resend|discard>}`：`s` 让多会话
 * 场景下的按钮找回自己的会话，不依赖 current。
 */
export function buildRetryKeyboard(sessionId) {
    const rows = [
        {
            buttons: [
                {
                    id: 'retry-resend',
                    render_data: { label: buttonLabel('🔁 重发'), visited_label: '✓ 已重发', style: 1 },
                    action: {
                        type: 1,
                        permission: { type: 2 },
                        click_limit: 1,
                        data: encodeButtonData({
                            t: 'retry',
                            s: sessionId,
                            d: 'resend',
                        }),
                    },
                },
                {
                    id: 'retry-discard',
                    render_data: { label: buttonLabel('❌ 放弃'), visited_label: '✓ 已放弃', style: 1 },
                    action: {
                        type: 1,
                        permission: { type: 2 },
                        click_limit: 1,
                        data: encodeButtonData({
                            t: 'retry',
                            s: sessionId,
                            d: 'discard',
                        }),
                    },
                },
            ],
        },
    ];
    return { content: { rows } };
}
//# sourceMappingURL=retry-renderer.js.map