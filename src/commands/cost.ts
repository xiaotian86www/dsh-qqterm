/**
 * 用量命令：/cost — 只看计费口径
 *
 * 累计 input/output（每轮都计，反映真实调用量）+ 缓存命中率。
 * 上下文占用属于会话状态，放在 /bot-status 里（见 status.ts）。
 *
 * 数据来源（session 事件）：
 *   assistant/message.data.usage.inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer, sendMarkdownChunked } from '../shared/index.ts';

/** 千分位（不用本地化，避免不同环境分隔符不一致） */
function num(n: number): string {
  return n.toLocaleString('en-US');
}

export function costCommand({ manager, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'cost',
    category: 'agent',
    scope: 'all',
    description: '查看当前会话的 token 消耗',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);

      if (!manager.getSessionRecord(scope, peerId)) {
        return '⚠️ 当前无活跃会话';
      }

      const stats = manager.getTokenUsage(scope, peerId);
      const total = stats.input + stats.output;

      if (total === 0) {
        return '⚠️ 本会话还没有模型调用';
      }

      const lines: string[] = ['### 💰 Token 消耗', ''];
      lines.push('**累计**');
      lines.push(`输入 ${num(stats.input)} / 输出 ${num(stats.output)}`);
      lines.push(`合计 ${num(total)}`);

      if (stats.cacheRead > 0 || stats.cacheWrite > 0) {
        const denom = stats.input + stats.cacheRead;
        const hit = denom > 0 ? ((stats.cacheRead / denom) * 100).toFixed(1) : '0.0';
        lines.push(`缓存读 ${num(stats.cacheRead)}（命中率 ${hit}%）`);
        if (stats.cacheWrite > 0) lines.push(`缓存写 ${num(stats.cacheWrite)}`);
      }

      await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
      return { kind: 'noop' as const };
    },
  };
}
