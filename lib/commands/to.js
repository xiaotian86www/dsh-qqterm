import { ArgError, parseArgs } from "./args.js";
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
    '`/to <会话> <文本>` 向会话发消息；正文有空格就用引号包起来',
    '`/to <会话> -- <文本>` 正文写在 `--` 之后：整段原样，空格与换行都不必再包引号',
    '正文只能一段：没包引号又有多段、或以 `-` 开头的词，按参数错误回绝',
    '目标在等答案时，文本作为回答；没打开的会话会先接回来',
    '回复一条消息再发：被引用的内容会一起带上（目标在等答案时不带）',
    '没有正文时写 `/to <会话> --`：只带引用，或进入「下一条消息作为回答」模式',
].join('\n');
/** 正文被切成多段时回绝：要么包引号，要么写在 `--` 之后 */
const BODY_FORMAT = '⚠️ 正文只能一段：有空格就用引号包起来，或写到 -- 之后 · 用法: /help to';
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
/** /to 的参数：目标 + 一段正文，或 `--` 之后的整段正文 */
const TO_SPEC = { command: 'to', terminator: 'rest' };
/** 目标缺失 */
const MISSING_TARGET = '⚠️ 缺少会话 · 用法: /help to';
/**
 * 取会话与正文：一段参数，或 `--` 之后的整段。
 *
 * `/to #id`（或 `/to #id --`）是空正文，留给「只带引用」与「下一条消息作为回答」；
 * `/to #id 你好` 与 `/to #id "你好 世界"` 是同一段参数；`--` 之后整段原样（空格、
 * 换行、引号都不动）。没包引号又有多段、或正文以 `-` 开头，都按参数错误回绝。
 * 目标、正文与 `--` 一律交给同一份 parseArgs，不在命令里另写切词规则。
 */
function parseToArgs(raw) {
    let parsed;
    try {
        parsed = parseArgs(raw, TO_SPEC);
    }
    catch (error) {
        if (error instanceof ArgError)
            return { ok: false, error: error.message };
        throw error;
    }
    const [target, ...extra] = parsed.words;
    if (target === undefined)
        return { ok: false, error: MISSING_TARGET };
    if (parsed.rest !== undefined) {
        if (extra.length > 0)
            return { ok: false, error: BODY_FORMAT };
        return { ok: true, target, text: parsed.rest };
    }
    if (extra.length > 1)
        return { ok: false, error: BODY_FORMAT };
    return { ok: true, target, text: extra[0] ?? '' };
}
export function toCommand({ manager, config, logger }) {
    return {
        name: 'to',
        scope: 'c2c',
        description: '向会话发消息',
        acceptsQuote: true,
        usage: USAGE,
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            // 目标是一个位置参数，正文是一段参数或 `--` 之后的整段：回复链接已经带好
            // `--`，点开补正文即可
            const parsed = parseToArgs(cmdCtx.command?.raw ?? '');
            if (!parsed.ok)
                return parsed.error;
            const targetArg = parsed.target;
            const text = parsed.text;
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