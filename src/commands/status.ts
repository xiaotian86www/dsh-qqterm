/**
 * 状态命令：/bot-status（QQBot 特有）
 *
 * 会话本身的状态 + 上下文占用（占用 / 窗口 / 剩余）。
 * 计费口径在 /cost 里，这里只给累计值做参照。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer, formatRelativeTime } from '../shared/index.ts';

/** 千分位 */
function num(n: number): string {
  return n.toLocaleString('en-US');
}

/** /bot-status — 查看当前会话状态 */
export function statusCommand({ manager }: CommandDeps): CategorizedCommand {
  return {
    name: 'bot-status',
    category: 'qqbot',
    scope: 'all',
    description: '查看当前会话状态与上下文占用',
    handler: (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const status = manager.getStatus(scope, peerId);
      if (!status.active) return '当前无活跃会话';

      const modelInfo = status.model ? `${status.provider}/${status.model}` : '宿主默认';

      const usage = manager.getTokenUsage(scope, peerId);
      const totalTokens = usage.input + usage.output;

      const lines: string[] = [
        '📊 会话状态',
        `会话: ${status.sessionId ? status.sessionId.slice(0, 8) : '—'}`,
        `模型: ${modelInfo}`,
        `Preset: ${status.preset ?? '无'}`,
        `消息数: ${status.messageCount ?? 0}`,
        `Token: ${totalTokens > 0 ? num(totalTokens) : '—'}（累计）`,
      ];

      // 上下文占用：used 来自最后一次请求的 totalTokens，window 来自 request/context
      const ctx = manager.getContextUsage(scope, peerId);
      if (ctx.used !== undefined && ctx.window !== undefined && ctx.window > 0) {
        const pct = ((ctx.used / ctx.window) * 100).toFixed(1);
        lines.push(`上下文: ${num(ctx.used)} / ${num(ctx.window)}（${pct}%，剩 ${num(Math.max(0, ctx.window - ctx.used))}）`);
      } else if (ctx.used !== undefined) {
        lines.push(`上下文: ${num(ctx.used)}（窗口未上报）`);
      } else if (ctx.window !== undefined) {
        lines.push(`上下文: 窗口 ${num(ctx.window)}（还没有请求）`);
      }

      lines.push(`最后活动: ${formatRelativeTime(status.lastActivity)}`);
      return lines.join('\n');
    },
  };
}
