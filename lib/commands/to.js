import { parseRest } from "./args.js";
import { getScopePeer, shortSessionId } from "../shared/index.js";
import { sessionTargetLabel, sessionTitleOf } from "../transport/session-source.js";
import { resolveSessionTarget } from "./sessions.js";
const USAGE = [
    '### 📖 /to 用法',
    '',
    '`/to <会话> <文本>` 向会话发消息',
    '目标在等答案时，文本作为回答；没打开的会话会先接回来',
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
        scope: 'c2c',
        description: '向会话发消息',
        usage: USAGE,
        handler: async (cmdCtx) => {
            const raw = (cmdCtx.command?.raw ?? '').trim();
            const { scope, peerId } = getScopePeer(cmdCtx);
            // 第一个 token 是会话，其余整体是文本（允许空格、换行）
            const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw);
            const targetArg = match?.[1] ?? '';
            const text = parseRest(match?.[2] ?? '');
            if (targetArg === '') {
                return '⚠️ 缺少会话 · 用法: /help to';
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
            let title;
            if (target) {
                // 列表不再预读标题，命中后只补这一条
                await manager.fillSessionTitles([target]);
                sessionId = target.id;
                title = target.title;
                if (target.archived) {
                    return `⚠️ 该会话已归档: ${sessionTargetLabel(sessionId, title)}\n先 /sessions unarchive ${displayId(sessionId)}。`;
                }
            }
            else {
                const candidate = targetArg.replace(/^#/, '');
                if (candidate.length < 4 || !manager.hasLiveSession(candidate)) {
                    return `⚠️ 没有匹配的会话: ${targetArg}\n用 /sessions 里的 8 位短 id。`;
                }
                sessionId = candidate;
            }
            // 名字：列表里有就用列表的标题，否则从已获取会话的日志里捞一次
            if (title === undefined) {
                const record = manager.findBySessionId(sessionId);
                title = record === undefined ? undefined : sessionTitleOf(record);
            }
            const label = sessionTargetLabel(sessionId, title);
            const outcome = await manager.sendTo(scope, peerId, cmdCtx.message.senderId ?? peerId, sessionId, text, { scope, targetId: peerId });
            if (outcome.ok) {
                switch (outcome.kind) {
                    case 'answered':
                        return `✅ 已回答${label}`;
                    case 'answer-mode':
                        return `💡 请发送回答: ${label}`;
                    default:
                        return `✅ 已发送到${label}`;
                }
            }
            switch (outcome.reason) {
                case 'not-found':
                    return `⚠️ 没有这个会话: ${label}`;
                case 'locked':
                    return `⚠️ 这个会话正在别处使用: ${label}\n等它释放后再发一次。`;
                case 'forbidden':
                    return `⚠️ 这个会话属于另一个用户: ${label}`;
                case 'empty':
                    return `⚠️ 缺少文本: ${label}\n/to ${displayId(sessionId)} <文本>`;
                default:
                    return `❌ 发送失败: ${label}\n${outcome.message ?? '未知错误'}`;
            }
        },
    };
}
//# sourceMappingURL=to.js.map