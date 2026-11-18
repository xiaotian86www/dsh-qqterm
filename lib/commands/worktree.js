import { ownerOnlyAuth } from "./auth.js";
import { getScopePeer, sendMarkdownChunked } from "../shared/index.js";
/** 开关的展示名与可接受的输入（on / off 是给肌肉记忆留的别名） */
const ON_WORDS = new Set(['on', '开']);
const OFF_WORDS = new Set(['off', '关']);
export function worktreeCommand({ manager, config, logger }) {
    return {
        name: 'worktree',
        scope: 'all',
        authorized: ownerOnlyAuth(config, logger),
        description: '切换新会话的工作树',
        usage: [
            '### 📖 /worktree 用法',
            '',
            '`/worktree` 查看当前设置',
            '`/worktree 开` 之后新建的会话开在工作树里',
            '`/worktree 关` 之后新建的会话直接在主检出里跑',
        ].join('\n'),
        handler: async (cmdCtx) => {
            getScopePeer(cmdCtx);
            const raw = (cmdCtx.command?.raw ?? '').trim();
            const enabled = manager.worktreeEnabled();
            // 无参数：一行现状 + 两个可点的取值（与 /permission、/reasoning 同形）
            if (raw === '') {
                const lines = ['### 🌿 工作树', '', `当前: ${enabled ? '开' : '关'}`, ''];
                lines.push(`<qqbot-cmd-input text="/worktree 开" show="/worktree 开${enabled ? ' ✅' : ''}"/>`);
                lines.push(`<qqbot-cmd-input text="/worktree 关" show="/worktree 关${enabled ? '' : ' ✅'}"/>`);
                await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
                return { kind: 'noop' };
            }
            const args = raw.toLowerCase();
            const next = ON_WORDS.has(args) ? true : OFF_WORDS.has(args) ? false : undefined;
            if (next === undefined) {
                return `⚠️ 未知子命令: ${raw} · 用法: /help worktree`;
            }
            manager.setWorktreeEnabled(next);
            return next
                ? '✅ 之后新建的会话开在工作树里 · 已有会话不受影响'
                : '✅ 之后新建的会话直接在主检出里跑 · 已有会话不受影响';
        },
    };
}
//# sourceMappingURL=worktree.js.map