import { getScopePeer } from "../shared/index.js";
import { describeChangeFailure } from "./workspace.js";
/**
 * /new（别名 /reset /clear）— 开始新会话
 *
 * 不带参数：在当前工作区开新会话（与旧行为一致）。
 * 带参数：在指定工作区开新会话，等价于 `/new` 再 `/workspace <工作区>`。
 *
 * 参数先解析再动会话：路径写错不该把当前会话弄丢。换工作区等于换 agent 能读写
 * 的目录，所以带参数时要求白名单（`access.c2cAllow`），不带参数的 `/new` 不受
 * 限制。
 */
export function newCommand({ manager, config }) {
    return {
        name: ['new', 'reset', 'clear'],
        category: 'agent',
        scope: 'all',
        description: '开始新会话（清空上下文，可指定工作区）',
        usage: [
            '/new',
            '/new <工作区|路径>',
            '',
            '不带参数：在当前工作区开新会话（上下文清空）。',
            '带参数：在指定工作区开新会话，等价于 `/new` 再 `/workspace <工作区>`。',
            '工作区认标题、目录名（大小写不敏感，支持唯一前缀）或绝对路径。',
        ].join('\n'),
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const arg = (cmdCtx.command?.raw ?? '').trim();
            // 不带参数 = 留在当前工作区；异步释放 agent，不阻塞回复
            if (arg === '') {
                void manager.remove(scope, peerId);
                return '✅ 已开启新会话';
            }
            // 带参数 = 换工作区（= 换 agent 能读写的目录）：与 /workspace 同一权限面
            const senderId = cmdCtx.message.senderId;
            const allowed = scope === 'c2c'
                && senderId !== undefined
                && config.access.c2cAllow.includes(senderId);
            if (!allowed) {
                return '⚠️ `/new <工作区>` 只在私聊 + 白名单（access.c2cAllow）可用；直接 `/new` 不受限制。';
            }
            // 先解析目标再动会话：路径写错不该把当前会话弄丢
            const resolved = manager.resolveWorkspace(arg);
            if (!resolved.ok)
                return describeChangeFailure(resolved);
            await manager.remove(scope, peerId);
            const changed = await manager.changeChatWorkspace(scope, peerId, arg);
            if (!changed.ok)
                return describeChangeFailure(changed);
            return `✅ 已开启新会话\n工作区: ${changed.title} · ${changed.path}`;
        },
    };
}
/** /compact — 原地压缩会话历史 */
export function compactCommand({ manager }) {
    return {
        name: 'compact',
        category: 'agent',
        scope: 'all',
        description: '压缩会话历史（摘要替换旧记录，保留上下文）',
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const msg = cmdCtx.message;
            const outcome = await manager.compact(scope, peerId, {
                senderId: msg.senderId,
                replyTarget: { scope, targetId: peerId, msgId: msg.messageId },
            });
            if (outcome.ok) {
                if (!outcome.shadowed)
                    return '没有可压缩的历史';
                return `✅ 已压缩 ${outcome.shadowed} 条历史记录（约 ${outcome.tokens ?? 0} tokens）`;
            }
            switch (outcome.reason) {
                case 'no-session':
                    return '当前无活跃会话';
                case 'busy':
                    return '正在生成中，无法压缩';
                case 'unavailable':
                    return '压缩能力不可用（当前会话的 agent preset 未加载 compaction 服务）';
                default:
                    return `压缩失败: ${outcome.message ?? '未知错误'}`;
            }
        },
    };
}
//# sourceMappingURL=session.js.map