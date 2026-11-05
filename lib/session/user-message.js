/**
 * QQ 入站消息 → dsh UserMessage。
 *
 * source.kind 固定为 `qqbot`，让宿主侧（session log / Web 历史）能区分消息来源；
 * dsh-llm 的 MessageSource 是闭合联合类型，运行时允许扩展 kind，这里只做类型断言。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
/** 构造一条来自 QQ 的用户消息 */
export function createQQUserMessage(text) {
    return createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'qqbot' },
    });
}
//# sourceMappingURL=user-message.js.map