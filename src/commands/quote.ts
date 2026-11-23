/**
 * 带引用命令的引用取材
 *
 * quoteRef 中间件排在 slashCommand 之前（见 gateway/middleware-setup.ts），所以命令
 * handler 能读到 ctx.state.quote。这里把中间件结果变成 prompt-body 要的素材：
 * 引用解析不了就回错误文案，命令在动会话之前先问一次，不留下半截动作。
 */
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { downloadQuoteAttachments, type DownloadedFile } from '../transport/attachment.ts';
import { isQuoteResolvable } from '../transport/prompt-body.ts';
import type { InboundQuoteState } from '../transport/inbound-state.ts';
import type { MediaConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { errorMessage } from '../shared/utils.ts';

/** 引用了消息但内容取不到：命令不执行，什么都不动 */
export const QUOTE_UNRESOLVED = '❌ 引用内容取不到，没有执行';

export interface CommandQuote {
  quote: InboundQuoteState;
  files: DownloadedFile[];
}

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * 取命令带来的引用素材。
 *
 * - 没引用 → undefined（命令按原样执行）
 * - 有引用但解析不出（source=none / 无正文且无附件）→ 错误文案
 * - 正常 → { quote, files }，附件按需下载到本地（与普通消息同一套下载器）
 */
export async function takeQuote(
  cmdCtx: SlashCommandHandlerContext,
  media: MediaConfig,
  logger?: Logger,
): Promise<CommandQuote | string | undefined> {
  const quote = (cmdCtx.state as { quote?: InboundQuoteState } | undefined)?.quote;
  if (quote === undefined) return undefined;
  if (!isQuoteResolvable(quote)) return QUOTE_UNRESOLVED;

  let files: DownloadedFile[] = [];
  if ((quote.attachments?.length ?? 0) > 0) {
    try {
      files = await downloadQuoteAttachments(quote, media, logger ?? silentLogger);
    } catch (err) {
      // 下载失败不阻断：prompt-body 会退回 URL / 文件名描述
      (logger ?? silentLogger).warn(`qqterm: 引用附件下载失败: ${errorMessage(err)}`);
    }
  }
  return { quote, files };
}
