/**
 * 从命令上下文提取 scope + peerId
 *
 * 插件只处理后 C2C 私聊消息，peerId 恒为发送者 user openid。
 */
export function getScopePeer(cmdCtx) {
    return { scope: 'c2c', peerId: cmdCtx.message.senderId };
}
//# sourceMappingURL=scope.js.map