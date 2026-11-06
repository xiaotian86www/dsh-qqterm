import { commandAllowlistAuth } from "./auth.js";
import { getScopePeer, sendMarkdownChunked } from "../shared/index.js";
import { effortLabel } from "../model/effort-label.js";
/** 一行可选的「下一步」：当前模型不支持思考强度时给出口 */
const UNSUPPORTED_HINT = '换一个模型试试: `/model`';
export function reasoningCommand({ manager, config, logger }) {
    return {
        name: ['reasoning', 'think'],
        category: 'agent',
        scope: 'all',
        // 管理类指令：与 /model 同一权限面
        authorized: commandAllowlistAuth(config, logger),
        description: '查看或切换当前会话的思考强度（用法: /reasoning [档位]）',
        panelDesc: '切换思考强度',
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const args = (cmdCtx.command?.raw ?? '').trim().toLowerCase();
            const view = await manager.getEffortView(scope, peerId);
            // 无参数：一行现状 + 可点击的档位
            if (!args) {
                if (!view.options || view.options.length === 0) {
                    return `⚠️ 当前模型不支持思考强度\n${UNSUPPORTED_HINT}`;
                }
                const current = view.current;
                const currentLine = current ? `当前: ${effortLabel(current)}` : '当前: —';
                const lines = ['### 🧠 思考强度', '', currentLine, ''];
                for (const option of view.options) {
                    const isCurrent = current?.id === option.id;
                    lines.push(`<qqbot-cmd-input text="/reasoning ${option.id}" show="/reasoning ${optionLabel(option)}${isCurrent ? ' ✅' : ''}"/>`);
                }
                await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
                return { kind: 'noop' };
            }
            // 切换
            const outcome = await manager.selectEffort(scope, peerId, args);
            if (!outcome.ok) {
                if (outcome.reason === 'unsupported') {
                    return `⚠️ 当前模型不支持思考强度\n${UNSUPPORTED_HINT}`;
                }
                if (outcome.reason === 'unknown-effort') {
                    const options = (outcome.options ?? []).map(optionLabel).join(' · ');
                    return [
                        `⚠️ 不支持的档位: \`${args}\``,
                        options ? `可选: ${options}` : UNSUPPORTED_HINT,
                    ].join('\n');
                }
                if (outcome.reason === 'no') {
                    return '⚠️ 没有会话';
                }
                return `❌ 思考强度切换失败${outcome.message ? `: ${outcome.message}` : ''}`;
            }
            const label = view.options?.find((option) => option.id === outcome.effort);
            const display = label ? effortLabel(label) : outcome.effort;
            if (outcome.unchanged)
                return `✅ 已是当前思考强度: ${display}`;
            return `✅ 思考强度已切换: ${display}`;
        },
    };
}
/** 档位在按钮/文案里的展示名（未知 id 用 id 兜底） */
function optionLabel(option) {
    const label = effortLabel(option);
    return label === option.id ? option.id : label;
}
//# sourceMappingURL=reasoning.js.map