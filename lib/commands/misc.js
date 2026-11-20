import { getScopePeer } from "../shared/index.js";
import { shortSessionId } from "../shared/utils.js";
import { sessionTitleOf, sourceTitle } from "../transport/session-source.js";
import { parseRest } from "./args.js";
import { matchSessionTarget } from "./sessions.js";
/**
 * 中止成功的回执：`⛔ 已中止「标题」 · #短id`，取不到标题时只给 id。
 *
 * 命令的字符串回复按纯文本发出、不渲染 markdown，所以这里不包反引号（正文版
 * 才包）；标题经 `sourceTitle` 压成一行并截断，避免撑破反馈行数。
 */
function cancelledReceipt(record) {
    const id = `#${shortSessionId(record.sessionId)}`;
    const title = sessionTitleOf(record);
    return title === undefined ? `⛔ 已中止 ${id}` : `⛔ 已中止「${sourceTitle(title)}」 · ${id}`;
}
/** /stop — 中止当前生成；`/stop <id>` 中止指定会话；`/stop all` 中止全体（隐藏） */
export function stopCommand({ manager }) {
    return {
        name: 'stop',
        scope: 'all',
        description: '中止生成',
        hidden: true,
        usage: [
            '### 📖 /stop 用法',
            '',
            '`/stop` 中止当前生成',
            '`/stop <id>` 中止指定会话',
            '`/stop all` 中止全部生成',
            '',
            '目标用 8 位短 id（行首 `#` 后那串）',
        ].join('\n'),
        handler: (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const arg = parseRest(cmdCtx.command?.raw ?? '');
            if (arg === '') {
                const record = manager.getSessionRecord(scope, peerId);
                // 会话存在不等于正在生成：只有 agent 处于 running 才算有进行中的回复
                if (record === undefined || record.agent.status !== 'running') {
                    return '⚠️ 当前没有进行中的生成';
                }
                // cancel 会让当前轮以 turn/end (kind=interrupted) 收尾，
                // 出站侧据此收尾本轮并投递已生成内容。
                record.agent.cancel({ kind: 'user' });
                return '⛔ 已中止';
            }
            if (arg.toLowerCase() === 'all') {
                const cancelled = manager.cancelAllRunning();
                return cancelled.length === 0
                    ? '⚠️ 当前没有进行中的生成'
                    : `⛔ 已中止 ${cancelled.length} 个会话`;
            }
            // 目标可以是任何一个已获取会话，不限于当前指针；匹配规则与 /sessions 同一份
            const candidates = manager.listAcquiredSessions().map((record) => ({
                id: record.sessionId,
                record,
            }));
            const target = matchSessionTarget(candidates, arg);
            if (!target.ok) {
                return `⚠️ ${target.error} · 用 /sessions 查看会话`;
            }
            const { record } = target.entry;
            if (record.agent.status !== 'running') {
                return `⚠️ 没有进行中的生成 · #${shortSessionId(record.sessionId)}`;
            }
            record.agent.cancel({ kind: 'user' });
            return cancelledReceipt(record);
        },
    };
}
//# sourceMappingURL=misc.js.map