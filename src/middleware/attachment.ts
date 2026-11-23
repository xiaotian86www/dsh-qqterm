/**
 * 富媒体下载中间件 — 在中间件链中下载 image/video/file 附件
 *
 * 结果写入 ctx.state.downloadedFiles，供 handleInbound 读取。
 * 下载失败不阻断消息（记录告警后放行），确保附件异常不影响正常文本处理。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { downloadMediaAttachments, downloadQuoteAttachments } from '../transport/attachment.ts';
import type { QQTermConfig } from '../config.ts';
import type { Logger, RawAttachment } from '../types.ts';
import { errorMessage } from '../shared/utils.ts';

export function attachmentProcessor(config: QQTermConfig, logger: Logger) {
  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    const msg = ctx.message as { attachments?: RawAttachment[] };

    try {
      // 当前消息附件
      const downloaded = await downloadMediaAttachments(msg.attachments, config.media, logger);
      ctx.state.downloadedFiles = downloaded;

      // 引用消息附件：同一套下载逻辑（voice 跳过，ASR 文本来自 quote.attachments）
      ctx.state.downloadedQuoteFiles = await downloadQuoteAttachments(ctx.state.quote, config.media, logger);
    } catch (err) {
      logger.warn(`qqterm: attachment download failed: ${errorMessage(err)}`);
    }

    await next();
  };
}
