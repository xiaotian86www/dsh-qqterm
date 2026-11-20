/**
 * 交付物投递 — present 声明的文件在轮末发送到当前 QQ 会话
 *
 * 宿主契约：`deliverables/presented` 事件先于 turn/end 到达；文件按引用交付
 * （不复制内容），读取发生在投递时刻；外层轮次失败不撤销已完成的声明。
 * 每个文件独立投递，失败降级为文字提示，不阻断其余文件。
 *
 * 未送达的提示走 sender 的 text（分片 + 网络类重试），署名走 sender.decorate，
 * 与普通消息同一套「非当前会话」标记，不再自己拼一遍。
 */
import { basename } from 'node:path';
import type { QQTermConfig } from '../config.ts';
import type { SessionRecord } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { sendMediaFile, type MediaSenderLike } from '../media/send-media.ts';
import type { PresentedFileRef } from './events.ts';
import type { Sender } from './send.ts';
import { errorMessage } from '../shared/utils.ts';

/** 交付物只需要「发一段提示」和「加署名」 */
export type DeliverablesSender = Pick<Sender, 'text' | 'decorate'>;

/** 交付物投递器（outbound 路由只依赖此接口，便于测试注入） */
export interface DeliverablesDelivererLike {
  deliver(record: SessionRecord, files: PresentedFileRef[]): Promise<void>;
}

export class DeliverablesDeliverer implements DeliverablesDelivererLike {
  private readonly sender: DeliverablesSender;
  private readonly mediaBot: MediaSenderLike;
  private readonly config: QQTermConfig;
  private readonly logger: Logger;

  public constructor(
    sender: DeliverablesSender,
    mediaBot: MediaSenderLike,
    config: QQTermConfig,
    logger: Logger,
  ) {
    this.sender = sender;
    this.mediaBot = mediaBot;
    this.config = config;
    this.logger = logger;
  }

  /** 轮末投递一批声明文件：逐个发送，未送达的聚合为一条文字提示 */
  public async deliver(record: SessionRecord, files: PresentedFileRef[]): Promise<void> {
    const limit = Math.max(1, this.config.sendFile.maxFiles);
    const missed: string[] = [];
    let sent = 0;

    for (const [index, file] of files.entries()) {
      const display = basename(file.path);
      if (index >= limit) {
        missed.push(`${display}（超出单轮投递上限，未发送）`);
        continue;
      }
      const result = await sendMediaFile(this.mediaBot, record.replyTarget, file.path);
      if (result.outcome === 'sent') {
        sent++;
        this.logger.info(
          `qqterm: 交付物已发送 ${display} (${result.size} bytes) → `
          + `${record.replyTarget.scope}:${record.replyTarget.targetId}`,
        );
      } else if (result.outcome === 'failed') {
        this.logger.warn(`qqterm: 交付物发送失败 ${display}: ${result.error}`);
        missed.push(display);
      } else {
        missed.push(display);
      }
    }

    if (missed.length > 0) {
      const text = ['📎 已生成文件（未能直接发送）：', ...missed.map((name) => `- ${name}`)].join('\n');
      try {
        await this.sender.text(record.replyTarget, this.sender.decorate(record.sessionId, text));
      } catch (err) {
        this.logger.error(
          `qqterm: deliverables notice failed: ${errorMessage(err)}`,
        );
      }
    }
    this.logger.debug(`qqterm: deliverables delivered sent=${sent} missed=${missed.length}`);
  }
}
