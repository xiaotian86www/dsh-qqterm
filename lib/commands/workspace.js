import { getScopePeer, sendMarkdownChunked } from "../shared/index.js";
import { sessionAdminAuth, shortId } from "./sessions.js";
const USAGE = [
    '**工作区**',
    '`/workspace` 看当前工作区',
    '`/workspace <名字|路径>` 换（只能在 `/new` 之后改）',
].join('\n');
/** 已有会话时的下一步：这是唯一能换工作区的路径 */
const NEW_HINT = '换工作区: `/new <名字|路径>`';
/** /workspace — 查看 / 切换当前聊天的工作区 */
export function workspaceCommand({ manager, config, logger }) {
    return {
        name: 'workspace',
        category: 'agent',
        // 换工作区 = 换 agent 能读写的目录：与 /sessions 同一权限面
        scope: 'c2c',
        authorized: sessionAdminAuth(config, logger),
        description: '查看或切换工作区（/new 后可改）',
        usage: USAGE,
        handler: async (cmdCtx) => {
            const arg = (cmdCtx.command?.raw ?? '').trim();
            const { scope, peerId } = getScopePeer(cmdCtx);
            let text;
            try {
                text = arg === ''
                    ? await renderCurrent(manager, scope, peerId)
                    : renderChange(await manager.changeChatWorkspace(scope, peerId, arg));
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logger?.warn(`/workspace 失败: ${message}`);
                text = `⚠️ 工作区操作失败: ${message}`;
            }
            // 统一走 markdown 通道：否则 `###` 与 `**` 会成为字面文本
            await sendMarkdownChunked(cmdCtx, text, config.textChunkLimit);
            return { kind: 'noop' };
        },
    };
}
/** 当前工作区视图：在哪、还能不能改 */
async function renderCurrent(manager, scope, peerId) {
    const info = await manager.currentWorkspaceInfo(scope, peerId).catch(() => undefined);
    if (!info)
        return '⚠️ 读不到当前工作区。';
    const state = await manager.canChooseWorkspace(scope, peerId)
        .catch(() => ({ canChoose: false, sessionId: undefined }));
    const lines = ['### 🗂 工作区', '', `**${info.title}** · \`${info.path}\``];
    if (info.missing)
        lines.push('', '⚠️ 目录已不存在，用 `/workspace <名字|路径>` 换一个');
    lines.push('');
    if (state.canChoose) {
        lines.push('下一条消息会在这里开新会话 · 换工作区 `/workspace <名字|路径>`');
    }
    else {
        const id = state.sessionId ? `（\`#${shortId(state.sessionId)}\`）` : '';
        lines.push(`这个聊天已经有会话${id}，工作区在建会话时写进会话，改不了。`);
        lines.push(NEW_HINT);
    }
    return lines.join('\n');
}
/** 切换结果渲染 */
function renderChange(outcome) {
    if (outcome.ok) {
        return [
            `✅ 工作区已切到 **${outcome.title}** · \`${outcome.path}\``,
            '',
            outcome.isNew
                ? '这个工作区还是新的，下一条消息会在这里建第一个会话。'
                : '下一条消息会在这里开新会话。',
        ].join('\n');
    }
    return describeChangeFailure(outcome);
}
/**
 * 失败文案（`/workspace` 与 `/new <工作区>` 共用，措辞保持一致）。
 *
 * `has-session` 只会出现在 `/workspace` 里：`/new` 先 `/new` 再改目录，那时会话
 * 已经不在盘上了。
 */
export function describeChangeFailure(outcome) {
    if (outcome.ok)
        return '';
    switch (outcome.reason) {
        case 'has-session': {
            const id = outcome.sessionId ? `（\`#${shortId(outcome.sessionId)}\`）` : '';
            return [`⚠️ 这个聊天已经有会话${id}，工作区在建会话时写进会话，改不了。`, NEW_HINT].join('\n');
        }
        case 'missing':
            return `⚠️ 目录不存在: \`${outcome.path}\`\n换一个存在的目录，或直接给绝对路径。`;
        case 'ambiguous':
            return [
                `⚠️ 有 ${outcome.matches.length} 个工作区匹配: ${outcome.matches.join('、')}`,
                '用绝对路径: `/workspace D:\\项目\\目录`',
            ].join('\n');
        case 'not-found':
            return `⚠️ 没有叫 \`${outcome.arg}\` 的工作区。\`/sessions all\` 看全部工作区`;
        default:
            return '⚠️ 工作区切换失败。';
    }
}
//# sourceMappingURL=workspace.js.map