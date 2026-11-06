import { getScopePeer } from "../shared/index.js";
export function retryCommand({ manager }) {
    return {
        name: 'retry',
        category: 'agent',
        scope: 'all',
        description: '重发上一条消息',
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const outcome = manager.retryLastPrompt(scope, peerId);
            if (outcome.ok)
                return '✅ 已重发上一条消息';
            if (outcome.reason === 'no-session')
                return '⚠️ 当前无活跃会话';
            if (outcome.reason === 'no-prompt') {
                return '⚠️ 没有可重发的消息\n先发一条消息，或等这一轮失败后再试。';
            }
            return `❌ 重发失败: ${outcome.message ?? '未知原因'}`;
        },
    };
}
//# sourceMappingURL=retry.js.map