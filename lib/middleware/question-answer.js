import { cacheMsgId } from "../transport/msgid-cache.js";
export function questionAnswer(manager) {
    return async (ctx, next) => {
        const questionChannel = manager.questionChannel;
        if (!questionChannel) {
            await next();
            return;
        }
        // 链路前面已由 accessPolicy 拦掉非私聊消息，这里 scope 恒为 c2c
        const replyTarget = { scope: 'c2c', targetId: ctx.replyTarget.targetId, msgId: ctx.replyTarget.msgId };
        if (questionChannel.tryAnswer('c2c', replyTarget.targetId, ctx.message.content.trim(), replyTarget)) {
            // 答案消息被截获（不再走到 bot.on('message')），在此补录其 msgId，
            // 供被动回复超限时切换到缓存的最近 msgId。
            cacheMsgId('c2c', ctx.replyTarget.targetId, ctx.replyTarget.msgId);
            ctx.stop('question-answer');
            return;
        }
        await next();
    };
}
//# sourceMappingURL=question-answer.js.map