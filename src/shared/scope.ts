/**
 * scope 提取工具
 *
 * 从 SDK 命令上下文中提取 scope + peerId。
 */
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';

/**
 * 从命令上下文提取 scope + peerId
 *
 * 插件只处理后 C2C 私聊消息，peerId 恒为发送者 user openid。
 */
export function getScopePeer(cmdCtx: SlashCommandHandlerContext): { scope: 'c2c'; peerId: string } {
  return { scope: 'c2c', peerId: cmdCtx.message.senderId };
}
