/**
 * 重发命令：/retry — 重发当前会话上一条用户消息。
 *
 * 轮次因上游故障失败后，失败卡片上的「重发」按钮失效（超时 / 键盘不可用）时，
 * 用它兜底，用户不必重打原文。
 */
import type { CommandDeps, SlashCommand } from './types.ts';
import { getScopePeer } from '../shared/index.ts';
import {
  queuedPromptReceipt,
  sessionTitleOf,
  steeredPromptReceipt,
} from '../transport/session-source.ts';
import { sendMarkdownChunked } from '../shared/send-helper.ts';

export function retryCommand({ manager, config }: CommandDeps): SlashCommand {
  return {
    name: 'retry',
    scope: 'all',
    description: '重发上一条消息',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const outcome = manager.retryLastPrompt(scope, peerId);
      if (outcome.ok) {
        if (outcome.placement === 'started') return '✅ 已重发上一条消息';
        const record = manager.findBySessionId(outcome.sessionId);
        const title = record === undefined ? undefined : sessionTitleOf(record);
        const current = manager.isCurrentSession(outcome.sessionId);
        const text = outcome.placement === 'queued'
          ? queuedPromptReceipt(
            outcome.sessionId,
            title,
            outcome.messageId,
            current,
            manager.canSteer(),
          )
          : steeredPromptReceipt(outcome.sessionId, title, current);
        await sendMarkdownChunked(cmdCtx, text, config.textChunkLimit);
        return { kind: 'noop' as const };
      }
      if (outcome.reason === 'no-session') return '⚠️ 当前没有会话';
      if (outcome.reason === 'no-prompt') {
        return '⚠️ 没有可重发的消息\n先发一条消息，或等这一轮失败后再试。';
      }
      return `❌ 重发失败: ${outcome.message ?? '未知原因'}`;
    },
  };
}
