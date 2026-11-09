/**
 * 入站凭证记录中间件 — 每条经过访问控制的消息都登记 msgId。
 *
 * 必须放在命令分发之前：命令消息会被 slashCommand 截获，不会走到
 * bot.on('message')，只在事件处理器里记录会漏掉命令回复的被动凭证。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { ReplyStore } from '../transport/reply-store.ts';

export function replyRecorder(store: ReplyStore) {
  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    // 链路前面已由 accessPolicy 拦掉非私聊消息，这里 scope 恒为 c2c。
    // 时间用消息自带的 timestamp：RESUME 补发的旧消息窗口已经过了，不能被当成新凭证。
    const at = Date.parse(ctx.message.timestamp);
    store.recordMessage(
      'c2c',
      ctx.replyTarget.targetId,
      ctx.replyTarget.msgId,
      Number.isFinite(at) ? at : undefined,
    );
    await next();
  };
}
