/**
 * 入站处理器 — 经 SDK 中间件链处理后的消息 → dsh Agent followup
 *
 * 插件只接收 C2C 私聊消息。内容组装逻辑：
 * - Layer 1: userContent（文本 + 语音转录）
 * - Layer 2: quotePart（引用消息块）
 * - Layer 3: userMessage（引用块 + 正文）
 * - Layer 4: dynamicCtx（媒体元数据）
 *
 * 消息始终落到「当前会话」；其它已获取会话由 `/sessions resume`、`/to` 与
 * 问答通道驱动，不从这条普通消息路径直接写。
 */
import type { SessionManager } from '../session/index.ts';
import { createQQUserMessage } from '../session/user-message.ts';
import type { ChatScope, Logger, QuotedAttachment, RawAttachment, ReplyTarget } from '../types.ts';
import {
  classifyContentType,
  isVoiceContentType,
  type DownloadedFile,
  type MediaKind,
} from './attachment.ts';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';

// ── 类型定义 ──

interface ProcessedMessage {
  rawEventType: string;
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  msgType?: number;
  attachments?: RawAttachment[];
  [key: string]: unknown;
}

interface ResolvedQuote {
  text?: string;
  entry?: { senderId?: string; content?: string };
  attachments?: QuotedAttachment[];
}

interface MiddlewareState {
  quote?: ResolvedQuote;
  processedAttachments?: ProcessedAttachment[];
  downloadedFiles?: DownloadedFile[];
  downloadedQuoteFiles?: DownloadedFile[];
  [key: string]: unknown;
}

