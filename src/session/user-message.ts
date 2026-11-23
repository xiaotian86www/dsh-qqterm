/**
 * QQ 入站消息 → dsh UserMessage。
 *
 * source.kind 必须是 `user`：宿主把「人类消息」作为一批能力的触发条件，
 * 例如会话标题（`dsh-session-title` 只对 `kind === 'user'` 的消息排期，
 * 内置回退标题也走这条路径）、最近提问时间、轮次大纲、replay 断点。
 * 自造 kind（如 `qqbot`）会让这些能力静默失效——症状就是 QQ 会话永远停在
 * 「未命名会话」。宿主自带的外部通道（ACP、JSON-RPC SDK、headless）同样发
 * `{ kind: 'user' }`。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** 构造一条来自 QQ 的用户消息 */
export function createQQUserMessage(text: string): { id: string } {
  return createUserMessage({
    content: [{ type: 'text' as const, text }],
    source: { kind: 'user' },
  });
}
