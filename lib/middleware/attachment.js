import { downloadMediaAttachments, downloadQuoteAttachments } from "../transport/attachment.js";
import { errorMessage } from "../shared/utils.js";
export function attachmentProcessor(config, logger) {
    return async (ctx, next) => {
        const msg = ctx.message;
        try {
            // 当前消息附件
            const downloaded = await downloadMediaAttachments(msg.attachments, config.media, logger);
            ctx.state.downloadedFiles = downloaded;
            // 引用消息附件：同一套下载逻辑（voice 跳过，ASR 文本来自 quote.attachments）
            ctx.state.downloadedQuoteFiles = await downloadQuoteAttachments(ctx.state.quote, config.media, logger);
        }
        catch (err) {
            logger.warn(`qqterm: attachment download failed: ${errorMessage(err)}`);
        }
        await next();
    };
}
//# sourceMappingURL=attachment.js.map