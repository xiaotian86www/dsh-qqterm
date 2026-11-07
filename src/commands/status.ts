/**
 * 状态命令：/bot-status（QQBot 特有）
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer } from '../shared/index.ts';
import { sessionTargetLabel, sessionTitleOf } from '../transport/session-source.ts';
import { effortLabel } from '../model/effort-label.ts';

/** /bot-status — 查看当前会话状态（最小视图：会话 / 模型 / preset / 消息数） */
export function statusCommand({ manager, reloader }: CommandDeps): CategorizedCommand {
  return {
    name: 'bot-status',
    category: 'qqbot',
    scope: 'all',
    description: '查看当前会话状态',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const status = manager.getStatus(scope, peerId);
      if (!status.active) return '⚠️ 当前没有会话';
      const record = manager.getSessionRecord(scope, peerId);
      const title = record === undefined ? undefined : sessionTitleOf(record);
      const session = status.sessionId === undefined
        ? '—'
        : sessionTargetLabel(status.sessionId, title);
      const modelInfo = status.model ? `${status.provider}/${status.model}` : '宿主默认';
      const effort = await manager.getEffortView(scope, peerId);
      const lastReload = reloader?.describe();
      return [
        '📊 会话状态',
        `会话: ${session}`,
        `模型: ${modelInfo}`,
        ...(effort.current ? [`思考强度: ${effortLabel(effort.current)}`] : []),
        `Preset: ${status.preset ?? '无'}`,
        `消息数: ${status.messageCount ?? 0}`,
        ...(lastReload === undefined ? [] : [`上次重载: ${lastReload}`]),
      ].join('\n');
    },
  };
}
