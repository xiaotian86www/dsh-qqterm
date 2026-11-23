import { parseRest } from "./args.js";
import { getScopePeer, shortSessionId } from "../shared/index.js";
import { queuedPromptReceipt, sessionTargetLabel, sessionTitleOf, steeredPromptReceipt, } from "../transport/session-source.js";
import { sendMarkdownChunked } from "../shared/send-helper.js";
import { resolveSessionTarget } from "./sessions.js";
import { buildPromptBody } from "../transport/prompt-body.js";
import { takeQuote } from "./quote.js";
import { errorMessage } from "../shared/utils.js";
const USAGE = [
    '### 📖 /to 用法',
    '',
    '`/to <会话> <文本>` 向会话发消息',
    '目标在等答案时，文本作为回答；没打开的会话会先接回来',
    '回复一条消息再发：被引用的内容会一起带上（目标在等答案时不带）',
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
export function toCommand({ manager, config, logger }) {
    return {
        name: 'to',
        scope: 'c2c',
        description: '向会话发消息',
        acceptsQuote: true,
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
            // 带引用的命令：引用取不到就什么都不发
            const taken = await takeQuote(cmdCtx, config.media, logger);
            if (typeof taken === 'string')
                return taken;
            const quote = taken;
            let target;
            try {
                const groups = await manager.listWorkspaceGroups(scope, peerId);
                const resolved = resolveSessionTarget(flattenGroups(groups), targetArg);
                if (resolved.ok)
                    target = resolved.entry;
            }
            catch (err) {
                logger?.warn(`/to 列举会话失败: ${errorMessage(err)}`);
            }
            // 列表里没有（例如 live 但没有 cwd）时，允许直接用完整 id
            let sessionId;
            let title;
            if (target) {
                // 列表不再预读标题，命中后只补这一条
                await manager.fillSessionTitles([target]);
                sessionId = target.id;
                title = target.title;
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
            // 目标在等回答时，这条文本是答案不是新 prompt：引用不跟着走
            const awaiting = manager.isAwaitingAnswer(sessionId);
            const withQuote = awaiting ? undefined : quote;
            const body = withQuote === undefined
                ? text
                : buildPromptBody({ quote: withQuote.quote, quoteFiles: withQuote.files, text });
            const outcome = await manager.sendTo(scope, peerId, cmdCtx.message.senderId ?? peerId, sessionId, body, { scope, targetId: peerId });
            /** 带引用的回执尾行：发送成功时才贴，失败文案只讲失败 */
            const quoteNotes = [
                ...(withQuote === undefined ? [] : ['📎 已带上引用']),
                ...(awaiting && quote !== undefined ? ['💡 目标在等回答，引用这次没有一起发送'] : []),
            ];
            if (outcome.ok) {
                let receipt;
                switch (outcome.kind) {
                    case 'answered':
                        receipt = `✅ 已回答${label}`;
                        break;
                    case 'answer-mode':
                        receipt = `💡 请发送回答: ${label}`;
                        break;
                    case 'queued':
                    case 'steered': {
                        // 排队 / 插话回执带可点的插话入口，命令的纯文本回复不渲染，走 markdown
                        const current = manager.isCurrentSession(sessionId);
                        const body = outcome.kind === 'queued'
                            ? queuedPromptReceipt(sessionId, title, outcome.messageId, current, manager.canSteer())
                            : steeredPromptReceipt(sessionId, title, current);
                        const full = quoteNotes.length === 0 ? body : `${body}\n${quoteNotes.join('\n')}`;
                        await sendMarkdownChunked(cmdCtx, full, config.textChunkLimit);
                        return { kind: 'noop' };
                    }
                    default:
                        receipt = `✅ 已发送到${label}`;
                        break;
                }
                return quoteNotes.length === 0 ? receipt : `${receipt}\n${quoteNotes.join('\n')}`;
            }
            switch (outcome.reason) {
                case 'not-found':
                    return `⚠️ 没有这个会话: ${label}`;
                case 'locked':
                    return `⚠️ 这个会话正在别处使用: ${label}\n等它释放后再发一次。`;
                case 'archived':
                    return `⚠️ 该会话已归档: ${label}\n先 /sessions unarchive ${displayId(sessionId)}。`;
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