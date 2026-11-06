/**
 * 重发命令：/retry — 重发当前会话上一条用户消息。
 *
 * 轮次因上游故障失败后，失败卡片上的「重发」按钮失效（超时 / 键盘不可用）时，
 * 用它兜底，用户不必重打原文。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer } from '../shared/index.ts';

export function retryCommand({ manager }: CommandDeps): CategorizedCommand {
  return {
    name: 'retry',
    category: 'agent',
    scope: 'all',
    description: '重发上一条消息',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const outcome = manager.retryLastPrompt(scope, peerId);
      if (outcome.ok) return '✅ 已重发上一条消息';
      if (outcome.reason === 'no-session') return '⚠️ 当前没有会话';
      if (outcome.reason === 'no-prompt') {
        return '⚠️ 没有可重发的消息\n先发一条消息，或等这一轮失败后再试。';
      }
      return `❌ 重发失败: ${outcome.message ?? '未知原因'}`;
    },
  };
}
