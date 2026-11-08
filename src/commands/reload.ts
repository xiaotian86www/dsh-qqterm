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

      // 被动回复凭证由 ReplyStore 落盘，重载后新 fiber 自己读；这里只留投递目标
      const replyTarget = (cmdCtx as unknown as {
        replyTarget?: { targetId?: string };
        bot?: QQBot;
      }).replyTarget;
      const bot = (cmdCtx as unknown as { bot?: QQBot }).bot;

      // 上一轮的结果可能还没送到（新 fiber 的 ready 补发之前又收到这条命令）：
      // run() 会把状态改写成 running，那一轮的「应用了什么」就再也读不到了。
      // 必须先于回执：否则上一轮的结论会排在这一轮的「正在应用」后面，读成它的结果。
      if (bot !== undefined) await reloader.announce(bot);

      // 先回复再调度：重载会 dispose 当前 fiber，回复必须在此之前送出
      await sendMarkdownChunked(cmdCtx, '🔄 正在应用插件变更…', config.textChunkLimit);

      const targetId = replyTarget?.targetId;
      reloader.run(
        targetId === undefined || targetId === ''
          ? undefined
          : { targetId },
        bot,
      );

      return { kind: 'noop' as const };
    },
  };
}
