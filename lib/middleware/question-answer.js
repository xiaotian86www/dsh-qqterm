export function questionAnswer(manager) {
    return async (ctx, next) => {
        const questionChannel = manager.questionChannel;
        if (!questionChannel) {
            await next();
            return;
        }
        // 链路前面已由 accessPolicy 拦掉非私聊消息，这里 scope 恒为 c2c
        const replyTarget = { scope: 'c2c', targetId: ctx.replyTarget.targetId };
        if (questionChannel.tryAnswer('c2c', replyTarget.targetId, ctx.message.content.trim(), replyTarget)) {
            // 答案消息被截获（不再走到 bot.on('message')）；回复凭证已由链路上的
            // replyRecorder 登记过，这里不再单独补录。
            ctx.stop('question-answer');
            return;
        }
        await next();
    };
}
//# sourceMappingURL=question-answer.js.map