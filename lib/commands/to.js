import { getScopePeer, shortSessionId } from "../shared/index.js";
import { resolveSessionTarget } from "./sessions.js";
const USAGE = [
    '/to <会话> <文本> 发消息；目标在等答案时作为回答',
    '会话用 8 位短 id；目标要先用 /sessions resume 或 /to 获取',
].join('\n');
/** 把分组列表摊平成可解析的会话清单 */
function flattenGroups(groups) {
    const seen = new Set();
    const out = [];
    for (const group of groups) {
        for (const session of group.sessions) {
            if (seen.has(session.id))
                continue;
            seen.add(session.id);
            out.push(session);
        }
    }
    return out;
}
/** 展示用 id：`#` + 8 位短 id */
function displayId(id) {
    return `#${shortSessionId(id)}`;
}
export function toCommand({ manager, logger }) {
    return {
        name: 'to',
        category: 'agent',
        scope: 'c2c',
        description: '向指定会话发消息，或回答它的提问',
        usage: USAGE,
        handler: async (cmdCtx) => {
            const raw = (cmdCtx.command?.raw ?? '').trim();
            const { scope, peerId } = getScopePeer(cmdCtx);
            // 第一个 token 是会话，其余整体是文本（允许空格、换行）
            const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw);
            const targetArg = match?.[1] ?? '';
            const text = (match?.[2] ?? '').trim();
            if (targetArg === '') {
                return `⚠️ 缺少会话\n${USAGE}`;
            }
            let target;
            try {
                const groups = await manager.listWorkspaceGroups(scope, peerId);
                const resolved = resolveSessionTarget(flattenGroups(groups), targetArg);
                if (resolved.ok)
                    target = resolved.entry;
            }
            catch (err) {
                logger?.warn(`/to 列举会话失败: ${err instanceof Error ? err.message : String(err)}`);
            }
            // 列表里没有（例如 live 但没有 cwd）时，允许直接用完整 id
            let sessionId;
            if (target) {
                if (target.archived) {
                    return `⚠️ 该会话已归档: ${displayId(target.id)}\n先 /sessions unarchive ${displayId(target.id)}。`;
                }
                sessionId = target.id;
            }
            else {
                const candidate = targetArg.replace(/^#/, '');
                if (candidate.length < 4 || !manager.hasLiveSession(candidate)) {
                    return `⚠️ 没有匹配的会话: ${targetArg}\n用 /sessions 里的 8 位短 id。`;
                }
                sessionId = candidate;
            }
            const outcome = await manager.sendTo(scope, peerId, cmdCtx.message.senderId ?? peerId, sessionId, text, { scope, targetId: peerId, msgId: cmdCtx.message.messageId });
            if (outcome.ok) {
                switch (outcome.kind) {
                    case 'answered':
                        return `✅ 已回答 ${displayId(sessionId)}`;
                    case 'answer-mode':
                        return `💡 请发送回答（${displayId(sessionId)}）`;
                    default:
                        return `✅ 已发送到 ${displayId(sessionId)}`;
                }
            }
            switch (outcome.reason) {
                case 'not-running':
                    return `⚠️ 会话未运行: ${displayId(sessionId)}\n先 /sessions resume ${displayId(sessionId)}，或在 Web 打开它。`;
                case 'forbidden':
                    return `⚠️ 这个会话属于另一个用户: ${displayId(sessionId)}`;
                case 'empty':
                    return `⚠️ 缺少文本 · /to ${displayId(sessionId)} <文本>`;
                default:
                    return `❌ 发送失败: ${outcome.message ?? '未知错误'}`;
            }
        },
    };
}
//# sourceMappingURL=to.js.map