export function replyRecorder(store) {
    return async (ctx, next) => {
        // 链路前面已由 accessPolicy 拦掉非私聊消息，这里 scope 恒为 c2c。
        // 时间用消息自带的 timestamp：RESUME 补发的旧消息窗口已经过了，不能被当成新凭证。
        const at = Date.parse(ctx.message.timestamp);
        store.recordMessage('c2c', ctx.replyTarget.targetId, ctx.replyTarget.msgId, Number.isFinite(at) ? at : undefined);
        await next();
    };
}
//# sourceMappingURL=reply-recorder.js.map