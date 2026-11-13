/**
 * 出站图片 — assistant/message 里的 image 内容块 → QQ 图片消息
 *
 * 助手消息的图片块只有不透明的 attachmentId（宿主 attachment 服务持有字节），
 * 这里换成宿主文件路径或内存字节后走 `bot.sendImage`。所有 QQ 媒体发送都经
 * createReplyAwareBot 装饰器，被动凭证（event_id）自动带上。
 */
import type { SessionRecord } from '../session/index.ts';
import type { Logger } from '../types.ts';
import type { MessageContentBlock } from './events.ts';
import { resolveLocalFile } from './file-links.ts';

/** 图片块引用（宿主 ImageAttachmentRef 里本模块用到的字段） */
export interface ImageAttachmentLike {
  attachmentId: string;
  mediaType: string;
  width?: number;
  height?: number;
  name?: string;
}

/** 出站图片发送接口（SDK 的 sendImage 形状） */
export interface ImageSenderLike {
  sendImage(
    target: SessionRecord['replyTarget'],
    source: { localPath?: string; buffer?: Buffer },
  ): Promise<unknown>;
}

/** 宿主 attachment 服务里本模块用到的方法（两者之一有即可） */
export interface AttachmentReaderLike {
  /** 宿主文件后端：直接给出规范化对象的绝对路径 */
  imageHostPath?(ref: ImageAttachmentLike): string | undefined;
  /** 其余后端：读回字节（返回 { ref, data }） */
  readImage?(ref: ImageAttachmentLike, signal?: AbortSignal): Promise<{ data: Uint8Array }>;
}

/** 消息内容的有序片段：一段文本或一组相邻图片 */
export type MessageSegment =
  | { kind: 'text'; text: string }
  | { kind: 'image'; refs: ImageAttachmentLike[] }
  /** 正文里 `![alt](本地路径)` 引用的图片，paths 已解析成绝对路径 */
  | { kind: 'image-file'; paths: string[] };

/** 把 image 块归一化成发送用的引用；非法引用返回 undefined */
function imageRefOf(block: MessageContentBlock): ImageAttachmentLike | undefined {
  if (block.offloaded === true) return undefined;
  const ref = block.attachment;
  if (ref === undefined || typeof ref.attachmentId !== 'string' || ref.attachmentId === '') return undefined;
  return {
    attachmentId: ref.attachmentId,
    mediaType: typeof ref.mediaType === 'string' ? ref.mediaType : '',
    ...(typeof ref.width === 'number' ? { width: ref.width } : {}),
    ...(typeof ref.height === 'number' ? { height: ref.height } : {}),
    ...(typeof ref.name === 'string' ? { name: ref.name } : {}),
  };
}

/** 从消息内容里挑出 image 块（去重、跳过已 offload 的块，非法引用直接忽略） */
export function collectImageBlocks(content: readonly MessageContentBlock[]): ImageAttachmentLike[] {
  const refs: ImageAttachmentLike[] = [];
  for (const block of content) {
    if (block.type !== 'image') continue;
    const ref = imageRefOf(block);
    if (ref === undefined) continue;
    if (!refs.some((item) => item.attachmentId === ref.attachmentId)) refs.push(ref);
  }
  return refs;
}

/**
 * 按内容块顺序切成文本段与图片组（相邻图片归一组，同一附件只发一次）。
 *
 * 出站据此在文本之间按原位置插图，而不是把整条消息的图片统一挪到最后。
 */
export function segmentMessageContent(content: readonly MessageContentBlock[]): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const seen = new Set<string>();
  let text: string[] = [];
  let images: ImageAttachmentLike[] = [];

  const flushText = () => {
    if (text.length > 0) segments.push({ kind: 'text', text: text.join('\n') });
    text = [];
  };
  const flushImages = () => {
    if (images.length > 0) segments.push({ kind: 'image', refs: images });
    images = [];
  };

  for (const block of content) {
    if (block.type === 'text') {
      flushImages();
      text.push(typeof block.text === 'string' ? block.text : '');
      continue;
    }
    if (block.type !== 'image') continue;
    const ref = imageRefOf(block);
    if (ref === undefined || seen.has(ref.attachmentId)) continue;
    seen.add(ref.attachmentId);
    flushText();
    images.push(ref);
  }

  flushText();
  flushImages();
  return segments;
}

