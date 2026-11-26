import { getScopePeer } from "../shared/index.js";
import { queuedPromptReceipt, sessionTitleOf, steeredPromptReceipt, } from "../transport/session-source.js";
import { sendMarkdownChunked } from "../shared/send-helper.js";
export function retryCommand({ manager, config }) {
    return {
        name: 'retry',
        scope: 'all',
        description: '重发上一条消息',
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const outcome = manager.retryLastPrompt(scope, peerId);
            if (outcome.ok) {
                if (outcome.placement === 'started')
                    return '✅ 已重发上一条消息';
                const record = manager.findBySessionId(outcome.sessionId);
                const title = record === undefined ? undefined : sessionTitleOf(record);
                const current = manager.isCurrentSession(outcome.sessionId);
                const text = outcome.placement === 'queued'
                    ? queuedPromptReceipt(outcome.sessionId, title, outcome.messageId, current, manager.canMutateQueue())
                    : steeredPromptReceipt(outcome.sessionId, title, current);
                await sendMarkdownChunked(cmdCtx, text, config.textChunkLimit);
                return { kind: 'noop' };
            }
            if (outcome.reason === 'no-session')
                return '⚠️ 当前没有会话';
            if (outcome.reason === 'no-prompt') {
                return '⚠️ 没有可重发的消息';
            }
            return `❌ 重发失败: ${outcome.message ?? '未知原因'}`;
        },
    };
}
//# sourceMappingURL=retry.js.map