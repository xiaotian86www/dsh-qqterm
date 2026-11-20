/**
 * 分块发送 markdown 工具
 *
 * 命令回复统一走这里：切分与「网络类失败重试一次」实现在 transport/send.ts，
 * 与出站文本是同一条路径（命令拿不到 Sender，只有 SDK 注入的 bot 与 replyTarget）。
 */
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { sendChunkedText, type QQBotSender } from '../transport/send.ts';

/**
 * 分块发送 markdown（长内容自动切分）
 */
export async function sendMarkdownChunked(
  cmdCtx: SlashCommandHandlerContext,
  content: string,
  chunkLimit: number,
): Promise<void> {
  const bot = (cmdCtx as unknown as Record<string, unknown>).bot as QQBotSender;
  const replyTarget = (cmdCtx as unknown as Record<string, unknown>).replyTarget;
  await sendChunkedText(bot, replyTarget as never, content, chunkLimit);
}
