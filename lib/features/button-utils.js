/** QQ 按钮 label 有长度限制，超长截断（正文保留完整文本；多列布局下阈值更短） */
export const BUTTON_LABEL_MAX = 10;
/** 单选按钮每行个数（多列布局，减少选项多时的刷屏） */
export const BUTTONS_PER_ROW = 2;
/** 截断按钮 label，超长补省略号 */
export function buttonLabel(text) {
    const s = String(text ?? '').trim();
    return s.length > BUTTON_LABEL_MAX ? s.slice(0, BUTTON_LABEL_MAX - 1) + '…' : s;
}
/** 编码 button_data（JSON 字符串） */
export function encodeButtonData(data) {
    return JSON.stringify(data);
}
/** 解码 button_data；非法 JSON 或缺少合法 `t` 时返回 undefined */
export function decodeButtonData(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed !== null
            && typeof parsed === 'object'
            && (parsed.t === 'question' || parsed.t === 'approval' || parsed.t === 'retry' || parsed.t === 'confirm')) {
            return parsed;
        }
    }
    catch {
        // fall through
    }
    return undefined;
}
/**
 * 构建一个回调按钮。
 *
 * 协议字段（`type: 1` = 回调、`permission: { type: 2 }` = 所有人可点、`click_limit: 1`）
 * 只在这里写一次：四个 renderer 各拼一遍时，漏一个字段就是「点了没反应」。
 * label 由 `buttonLabel()` 截断，调用方传完整文本即可。
 */
export function callbackButton(options) {
    return {
        id: options.id,
        render_data: {
            label: buttonLabel(options.label),
            visited_label: options.visitedLabel,
            style: options.style ?? 1,
        },
        action: {
            type: 1,
            permission: { type: 2 },
            click_limit: 1,
            data: encodeButtonData(options.data),
        },
    };
}
//# sourceMappingURL=button-utils.js.map