interface ProcessedAttachment {
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

// ── 主处理函数 ──

/**
 * 处理 QQ 入站消息（已经过 SDK 中间件链）
 */
export async function handleInbound(
  ctx: MiddlewareContext,
  manager: SessionManager,
  logger: Logger,
): Promise<void> {
  const msg = ctx.message as unknown as ProcessedMessage;
  const mwState = ctx.state as MiddlewareState;
  const { bot } = ctx;

  const scope: ChatScope = 'c2c';
  const peerId = msg.senderId;

  const replyTarget: ReplyTarget = {
    scope,
    targetId: peerId,
    msgId: msg.messageId,
  };

  // ── 组装 agentBody（下载结果经 mwState.downloadedFiles 提供） ──
  const agentBody = assembleAgentBody(msg, mwState, logger);

  if (!agentBody) return;

  logger.info(`Processing: scope=${scope} peerId=${peerId} body="${agentBody.slice(0, 200)}"`);

  // ── 获取或创建会话 ──
  let record;
  try {
    record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);
  } catch (err) {
    logger.error(`ERROR creating session: ${err instanceof Error ? err.message : String(err)}`);
    // 宿主 logger 在 headless profile 里不进终端，补一条 stderr：会话打不开时
    // 用户只看到兜底文案，没有这一行就无法定位（如 SessionAlreadyOwnedError）。
    console.error('[im-qqbot] getOrCreate failed:', err);
    // 兜底回复：会话创建失败时告知用户，避免静默无响应
    try {
      await bot.sendMarkdown(replyTarget, '⚠️ 处理消息时出现异常，请稍后重试。');
    } catch (sendErr) {
      logger.error(`fallback reply failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
    }
    return;
  }

  // ── 构建 UserMessage → followup ──
  // 原文留档：轮次失败后「重发」只能靠它再开一轮（宿主没有重跑已结束一轮的 API）
  record.lastPrompt = agentBody;
  const message = createQQUserMessage(agentBody);

  // followup 写进宿主的 next-turn inbox：目标空闲时立刻开一轮，正在生成时排在
  // 本轮之后由宿主按 turn 串行处理，不会打断当前这轮。
  //
  // 因此这里绝不能 await whenIdle()：concurrencyGuard 以 QQ 用户为键，处理函数
  // 挂到本轮结束会把同一个人的所有消息串成一条队列——正在生成的会话会挡住另一个
  // 空闲会话（多会话下表现为「消息发给空闲会话，却在排队」）。
  record.agent.followup(message);
  logger.info(`→ followup sent: key=${scope}:${peerId}`);
}

// ══════════════════════════════════════════════════════════════
// Body Assembly（c2c + quote + attachments）
// ══════════════════════════════════════════════════════════════

/**
 * 组装 agentBody — AI 实际看到的完整上下文
 */
function assembleAgentBody(
  msg: ProcessedMessage,
  state: MiddlewareState,
  logger: Logger,
): string | null {
  const userContent = buildUserContent(msg, state, logger);

  if (isEmptyMessage(userContent, msg.attachments)) return null;

  const quotePart = buildQuotePart(state.quote);
  const userMessage = `${quotePart}${userContent}`;

  const dynamicCtx = buildDynamicCtx(msg, state);

  return dynamicCtx ? `${dynamicCtx}${userMessage}` : userMessage;
}

/**
 * 判断消息是否为空：无文本/语音/附件。
 */
function isEmptyMessage(
  userContent: string,
  attachments: RawAttachment[] | undefined,
): boolean {
  if (userContent) return false;
  if (attachments && attachments.length > 0) return false;
  return true;
}

/**
 * Layer 1: 用户文本内容 + 语音转录 + 附件类型标签（媒体路径由 buildDynamicCtx 提供）
 */
function buildUserContent(msg: ProcessedMessage, state: MiddlewareState, logger: Logger): string {
  const parts: string[] = [];

  const text = (msg.content ?? '').trim();
  if (text) {
    parts.push(text);
  }

  const voiceTexts = extractVoiceTexts(msg.attachments, state.processedAttachments, logger);
  if (voiceTexts.length > 0) {
    for (const vt of voiceTexts) {
      const durationTag = vt.duration ? ` (${vt.duration}s)` : '';
      parts.push(`[Voice message${durationTag}] ${vt.text}`);
    }
  }

  // 附件类型标签（媒体路径由 buildDynamicCtx 提供，这里只提示「带了什么」）
  const attachmentTags = buildAttachmentTags(msg.attachments);
  if (attachmentTags) {
    parts.push(attachmentTags);
  }

  return parts.join('\n');
}

/**
 * Layer 2: 引用消息块
 */
function buildQuotePart(quote?: ResolvedQuote): string {
  if (!quote?.text && !quote?.entry?.content) return '';

  const quoteText = quote.text || quote.entry?.content || 'Original content unavailable';

  return `[Quoted message begins]\n${quoteText}\n[Quoted message ends]\n[Current message]\n`;
}

/**
 * Layer 4: 媒体元数据上下文（图片/视频/文件本地路径 + 语音 ASR + 引用附件）
 */
function buildDynamicCtx(msg: ProcessedMessage, state: MiddlewareState): string {
  const lines: string[] = [];

  if (msg.attachments && msg.attachments.length > 0) {
    const downloadedByFilename = new Map((state.downloadedFiles ?? []).map(d => [d.filename, d]));
    const voices: RawAttachment[] = [];

    // 一次遍历归类 + 生成媒体行
    for (const att of msg.attachments) {
      const kind = classifyContentType(att.content_type);
      if (kind === 'voice') {
        voices.push(att);
        continue;
      }
      const d = downloadedByFilename.get(att.filename);
      lines.push(`- ${renderMediaLine(kind, att.filename, d?.localPath, att.url, att.size)}`);
    }

    // 语音：有 ASR 文本才带文本，否则只带链接（纯文本模型无法消费音频）
    if (voices.length > 0) {
      const asrTexts = voices.map(a => a.asr_refer_text).filter(Boolean);
      if (asrTexts.length > 0) {
        lines.push(`- ASR: ${asrTexts.join(' | ')}`);
      } else {
        const urls = voices.map(a => a.url).filter(Boolean);
        if (urls.length > 0) lines.push(`- Voice: ${urls.join(', ')}`);
      }
    }
  }

  // 引用消息的附件（独立于当前消息媒体，不受上一步为空影响）
  const quoteAttachments = state.quote?.attachments;
  if (quoteAttachments && quoteAttachments.length > 0) {
    const downloadedQuote = new Map((state.downloadedQuoteFiles ?? []).map(d => [d.filename, d]));
    lines.push('[Reference attachments]');
    for (const qa of quoteAttachments) {
      const kind = classifyContentType(qa.contentType);
      const d = downloadedQuote.get(qa.filename ?? '');
      if (kind === 'voice') {
        if (qa.asrText) lines.push(`  - Voice: ${qa.asrText}`);
        continue;
      }
      lines.push(`  - ${renderMediaLine(kind, qa.filename, d?.localPath, qa.url, undefined)}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}

/**
 * 渲染单个媒体附件（image/video/file）的上下文行内容，不含列表前缀。
 * 当前消息与引用消息共用，保证附件格式统一。语音不在此处理（见 buildDynamicCtx）。
 */
function renderMediaLine(
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

// ══════════════════════════════════════════════════════════════
// 辅助函数
// ══════════════════════════════════════════════════════════════

interface VoiceText {
  text: string;
  duration?: number;
  source: 'stt' | 'asr' | 'fallback';
}

function extractVoiceTexts(
  attachments?: RawAttachment[],
  processed?: ProcessedAttachment[],
  _logger?: Logger,
): VoiceText[] {
  const results: VoiceText[] = [];

  if (processed) {
    for (const pa of processed) {
      if (pa.type === 'voice' && pa.voiceText) {
        results.push({
          text: pa.voiceText,
          duration: pa.duration,
          source: pa.voiceSource ?? 'stt',
        });
      }
    }
  }

  if (results.length === 0 && attachments) {
    for (const att of attachments) {
      if (isVoiceContentType(att.content_type) && att.asr_refer_text) {
        results.push({
          text: att.asr_refer_text.trim(),
          source: 'asr',
        });
      }
    }
  }

  return results;
}

/**
 * 附件类型标签（Layer 1 用户消息主体里的轻量提示）。
 * 只标注「带了什么类型的附件」，去重；媒体本地路径在 buildDynamicCtx 提供。
 */
function buildAttachmentTags(attachments?: RawAttachment[]): string {
  if (!attachments || attachments.length === 0) return '';

  const labels: Record<string, string> = {
    image: '[图片]',
    video: '[视频]',
    file: '[文件]',
  };

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const att of attachments) {
    const kind = classifyContentType(att.content_type);
    if (kind === 'voice' || seen.has(kind)) continue;
    seen.add(kind);
    const label = labels[kind];
    if (label) tags.push(label);
  }

  return tags.join(' ');
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
