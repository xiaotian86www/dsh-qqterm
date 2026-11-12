/**
 * 被动回复凭证装饰器 — 把 msg_id / event_id 的解析下沉到 bot 实例。
 *
 * 业务层只传「想回给谁」（ReplyTarget），由这里统一决定能不能走被动回复：
 *   - 有可用凭证 → 填 msg_id（或 event_id）发出去；
 *   - 全不可用 → 不填凭证，SDK 自动降级为主动推送。
 *
 * 为什么必须装饰实例而不是在各自 adapter 里 resolve：SDK 内部的
 * slashCommand 返回值、errorHandler、typingIndicator 直接调 ctx.bot 的方法，
 * 这些调用点不在插件代码里，只有装饰实例才能覆盖。
 *
 * `send` 不装饰：它是低层原语，event_id 就靠它传 extra；装饰会导致二次解析。
 *
 * 流式没法降级成事件回复：resolve 不到 msg_id 时 openStream 返回 undefined，
 * 由调用方转静态发送（少一次「先 peek 再 resolve」的竞态判断）。
 */
import { MsgType } from '@tencent-connect/qqbot-nodejs';
import type { InlineKeyboard, QQBot } from '@tencent-connect/qqbot-nodejs';
import type { ReplyTarget } from '../types.ts';
import type { ReplyStore } from './reply-store.ts';

type AnyFn = (...args: unknown[]) => unknown;

/** 第一个参数就是 target 的方法：解析后原位替换，其余参数原样传 */
const TARGET_FIRST_METHODS = ['sendText', 'sendTextWithKeyboard'] as const;

function bindMethod(bot: QQBot, name: string): AnyFn | undefined {
  const fn = (bot as unknown as Record<string, unknown>)[name];
  return typeof fn === 'function' ? (fn as AnyFn).bind(bot) : undefined;
}

/**
 * 就地装饰 bot 实例的所有发送方法，返回同一个实例。
 *
 * @throws 当实例缺少低层 `send()` 时（SDK 版本不兼容），宁可启动失败也不要静默丢消息。
 */
export function createReplyAwareBot(bot: QQBot, store: ReplyStore): QQBot {
  const target = bot as unknown as Record<string, unknown>;
  const send = bindMethod(bot, 'send');
  if (send === undefined) {
    throw new Error('QQBot 实例缺少 send()，无法接管被动回复');
  }

  const markdown = bindMethod(bot, 'sendMarkdown');
  if (markdown !== undefined) {
    target['sendMarkdown'] = (
      replyTarget: ReplyTarget,
      content: string,
      opts?: { keyboard?: InlineKeyboard },
    ): unknown => {
      const resolved = store.resolve(replyTarget, true);
      if (resolved.eventId !== undefined) {
        // SDK sendMarkdown 不支持 event_id，只能走低层 send 的 extra。
        // msg_seq 必须每次不同：平台按 (event_id, msg_seq) 去重，缺省时 SDK 恒填 1。
        return send({
          target: { scope: resolved.scope, targetId: resolved.targetId, msgId: undefined },
          msgType: MsgType.MARKDOWN,
          markdown: { content },
          keyboard: opts?.keyboard,
          extra: { event_id: resolved.eventId, msg_seq: resolved.msgSeq },
        });
      }
      return markdown(resolved, content, opts);
    };
  }

  for (const name of TARGET_FIRST_METHODS) {
    const original = bindMethod(bot, name);
    if (original === undefined) continue;
    target[name] = (replyTarget: ReplyTarget, ...rest: unknown[]): unknown =>
      original(store.resolve(replyTarget, false), ...rest);
  }

  // 媒体只在这一层解析凭证：SDK 的 sendImage / sendVideo / sendVoice / sendFile
  // 都委托给 `this.sendMedia({ target, ...source })`，target 在参数对象里。
  // 便利方法不再单独解析（否则同一次发送会记两次用量、吃掉被动回复额度），
  // 外层调用进来后统一由 sendMedia 填 msgId。
  const sendMedia = bindMethod(bot, 'sendMedia');
  if (sendMedia !== undefined) {
    target['sendMedia'] = (opts: { target: ReplyTarget } & Record<string, unknown>): unknown =>
      sendMedia({ ...opts, target: store.resolve(opts.target, false) });
  }

  const openStream = bindMethod(bot, 'openStream');
  if (openStream !== undefined) {
    target['openStream'] = (params: { target: ReplyTarget } & Record<string, unknown>): unknown => {
      const resolved = store.resolve(params.target, false);
      // 没有 msg_id 就开不了流（SDK 会抛），直接返回 undefined 让调用方走静态
      if (resolved.msgId === undefined) return undefined;
      return openStream({ ...params, target: resolved });
    };
  }

  return bot;
}
