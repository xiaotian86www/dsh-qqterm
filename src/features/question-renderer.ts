/**
 * QQ 问答的文本渲染与按钮键盘构建（纯函数，便于单测）。
 *
 * 逐题渲染：一次只渲染一个问题（多题时由状态机逐题推进）。
 */
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';
import type { UserQuestion } from './question-channel.ts';
import { sessionReplyLink, sessionResumeLink, sessionSourceHeader } from '../transport/session-source.ts';
import { BUTTONS_PER_ROW, buttonLabel, encodeButtonData } from './button-utils.ts';

/** 渲染上下文：非当前会话加来源行（id + 标题），无按钮时给回答 / 恢复链接 */
export interface QuestionRenderContext {
  sessionId?: string;
  isCurrent?: boolean;
  /** 会话标题（来源行用；宿主还没生成时用兜底名） */
  title?: string;
}

/**
 * 为「单选、带选项」的问题构建内联键盘；不适用时返回 undefined。
 *
 * 多行多列布局：每行 BUTTONS_PER_ROW 个按钮，减少选项多时的刷屏。
 *
 * button_data 编码 `{"t":"question","s":<会话id>,"q":<问题id>,"i":<选项下标>}`，
 * 由分发器解码。`s` 让非当前会话的按钮也能找回自己的 pending，不依赖 current。
 * `q` 关联「当前正在问的题」：逐题推进时旧题按钮在新题发出后被点击，其 q
 * 不等于当前题 id，可被识别并忽略。
 */
export function buildKeyboard(question: UserQuestion, sessionId?: string): InlineKeyboard | undefined {
  const opts = question.options ?? [];
  if (opts.length === 0 || question.multiSelect) return undefined;

  const rows: InlineKeyboard['content']['rows'] = [];
  for (let i = 0; i < opts.length; i += BUTTONS_PER_ROW) {
    rows.push({
      buttons: opts.slice(i, i + BUTTONS_PER_ROW).map((o, offset) => {
        const idx = i + offset;
        return {
          id: `q-${question.id}-opt-${idx}`,
          render_data: {
            label: buttonLabel(o.label),
            visited_label: '✓ 已选',
            style: 1,
          },
          action: {
            type: 1,
            permission: { type: 2 },
            click_limit: 1,
            data: encodeButtonData({
              t: 'question',
              ...(sessionId !== undefined ? { s: sessionId } : {}),
              q: question.id,
              i: idx,
            }),
          },
          // 互斥交给状态机：首答即结算，后续点击因 pending 已清或问题 id
          // 不匹配而被忽略，不需要键盘层面的分组约束。
        };
      }),
    });
  }
  return { content: { rows } };
}

/** 把单个问题渲染成 QQ 文本 */
export function formatQuestion(
  question: UserQuestion,
  withButtons: boolean,
  context: QuestionRenderContext = {},
): string {
  const lines: string[] = [];
  const nonCurrent = context.sessionId !== undefined && context.isCurrent === false;

  // 非当前会话：来源行独占首行，与消息的标注格式保持一致（id + 标题，不带图标）
  if (nonCurrent && context.sessionId !== undefined) {
    lines.push(sessionSourceHeader(context.sessionId, context.title), '');
  }

  // 标题行：与其他视图一样先给「图标 + 是什么」，避免整条消息看起来像模型正文；
  // header 是宿主给的主题，有就拿来当标题，没有就用通用的。
  const header = question.header?.trim();
  lines.push(`### ❓ ${header ? header : '需要你的回答'}`, '');

  const opts = question.options ?? [];
  const multi = question.multiSelect === true;

  // 问题行：多选标记前置，用户第一眼就知道作答方式
  const body = question.question.trim();
  lines.push(multi ? `${body}（可多选）` : body);

  // 选项列表：保留完整 label + description（按钮 label 截断时 description 靠正文展示）
  opts.forEach((o, i) => {
    lines.push(`${i + 1}. ${o.label}${o.description ? ` · ${o.description}` : ''}`);
  });

  // 底部引导：用引用块（>）与正文区分
  if (nonCurrent) {
    lines.push('');
    if (withButtons) {
      lines.push('> 👇 点击下方按钮选择');
    } else if (context.sessionId !== undefined) {
      lines.push(`> ${sessionReplyLink(context.sessionId, '回答')} · ${sessionResumeLink(context.sessionId)}`);
    }
  } else if (opts.length > 0) {
    lines.push('');
    if (withButtons) {
      lines.push('> 👇 点击下方按钮选择，或回复编号');
    } else if (multi) {
      lines.push('> 💡 回复多个编号即可多选（如 1,3），或直接输入你的想法');
    } else {
      lines.push('> 💡 回复编号选择，或直接输入你的想法');
    }
  }

  return lines.join('\n');
}
