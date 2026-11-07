/**
 * /bot-reload — 应用 profile 磁盘上的插件变更（热重载）
 *
 * 只做一件事：把 dsh 的 `hmr.reconcileProfile()` 暴露给 QQ。
 * 它不是重启按钮：磁盘上没有新文件时什么都不换，需要重启的改动会如实回报。
 */
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { sendMarkdownChunked } from '../shared/index.ts';

/** /bot-reload — 重新加载 profile 里已变更的插件文件 */
export function reloadCommand({ config, reloader }: CommandDeps): CategorizedCommand {
  return {
    name: 'bot-reload',
    category: 'qqbot',
    scope: 'all',
    description: '应用磁盘上的插件变更（热重载）',
    panelDesc: '热重载插件',
    usage: [
      '/bot-reload',
      '',
      '重新加载 profile 目录里已变更的插件文件。',
      '只影响磁盘上真的变过的插件；重载期间机器人会短暂断开。',
      '需要重启才能生效的改动会在完成后提示。',
    ].join('\n'),
    handler: async (cmdCtx) => {
      if (reloader === undefined || !reloader.available) {
        return '⚠️ 当前 profile 未启用热重载';
      }

      // 先回复再调度：重载会 dispose 当前 fiber，回复必须在此之前送出
      await sendMarkdownChunked(cmdCtx, '🔄 正在应用插件变更…', config.textChunkLimit);

      // 被动回复凭证只在内存里，重载后拿不到：现在就写进状态文件
      const replyTarget = (cmdCtx as unknown as {
        replyTarget?: { targetId?: string; msgId?: string; eventId?: string };
        bot?: QQBot;
      }).replyTarget;
      const bot = (cmdCtx as unknown as { bot?: QQBot }).bot;
      const targetId = replyTarget?.targetId;
      const msgId = replyTarget?.msgId ?? cmdCtx.message?.messageId;
      reloader.run(
        targetId === undefined || targetId === ''
          ? undefined
          : {
              targetId,
              ...(msgId === undefined ? {} : { msgId }),
              ...(replyTarget?.eventId === undefined ? {} : { eventId: replyTarget.eventId }),
            },
        bot,
      );

      return { kind: 'noop' as const };
    },
  };
}
