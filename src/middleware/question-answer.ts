/**
 * 待答问题截获中间件 — 在中间件链中截获 ask_user_question 的答案
 *
 * 必须放在 concurrencyGuard 之前：答案消息需绕过并发守卫的 merge 缓冲，
 * 否则会被排队而无法到达 tryAnswer，导致「turn 等答案 ↔ 答案被缓冲」死锁。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../session/index.ts';

export function questionAnswer(manager: SessionManager) {
  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    const questionChannel = manager.questionChannel;
    if (!questionChannel) {
      await next();
      return;
    }
    // 链路前面已由 accessPolicy 拦掉非私聊消息，这里 scope 恒为 c2c
    const replyTarget = { scope: 'c2c' as const, targetId: ctx.replyTarget.targetId };
    if (questionChannel.tryAnswer('c2c', replyTarget.targetId, ctx.message.content.trim(), replyTarget)) {
      // 答案消息被截获（不再走到 bot.on('message')）；回复凭证已由链路上的
      // replyRecorder 登记过，这里不再单独补录。
      ctx.stop('question-answer');
      return;
    }
    await next();
  };
}
