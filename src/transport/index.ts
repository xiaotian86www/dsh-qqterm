/**
 * 传输层
 *
 * 协议对接：QQ 消息入站 / 出站 / Markdown 切分。
 */
export { handleInbound } from './inbound.ts';
export { createOutboundHandler } from './outbound.ts';
export type { QQBotSender } from './outbound.ts';
export { chunkMarkdownText } from './chunker.ts';
