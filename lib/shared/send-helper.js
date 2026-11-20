import { sendChunkedText } from "../transport/send.js";
/**
 * 分块发送 markdown（长内容自动切分）
 */
export async function sendMarkdownChunked(cmdCtx, content, chunkLimit) {
    const bot = cmdCtx.bot;
    const replyTarget = cmdCtx.replyTarget;
    await sendChunkedText(bot, replyTarget, content, chunkLimit);
}
//# sourceMappingURL=send-helper.js.map