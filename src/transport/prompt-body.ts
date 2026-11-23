/**
 * Prompt 正文拼装 — 普通消息与「带引用的命令」共用同一套格式。
 *
 * 形状（引用带附件时）：
 *
 *   [Reference attachments]
 *     - Image: <本地路径>
 *
 *   [Quoted message begins]
 *   <被引用正文>
 *   [Quoted message ends]
 *   [Current message]
 *   <正文>
 *
 * 只有引用、没有正文时省略 `[Current message]` 行（命令可以只带引用开会话）。
 * 普通入站消息的正文由 transport/inbound.ts 拼装，命令由 commands/quote.ts 取素材，
 * 两边都走这里，避免出现第二套格式。
 */
import { classifyContentType, type DownloadedFile, type MediaKind } from './attachment.ts';
import type { InboundQuoteState } from './inbound-state.ts';

/** 引用正文在 store 里保留的上限（与 quoteRef 的 contentLimit 一致）；达到上限补 `…` */
export const QUOTE_CONTENT_LIMIT = 2000;

export const QUOTE_BEGIN = '[Quoted message begins]';
export const QUOTE_END = '[Quoted message ends]';
export const CURRENT_MARK = '[Current message]';
export const REFERENCE_MARK = '[Reference attachments]';

const ENVELOPE_MARKS = new Set([QUOTE_BEGIN, QUOTE_END, CURRENT_MARK, REFERENCE_MARK]);

/** 引用正文：SDK 用 `[empty message]` 表示被引用消息没有文字 */
export function quoteTextOf(quote?: InboundQuoteState): string {
  const raw = (quote?.text ?? quote?.entry?.content ?? '').trim();
  return raw === '[empty message]' ? '' : raw;
}

/** 引用是否有可用内容（正文或附件）：命令据此决定执行还是回「取不到」 */
export function isQuoteResolvable(quote?: InboundQuoteState): boolean {
  if (!quote || quote.source === 'none') return false;
  return quoteTextOf(quote) !== '' || (quote.attachments?.length ?? 0) > 0;
}

/** 被引用正文里整行等于信封标记时加反斜杠：引用内容不能伪造信封边界 */
export function neutralizeQuoteMarkers(text: string): string {
  return text
    .split('\n')
    .map(line => (ENVELOPE_MARKS.has(line.trim()) ? `\\${line}` : line))
    .join('\n');
}

/**
 * 引用块。`hasCurrentText` 为 false 时（命令只带引用）不写 `[Current message]`，
 * 免得正文位置留下一个空信封。
 */
export function buildQuotePart(
  quote: InboundQuoteState | undefined,
  options: { hasCurrentText: boolean },
): string {
  const text = quoteTextOf(quote);
  if (text === '') return '';

  const truncated = quote?.source === 'store'
    && (quote.entry?.content?.length ?? 0) >= QUOTE_CONTENT_LIMIT;
  const body = neutralizeQuoteMarkers(text) + (truncated ? '…' : '');
  const block = `${QUOTE_BEGIN}\n${body}\n${QUOTE_END}`;

  return options.hasCurrentText ? `${block}\n${CURRENT_MARK}\n` : block;
}

/** 引用附件段（不含结尾空行）；全部是语音且没有 ASR 时不输出悬空标题 */
export function quoteAttachmentLines(
  quote: InboundQuoteState | undefined,
  files: DownloadedFile[] | undefined,
): string[] {
  const attachments = quote?.attachments;
  if (!attachments || attachments.length === 0) return [];

  const downloaded = new Map((files ?? []).map(file => [file.filename, file]));
  const items: string[] = [];
  for (const attachment of attachments) {
    const kind = classifyContentType(attachment.contentType);
    if (kind === 'voice') {
      if (attachment.asrText) items.push(`  - Voice: ${attachment.asrText}`);
      continue;
    }
    const file = downloaded.get(attachment.filename ?? '');
    items.push(`  - ${renderMediaLine(kind, attachment.filename, file?.localPath, attachment.url, undefined)}`);
  }

  return items.length === 0 ? [] : [REFERENCE_MARK, ...items];
}

/** 引用附件段，带结尾空行（拼在正文最前面用） */
export function buildQuoteAttachmentBlock(
  quote: InboundQuoteState | undefined,
  files: DownloadedFile[] | undefined,
): string {
  const lines = quoteAttachmentLines(quote, files);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n\n`;
}

export interface PromptBodyInput {
  quote?: InboundQuoteState;
  quoteFiles?: DownloadedFile[];
  /** 命令文本（/new 的提示词、/to 的正文）；只有引用时传空串 */
  text: string;
}

/** 一条 prompt 的完整正文：引用附件段 + 引用块 + 命令文本 */
export function buildPromptBody(input: PromptBodyInput): string {
  const attachmentBlock = buildQuoteAttachmentBlock(input.quote, input.quoteFiles);
  const quotePart = buildQuotePart(input.quote, { hasCurrentText: input.text.trim() !== '' });
  return `${attachmentBlock}${quotePart}${input.text}`;
}

/**
 * 渲染单个媒体附件（image/video/file）的上下文行内容，不含列表前缀。
 * 当前消息与引用消息共用，保证附件格式统一。语音不在此处理。
 */
export function renderMediaLine(
  kind: Exclude<MediaKind, 'voice'>,
  filename: string | undefined,
  localPath: string | undefined,
  url: string | undefined,
  size: number | undefined,
): string {
  switch (kind) {
    case 'image':
      return localPath
        ? `Image: ${localPath}`
        : `Image: ${url ?? filename ?? 'image'}`;
    case 'video':
      return localPath
        ? `Video: ${localPath}`
        : `Video: ${filename ?? 'video'} (download failed)`;
    case 'file':
      return localPath
        ? `File: ${localPath}`
        : `File: ${filename ?? 'file'} (${formatFileSize(size ?? 0)})`;
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
