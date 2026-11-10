/**
 * QQ 审批的文本渲染与按钮键盘构建（纯函数，便于单测）。
 *
 * 单次审批：一次只渲染一个审批请求（每个会话同时只有一个 pending 审批）。
 */
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';
import type { ApprovalRequest } from './approval-channel.ts';
import { sessionSourceHeader } from '../transport/session-source.ts';
import { encodeButtonData } from './button-utils.ts';

/** 渲染上下文：非当前会话的审批带来源行（id + 标题） */
export interface ApprovalRenderContext {
  sessionId?: string;
  isCurrent?: boolean;
  /** 会话标题（来源行用；宿主还没生成时用兜底名） */
  title?: string;
}

/** 把审批请求渲染成 QQ 文本（含被 gate 的命令回显） */
export function buildApprovalText(
  request: ApprovalRequest,
  command?: string,
  context: ApprovalRenderContext = {},
): string {
  const nonCurrent = context.sessionId !== undefined && context.isCurrent === false;
  const lines: string[] = [];
  // 与消息、提问同一套来源行：id + 标题，不带图标。来源行是引用块（`>`），
  // 必须与卡片正文之间空一行才能结束引用：只换一行的话 markdown 的 lazy
  // continuation 会把整张卡片吞进引用块里。
  if (nonCurrent && context.sessionId !== undefined) {
    lines.push(sessionSourceHeader(context.sessionId, context.title), '');
  }
  // 标题用加粗行（与问答卡片一致，不用 markdown 标题，避免字号被放大），标题后留一个空行。
  lines.push('**🔐 执行审批**', '');
  lines.push(`🔧 工具: ${request.toolName}`);
  if (command) {
    lines.push('');
    lines.push('```');
    lines.push(command);
    lines.push('```');
  }
  if (request.reason) {
    lines.push('');
    lines.push(`📝 ${request.reason}`);
  }
  lines.push('');
  lines.push('> 👇 点击下方按钮确认是否允许执行');
  return lines.join('\n');
}

/**
 * 构建审批键盘：两按钮（允许一次 / 拒绝），button_data 携带本审批的 nonce
 * 与所属会话 id。
 *
 * dsh 审批协议 outcome 是闭合集合（allowed-once/rejected/cancelled/unavailable），
 * 无 allow-always，因此只提供两个按钮。
 * nonce 与 pending 匹配，旧卡片/其它会话卡片点击不 settle（#94-3）。
 */
export function buildApprovalKeyboard(nonce?: string, sessionId?: string): InlineKeyboard {
  const payload = (decision: 'allow' | 'deny'): string => encodeButtonData({
    t: 'approval',
    ...(sessionId !== undefined ? { s: sessionId } : {}),
    d: decision,
    ...(nonce !== undefined ? { n: nonce } : {}),
  });
  const allow = {
    id: 'approval-allow',
    render_data: { label: '✅ 允许一次', visited_label: '✓ 已允许', style: 1 },
    action: {
      type: 1,
      permission: { type: 2 },
      click_limit: 1,
      data: payload('allow'),
    },
  };
  const deny = {
    id: 'approval-deny',
    render_data: { label: '❌ 拒绝', visited_label: '✓ 已拒绝', style: 0 },
    action: {
      type: 1,
      permission: { type: 2 },
      click_limit: 1,
      data: payload('deny'),
    },
  };
  return { content: { rows: [{ buttons: [allow, deny] }] } };
}
