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

/** 从消息内容里挑出 image 块（去重、跳过已 offload 的块，非法引用直接忽略） */
export function collectImageBlocks(content: readonly MessageContentBlock[]): ImageAttachmentLike[] {
  const seen = new Set<string>();
  const refs: ImageAttachmentLike[] = [];
  for (const block of content) {
    if (block.type !== 'image' || block.offloaded === true) continue;
    const ref = block.attachment;
    if (ref === undefined || typeof ref.attachmentId !== 'string' || ref.attachmentId === '') continue;
    if (seen.has(ref.attachmentId)) continue;
    seen.add(ref.attachmentId);
    refs.push({
      attachmentId: ref.attachmentId,
      mediaType: typeof ref.mediaType === 'string' ? ref.mediaType : '',
      ...(typeof ref.width === 'number' ? { width: ref.width } : {}),
      ...(typeof ref.height === 'number' ? { height: ref.height } : {}),
      ...(typeof ref.name === 'string' ? { name: ref.name } : {}),
    });
  }
  return refs;
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
