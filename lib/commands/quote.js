import { downloadQuoteAttachments } from "../transport/attachment.js";
import { isQuoteResolvable } from "../transport/prompt-body.js";
import { errorMessage } from "../shared/utils.js";
/** 引用了消息但内容取不到：命令不执行，什么都不动 */
export const QUOTE_UNRESOLVED = '❌ 引用内容取不到，没有执行';
const silentLogger = {
    info: () => { },
    warn: () => { },
    error: () => { },
    debug: () => { },
};
/**
 * 取命令带来的引用素材。
 *
 * - 没引用 → undefined（命令按原样执行）
 * - 有引用但解析不出（source=none / 无正文且无附件）→ 错误文案
 * - 正常 → { quote, files }，附件按需下载到本地（与普通消息同一套下载器）
 */
export async function takeQuote(cmdCtx, media, logger) {
    const quote = cmdCtx.state?.quote;
    if (quote === undefined)
        return undefined;
    if (!isQuoteResolvable(quote))
        return QUOTE_UNRESOLVED;
    let files = [];
    if ((quote.attachments?.length ?? 0) > 0) {
        try {
            files = await downloadQuoteAttachments(quote, media, logger ?? silentLogger);
        }
        catch (err) {
            // 下载失败不阻断：prompt-body 会退回 URL / 文件名描述
            (logger ?? silentLogger).warn(`qqterm: 引用附件下载失败: ${errorMessage(err)}`);
        }
    }
    return { quote, files };
}
//# sourceMappingURL=quote.js.map