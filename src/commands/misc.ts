/**
 * 杂项命令
 *
 * - /stop：中止当前生成；`/stop all` 中止所有正在生成的已获取会话
 */
import type { CommandDeps, SlashCommand } from './types.ts';
import { getScopePeer } from '../shared/index.ts';

/** /stop — 中止当前生成；`/stop all` 中止全部已获取会话（隐藏） */
export function stopCommand({ manager }: CommandDeps): SlashCommand {
  return {
    name: 'stop',
    scope: 'all',
    description: '中止生成',
    hidden: true,
    usage: [
      '### 📖 /stop 用法',
      '',
      '`/stop` 中止当前生成',
      '`/stop all` 中止全部生成',
    ].join('\n'),
    handler: (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const arg = (cmdCtx.command?.raw ?? '').trim();

      if (arg !== '') {
        if (arg.toLowerCase() !== 'all') {
          return '⚠️ 用法: /stop 或 /stop all';
        }
        const cancelled = manager.cancelAllRunning();
        return cancelled.length === 0
          ? '⚠️ 当前没有进行中的生成'
          : `⛔ 已中止 ${cancelled.length} 个会话`;
      }

      const record = manager.getSessionRecord(scope, peerId);
      // 会话存在不等于正在生成：只有 agent 处于 running 才算有进行中的回复
      if (record === undefined || record.agent.status !== 'running') {
        return '⚠️ 当前没有进行中的生成';
      }

      // cancel 会让当前轮以 turn/end (kind=interrupted) 收尾，
      // 出站侧据此 flush 已生成的文本并关闭流式会话。
      record.agent.cancel({ kind: 'user' });
      return '⛔ 已中止';
    },
  };
}