/** QQ 图片消息支持的本地图片扩展名 */
const IMAGE_FILE = /\.(?:png|jpe?g|webp|gif)$/i;

/** `![alt](target)`：形状与 file-links 的 LINK 相同，但前面带 `!` */
const MD_IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;

/**
 * 把正文里的 `![alt](本地图片)` 拆成图片段。
 *
 * 模型常把图直接写成 markdown 图片，而 QQ 不渲染本地路径图片：只有换成真正的
 * 图片消息才看得见，留在正文里则只是一行点不开的文本。路径必须真实存在且是
 * 支持的图片类型，否则保持原文；相邻图片（中间只有空白）归一组，按原位置
 * 插在文本段之间。
 */
export function splitMarkdownImages(text: string, cwd: string | undefined): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let last = 0;
  const pushText = (part: string): void => {
    if (part !== '') segments.push({ kind: 'text', text: part });
  };

  for (const match of text.matchAll(MD_IMAGE)) {
    const rawTarget = match[2] ?? '';
    const target = rawTarget.startsWith('<') ? rawTarget.slice(1, -1) : rawTarget;
    const absolute = resolveLocalFile(target, cwd);
    if (absolute === undefined || !IMAGE_FILE.test(absolute)) continue;

    const start = match.index ?? 0;
    const between = text.slice(last, start);
    const previous = segments[segments.length - 1];
    if (between.trim() === '' && previous !== undefined && previous.kind === 'image-file') {
      previous.paths.push(absolute);
    } else {
      pushText(between);
      segments.push({ kind: 'image-file', paths: [absolute] });
    }
    last = start + match[0].length;
  }

  pushText(text.slice(last));
  return segments;
}

export class OutboundImages {
  private readonly bot: ImageSenderLike;
  private readonly attachments: AttachmentReaderLike | undefined;
  private readonly logger: Logger;

  public constructor(bot: ImageSenderLike, attachments: AttachmentReaderLike | undefined, logger: Logger) {
    this.bot = bot;
    this.attachments = attachments;
    this.logger = logger;
  }

  /**
   * 逐张发送图片：单张失败只记日志，不影响后续图片与已在排队的文本。
   * 调用方负责放进每会话发送链（保证排在文本之后）。
   */
  public async send(record: SessionRecord, refs: readonly ImageAttachmentLike[]): Promise<void> {
    for (const ref of refs) {
      try {
        const source = await this.resolve(ref);
        if (source === undefined) {
          this.logger.debug(`qqterm: 图片无法定位附件 attachmentId=${ref.attachmentId}`);
          continue;
        }
        await this.bot.sendImage(record.replyTarget, source);
      } catch (err) {
        this.logger.warn(
          `qqterm: 图片发送失败 attachmentId=${ref.attachmentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * 逐张发送正文里引用的本地图片（路径已验真）：单张失败只记日志，
   * 不影响后续图片与已在排队的文本。
   */
  public async sendPaths(record: SessionRecord, paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      try {
        await this.bot.sendImage(record.replyTarget, { localPath: path });
      } catch (err) {
        this.logger.warn(
          `qqterm: 图片发送失败 path=${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** 优先用宿主文件路径（免读字节）；非文件后端退回 readImage 的原始字节 */
  private async resolve(ref: ImageAttachmentLike): Promise<{ localPath?: string; buffer?: Buffer } | undefined> {
    const store = this.attachments;
    if (store === undefined) return undefined;

    if (store.imageHostPath !== undefined) {
      const path = store.imageHostPath(ref);
      if (path !== undefined && path !== '') return { localPath: path };
    }
    if (store.readImage === undefined) return undefined;

    const stored = await store.readImage(ref);
    if (stored.data.length === 0) return undefined;
    return { buffer: Buffer.from(stored.data) };
  }
}
