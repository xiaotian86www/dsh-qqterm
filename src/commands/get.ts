/**
 * `/get <路径>` — 把本地文件发到当前聊天
 *
 * 正文里的本地文件链接会被出站改写成本命令（见 transport/file-links.ts），
 * 用户点链接或手动输入都能发。图片 / 视频 / 语音按扩展名走对应
 * 通道，其余走通用文件通道。
 *
 * 只有唯一绑定用户（`access.owner`）能执行，文件也只会发到该用户的私聊，
 * 因此不限制目录：给什么路径就发什么，存在性与「是不是普通文件」由发送前检查。
 */
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { CommandDeps, CategorizedCommand } from './types.ts';
import type { ReplyTarget } from '../types.ts';
import { getScopePeer } from '../shared/index.ts';
import { sessionAdminAuth } from './sessions.ts';
import { resolveLsTarget } from './ls.ts';
import { sendMediaFile, type MediaSenderLike } from '../media/send-media.ts';

const USAGE = [
  '**/get** 发送文件',
  '`/get <路径>` 相对当前工作区、绝对路径、`~` 都行',
].join('\n');

/** 命令上下文里的投递目标：SDK 通常已注入，缺失时按当前私聊补 */
function replyTargetOf(cmdCtx: SlashCommandHandlerContext, peerId: string): ReplyTarget {
  const injected = (cmdCtx as unknown as { replyTarget?: ReplyTarget }).replyTarget;
  return injected ?? { scope: 'c2c', targetId: peerId };
}

export function getCommand({ manager, config, bot, logger }: CommandDeps): CategorizedCommand {
  return {
    name: 'get',
    category: 'agent',
    // 发文件等于让人取走 agent 能碰的文件：与 /ls 同一权限面
    scope: 'c2c',
    authorized: sessionAdminAuth(config, logger),
    description: '把本地文件发到聊天',
    usage: USAGE,
    handler: async (cmdCtx) => {
      const raw = (cmdCtx.command?.raw ?? '').trim();
      if (raw === '') return `⚠️ 缺少文件路径\n${USAGE}`;

      const sender = bot as unknown as MediaSenderLike | undefined;
      if (sender === undefined) return '⚠️ 发送通道不可用，稍后重试。';

      const { scope, peerId } = getScopePeer(cmdCtx);
      const info = await manager.currentWorkspaceInfo(scope, peerId).catch(() => undefined);
      if (info === undefined) return '⚠️ 读不到当前工作区。';

      const target = resolveLsTarget(info.path, raw);

      let isFile = false;
      try {
        isFile = statSync(target).isFile();
      } catch {
        return `⚠️ 文件不存在: \`${target}\`\n用 \`/ls\` 看看目录里有什么。`;
      }
      if (!isFile) return `⚠️ 不是文件: \`${target}\``;

      const result = await sendMediaFile(sender, replyTargetOf(cmdCtx, peerId), target);
      switch (result.outcome) {
        case 'sent':
          return { kind: 'noop' as const };
        case 'missing':
          return `⚠️ 文件不存在: \`${target}\``;
        default:
          return `❌ 发送失败: ${basename(target)}\n${result.error}`;
      }
    },
  };
}
