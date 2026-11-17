/**
 * SessionConfirmChannel — 「重置 / 新建会话」的二次确认卡片。
 *
 * `/clear`、`/clear all`、`/new` 在有会话时会停掉或切走它，误触代价高。
 * 命令层不直接执行，而是把动作包成闭包交给这里：先发一张确认卡，点「确认」
 * 才执行闭包，点「取消」什么都不做。卡片 5 分钟过期，发新命令 / 会话被释放
 * 都会作废旧卡片。
 *
 * 与 RetryChannel 同一套键盘协议（button_data 顶层 `t`），点击由
 * `dispatchInteraction` 路由过来；owner 校验在网关侧完成。
 */
import type { InlineKeyboard, InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import type { Logger, ReplyTarget } from '../types.ts';
import { buttonLabel, decodeButtonData, encodeButtonData } from './button-utils.ts';

/** 确认卡有效期：过期的按钮点了没有任何反应 */
const CONFIRM_TTL_MS = 5 * 60_000;

export type SessionConfirmAction = 'reset' | 'reset-all' | 'new';

export interface SessionConfirmRequest {
  action: SessionConfirmAction;
  /** 发起确认时的当前会话 id：点按钮时会话变了就作废，避免停掉别的会话 */
  currentId?: string;
  /** 确认卡的投递目标（命令回复的 replyTarget） */
  target: ReplyTarget;
  /** 用户确认后真正执行的动作，返回回执文案 */
  run: () => Promise<string>;
}

export interface SessionConfirmManagerLike {
  currentSessionId?(): string | undefined;
}

export interface SessionConfirmSenderLike {
  sendMarkdown(target: ReplyTarget, content: string, opts?: { keyboard?: InlineKeyboard }): Promise<unknown>;
}

interface PendingConfirm {
  action: SessionConfirmAction;
  currentId?: string;
  target: ReplyTarget;
  run: () => Promise<string>;
  timer?: ReturnType<typeof setTimeout>;
}

/** 卡片正文：第一行说清后果，第二行给操作提示 */
function confirmText(action: SessionConfirmAction): string {
  if (action === 'new') {
    return ['⚠️ 当前会话还在，仍要新建？', '> 👇 点「确认」继续，5 分钟内有效'].join('\n');
  }
  const scope = action === 'reset-all' ? '全部' : '当前';
  return [`⚠️ 重置会停掉${scope}会话`, '> 👇 点「确认」继续，5 分钟内有效'].join('\n');
}

/** 两个按钮：确认 / 取消，button_data 带 nonce 与决策 */
export function buildConfirmKeyboard(nonce: string): InlineKeyboard {
  const payload = (decision: 'yes' | 'no'): string => encodeButtonData({ t: 'confirm', n: nonce, d: decision });
  const confirm = {
    id: `confirm-yes-${nonce}`,
    render_data: {
      label: buttonLabel('✅ 确认'),
      visited_label: '✓ 已确认',
      style: 1,
    },
    action: {
      type: 1,
      permission: { type: 2 },
      click_limit: 1,
      data: payload('yes'),
    },
  };
  const cancel = {
    id: `confirm-no-${nonce}`,
    render_data: { label: buttonLabel('❌ 取消'), visited_label: '✓ 已取消', style: 0 },
    action: {
      type: 1,
      permission: { type: 2 },
      click_limit: 1,
      data: payload('no'),
    },
  };
  return { content: { rows: [{ buttons: [confirm, cancel] }] } };
}

/** nonce 只需在同一进程内区分新旧卡片 */
let nonceSeq = 0;

export class SessionConfirmChannel {
  /** 同一聊天只留最新一张卡：发新卡即作废旧卡 */
  private pending?: PendingConfirm & { nonce: string };
  private readonly manager: SessionConfirmManagerLike;
  private readonly sender: SessionConfirmSenderLike;
  private readonly logger: Logger;

  public constructor(manager: SessionConfirmManagerLike, sender: SessionConfirmSenderLike, logger: Logger) {
    this.manager = manager;
    this.sender = sender;
    this.logger = logger;
  }

  /**
   * 发确认卡。
   *
   * @returns true = 卡片已送达、等待点击；false = 发送失败，调用方应放弃本次动作
   *          （失败不能退回「直接执行」：那等于没有二次确认）。
   */
  public async offer(request: SessionConfirmRequest): Promise<boolean> {
    this.cancelPending();
    const nonce = `${Date.now().toString(36)}-${(nonceSeq++).toString(36)}`;
    try {
      await this.sender.sendMarkdown(request.target, confirmText(request.action), {
        keyboard: buildConfirmKeyboard(nonce),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`qqterm: session confirm send failed: ${message}`);
      return false;
    }

    const timer = setTimeout(() => this.onTimeout(nonce), CONFIRM_TTL_MS);
    timer.unref?.();
    this.pending = { ...request, nonce, timer };
    return true;
  }

  /** 按钮点击：只认最新一张卡的 nonce，过期 / 旧卡片的点击直接忽略 */
  public handleInteraction(event: InteractionEvent): boolean {
    const raw = event.data?.resolved?.button_data;
    if (!raw) return false;
    const button = decodeButtonData(raw);
    if (!button || button.t !== 'confirm') return false;

    const pending = this.pending;
    if (!pending || pending.nonce !== button.n) return false;

    this.cancelPending();
    if (button.d === 'no') {
      void this.reply(pending.target, '✅ 已取消');
      return true;
    }
    void this.execute(pending);
    return true;
  }

  /** 会话释放 / 渠道回退 / 卸载：清掉待确认状态与定时器 */
  public cancelPending(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    if (pending.timer) clearTimeout(pending.timer);
  }

  private onTimeout(nonce: string): void {
    const pending = this.pending;
    if (!pending || pending.nonce !== nonce) return;
    this.pending = undefined;
    this.logger.debug('qqterm: session confirm expired');
  }

  private async execute(pending: PendingConfirm): Promise<void> {
    // 卡片发出后会话变了（例如 Web 端切了会话）：别把新会话停掉
    const currentId = this.manager.currentSessionId?.();
    if (pending.currentId !== undefined && currentId !== pending.currentId) {
      await this.reply(pending.target, '⚠️ 当前会话已变化，重新发一次命令。');
      return;
    }
    try {
      await this.reply(pending.target, await pending.run());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`qqterm: session confirm action failed: ${message}`);
      await this.reply(pending.target, `❌ 操作失败: ${message}\n稍等片刻再试一次。`);
    }
  }

  private reply(target: ReplyTarget, text: string): Promise<void> {
    return this.sender
      .sendMarkdown(target, text)
      .then(() => {})
      .catch((err: unknown) => {
        this.logger.error(`qqterm: session confirm reply failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }
}
