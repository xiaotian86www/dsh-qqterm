/**
 * 入站中间件与 handleInbound 之间共享的 ctx.state 形状
 *
 * SDK 的 ctx.state 是任意对象，字段全靠中间件之间约定。这里把「谁写、谁读」
 * 集中声明一次：写的一方 cast 成 InboundState，读的一方不用再猜字段名。
 */
import type { DownloadedFile } from './attachment.ts';
import type { QuotedAttachment } from '../types.ts';

/** 引用消息：quoteRef 中间件写入 */
export interface InboundQuoteState {
  text?: string;
  entry?: { senderId?: string; content?: string };
  attachments?: QuotedAttachment[];
}

/** 单条附件的处理结果（语音转录、本地路径等） */
export interface InboundAttachmentState {
  type: 'voice' | 'image' | 'video' | 'file' | 'unknown';
  filename?: string;
  url?: string;
  localPath?: string;
  voiceText?: string;
  voiceSource?: 'stt' | 'asr' | 'fallback';
  duration?: number;
  width?: number;
  height?: number;
  size?: number;
}

/** 中间件链在 ctx.state 上留下的字段：谁写谁读看这里 */
export interface InboundState {
  /** quoteRef 写入 */
  quote?: InboundQuoteState;
  /** 语音等预处理结果（没有对应中间件时不写） */
  processedAttachments?: InboundAttachmentState[];
  /** attachmentProcessor 写入：当前消息已下载的附件 */
  downloadedFiles?: DownloadedFile[];
  /** attachmentProcessor 写入：引用消息已下载的附件 */
  downloadedQuoteFiles?: DownloadedFile[];
  [key: string]: unknown;
}
