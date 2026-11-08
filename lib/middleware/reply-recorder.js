export function replyRecorder(store) {
    return async (ctx, next) => {
        // 链路前面已由 accessPolicy 拦掉非私聊消息，这里 scope 恒为 c2c
        store.recordMessage('c2c', ctx.replyTarget.targetId, ctx.replyTarget.msgId);
        await next();
    };
}
//# sourceMappingURL=reply-recorder.js.map