/**
 * 按钮渲染与 button_data 编码的共享工具（QuestionChannel / ApprovalChannel 共用）。
 *
 * 统一 button_data 编码：所有回调按钮的 data 都带顶层 `t` 判别字段，
 * 供 `dispatchInteraction` 分发器统一路由到对应 channel，避免多通道
 * 各自 try 导致误判。
 */
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';

/** QQ 按钮 label 有长度限制，超长截断（正文保留完整文本；多列布局下阈值更短） */
export const BUTTON_LABEL_MAX = 10;

/** 单选按钮每行个数（多列布局，减少选项多时的刷屏） */
export const BUTTONS_PER_ROW = 2;

/** 截断按钮 label，超长补省略号 */
export function buttonLabel(text: string | undefined): string {
  const s = String(text ?? '').trim();
  return s.length > BUTTON_LABEL_MAX ? s.slice(0, BUTTON_LABEL_MAX - 1) + '…' : s;
}

// ── button_data 统一编码 ──

/** 问答按钮：s=会话 id，q=问题 id，i=选项下标 */
export interface QuestionButtonData {
  t: 'question';
  /** 归属会话：多会话时按它找回 pending，不再依赖 current */
  s: string;
  q: string;
  i: number;
}

/** 审批按钮：s=会话 id，d=决策，n=本审批的 nonce（与 pending 匹配，防旧卡片混淆 #94-3） */
export interface ApprovalButtonData {
  t: 'approval';
  /** 归属会话：多会话时按它找回 pending */
  s: string;
  d: 'allow' | 'deny';
  n: string;
}

/** 轮次失败后的重发询问：s=会话 id，d=决策（重发 / 放弃） */
export interface RetryButtonData {
  t: 'retry';
  /** 归属会话：多会话时按它找回待重发的原文 */
  s: string;
  d: 'resend' | 'discard';
}

/** 会话二次确认：n=本次确认的 nonce（旧卡片的点击不生效），d=决策 */
export interface ConfirmButtonData {
  t: 'confirm';
  n: string;
  d: 'yes' | 'no';
}

export type ButtonData = QuestionButtonData | ApprovalButtonData | RetryButtonData | ConfirmButtonData;

/** 编码 button_data（JSON 字符串） */
export function encodeButtonData(data: ButtonData): string {
  return JSON.stringify(data);
}

/** 解码 button_data；非法 JSON 或缺少合法 `t` 时返回 undefined */
export function decodeButtonData(raw: string): ButtonData | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<ButtonData>;
    if (
      parsed !== null
      && typeof parsed === 'object'
      && (parsed.t === 'question' || parsed.t === 'approval' || parsed.t === 'retry' || parsed.t === 'confirm')
    ) {
      return parsed as ButtonData;
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** 构建内联键盘的行数组（供 buildKeyboard/buildApprovalKeyboard 复用类型） */
export type KeyboardRows = InlineKeyboard['content']['rows'];

/** 键盘按钮（行内元素类型） */
export type KeyboardButton = KeyboardRows[number]['buttons'][number];

/** 回调按钮：`style` 1 是建议样式（蓝），0 是默认样式 */
export interface CallbackButtonOptions {
  id: string;
  label: string;
  /** 点击后的回显文案，纯文本（§4.1 允许 ✓ 前缀），不用图标 */
  visitedLabel: string;
  data: ButtonData;
  style?: 0 | 1;
}

/**
 * 构建一个回调按钮。
 *
 * 协议字段（`type: 1` = 回调、`permission: { type: 2 }` = 所有人可点、`click_limit: 1`）
 * 只在这里写一次：四个 renderer 各拼一遍时，漏一个字段就是「点了没反应」。
 * label 由 `buttonLabel()` 截断，调用方传完整文本即可。
 */
export function callbackButton(options: CallbackButtonOptions): KeyboardButton {
  return {
    id: options.id,
    render_data: {
      label: buttonLabel(options.label),
      visited_label: options.visitedLabel,
      style: options.style ?? 1,
    },
    action: {
      type: 1,
      permission: { type: 2 },
      click_limit: 1,
      data: encodeButtonData(options.data),
    },
  };
}
