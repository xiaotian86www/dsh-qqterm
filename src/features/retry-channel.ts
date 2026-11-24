/**
 * RetryChannel — 轮次因可重试错误失败后，询问用户是否重发上一条消息。
 *
 * 背景：宿主没有「重跑已结束的一轮」的 API（Agent 只有 followup / cancel /
 * steer…），所以插件侧的重发只能再开一轮，历史里会多出一条相同的用户消息——
 * 这是明确接受的代价，换来「不重打原文就能再试一次」。
 *
 * 只在 turn/end 的失败可重试（RETRYABLE_FAILURE_CODES）且拿到原文时挂按钮；
 * 卡片超时、会话回收、用户点「放弃」都会清掉待重发状态。
 */
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import type { Sender } from '../transport/send.ts';
import { createQQUserMessage } from '../session/user-message.ts';
import { isOwner, errorMessage } from '../shared/utils.ts';
import type { ChannelSender } from '../transport/send.ts';
import { buildRetryKeyboard, formatRetryOffer, type TurnFailureInfo } from './retry-renderer.ts';
import { decodeButtonData } from './button-utils.ts';

// ── 依赖接口（结构化，便于单测） ──

export interface RetrySessionRecordLike {
  sessionId: string;
  /** 该会话属于哪个 QQ 用户（按钮点击者校验用） */
  peerId?: string;
  scope: ChatScope;
  replyTarget: ReplyTarget;
  /** 最近一条用户消息的原文；没有就不能重发 */
  lastPrompt?: string;
  agent: { followup(message: unknown): void };
}

export interface RetryChannelConfigLike {
  retryOffer: { enabled: boolean; timeoutMs: number };
  access: { owner: string };
}

interface PendingRetry {
  record: RetrySessionRecordLike;
  timer?: ReturnType<typeof setTimeout>;
}

export class RetryChannel {
  /** 待确认的重发：sessionId → 状态（同一会话只留最新一张卡） */
  private readonly pending = new Map<string, PendingRetry>();
  /** 卡片 / 文本 + 非当前会话署名：署名规则只在 sender 里实现一次 */
  private readonly sender: ChannelSender & Pick<Sender, 'decorate'>;
  private readonly config: RetryChannelConfigLike;
  private readonly logger: Logger;

  public constructor(
    sender: ChannelSender & Pick<Sender, 'decorate'>,
    config: RetryChannelConfigLike,
    logger: Logger,
  ) {
    this.sender = sender;
    this.config = config;
    this.logger = logger;
  }

  /** 是否启用（关闭时调用方直接发普通失败文案） */
  public get enabled(): boolean {
    return this.config.retryOffer?.enabled !== false;
  }

  /**
   * 询问是否重发上一条消息。
   *
   * @returns true = 卡片（或降级文本）已送达；false = 没有可重发原文 / 未启用 / 发送失败，
   *          调用方应改发普通失败文案。
   */
  public async offer(
    record: RetrySessionRecordLike,
    failure: TurnFailureInfo,
    retries: number,
  ): Promise<boolean> {
    if (!this.enabled) return false;
    const prompt = record.lastPrompt;
    if (prompt === undefined || prompt.trim() === '') return false;

    const sessionId = record.sessionId;
    // 上一张卡还挂着：直接作废，避免两张卡都能点
    this.cancelPending(sessionId);

    let delivered = false;
    try {
      // 带按钮的正文 + 无按钮兜底一起交给 sender：键盘不可用时正文仍有下一步（发 /retry）
      await this.sender.card(
        record.replyTarget,
        this.sender.decorate(sessionId, formatRetryOffer(failure, retries, true)),
        buildRetryKeyboard(sessionId),
        this.sender.decorate(sessionId, formatRetryOffer(failure, retries, false)),
      );
      delivered = true;
    } catch (err) {
      this.logger.error(`qqterm: retry notice send failed: ${errorMessage(err)}`);
    }
    // 降级成纯文本时不再有待确认状态：按钮不存在，等待也没有意义
    if (!delivered) return false;

    const timeoutMs = this.config.retryOffer.timeoutMs;
    if (timeoutMs > 0) {
      const timer = setTimeout(() => this.onTimeout(sessionId), timeoutMs);
      timer.unref?.();
      this.pending.set(sessionId, { record, timer });
    }
    return true;
  }

  /** 按钮点击：按 button_data 的 `s` 找会话，过期卡片 / 别人的卡片忽略 */
  public handleInteraction(event: InteractionEvent): boolean {
    const peerId = event.user_openid;
    if (!peerId) return false;
    // 重发卡也只认绑定用户：会话记录缺 peerId 时同样不能放行
    if (!isOwner(this.config.access.owner, peerId)) return false;

    const raw = event.data?.resolved?.button_data;
    if (!raw) return false;
    const button = decodeButtonData(raw);
    if (!button || button.t !== 'retry') return false;

    const sessionId = button.s;
    if (sessionId === undefined) return false;
    const entry = this.pending.get(sessionId);
    if (!entry) return false;
    if (entry.record.peerId !== undefined && entry.record.peerId !== peerId) return false;

    this.cancelPending(sessionId);
    if (button.d === 'discard') {
      void this.send(entry.record, sessionId, '✅ 已放弃重发');
      return true;
    }
    this.resend(entry.record, sessionId);
    return true;
  }

  /** 会话回收 / 卸载时清掉待确认状态，避免 timer 与闭包泄漏 */
  public cancelPending(sessionId: string): void {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    this.pending.delete(sessionId);
    if (entry.timer) clearTimeout(entry.timer);
  }

  /** 卸载：清掉全部待确认状态 */
  public uninstall(): void {
    for (const [sessionId] of this.pending) this.cancelPending(sessionId);
  }

  /** 重发原文：唯一的「开新一轮」入口 */
  private resend(record: RetrySessionRecordLike, sessionId: string): void {
    const prompt = record.lastPrompt;
    if (prompt === undefined || prompt.trim() === '') {
      void this.send(record, sessionId, '⚠️ 找不到上一条消息');
      return;
    }
    try {
      record.agent.followup(createQQUserMessage(prompt));
    } catch (err) {
      const message = errorMessage(err);
      this.logger.error(`qqterm: retry followup failed sessionId=${sessionId}: ${message}`);
      void this.send(record, sessionId, `⚠️ 重发失败: ${message}`);
      return;
    }
    this.logger.info(`qqterm: prompt resent via retry button sessionId=${sessionId}`);
    void this.send(record, sessionId, '✅ 已重发上一条消息');
  }

  private onTimeout(sessionId: string): void {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    this.pending.delete(sessionId);
    entry.timer = undefined;
    this.logger.debug(`qqterm: retry offer expired sessionId=${sessionId}`);
  }

  private send(record: RetrySessionRecordLike, sessionId: string, body: string): Promise<void> {
    return this.sender
      .text(record.replyTarget, this.sender.decorate(sessionId, body))
      .then(() => {})
      .catch((err: unknown) => {
        this.logger.error(`qqterm: retry reply send failed: ${errorMessage(err)}`);
      });
  }
}
