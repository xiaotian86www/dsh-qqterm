import { parseRest } from "./args.js";
import { ownerOnlyAuth } from "./auth.js";
import { getScopePeer, sendMarkdownChunked } from "../shared/index.js";
import { commandLinkRaw } from "../shared/inline.js";
import { effortLabel } from "../model/effort-label.js";
/** 不支持思考强度时的原因（只报原因，不给下一步） */
const UNSUPPORTED_REASON = '⚠️ 当前模型不支持思考强度';
/** 恢复模型默认的参数：不是 adapter 档位，等价于「不指定 effort」 */
const MODEL_DEFAULT = 'default';
export function reasoningCommand({ manager, config, logger }) {
    return {
        name: ['reasoning', 'think'],
        scope: 'all',
        // 管理类指令：与 /model 同一权限面
        authorized: ownerOnlyAuth(config, logger),
        description: '查看或切换思考强度',
        usage: [
            '### 📖 /reasoning 用法',
            '',
            '`/reasoning` 查看当前思考强度',
            '`/reasoning <档位>` 切换思考强度',
            '`/reasoning default` 恢复模型默认档位',
        ].join('\n'),
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const args = parseRest(cmdCtx.command?.raw ?? '').toLowerCase();
            const view = await manager.getEffortView(scope, peerId);
            // 无参数：一行现状 + 可点击的档位
            if (!args) {
                if (!view.options || view.options.length === 0) {
                    return UNSUPPORTED_REASON;
                }
                // 有会话看会话自己的值；没有会话时这里是核心默认档位（新建会话会用它）
                const current = view.current;
                const lines = ['### 🧠 思考强度'];
                if (current)
                    lines.push('', `当前: ${optionLabel(current)}`);
                lines.push('');
                // 「默认」不是 adapter 档位，而是「不指定 effort、交给模型默认」——与 Web 的 Default 同义
                lines.push(commandLinkRaw(`/reasoning ${MODEL_DEFAULT}`, `/reasoning 默认（跟随模型）${view.defaulted ? ' ✅' : ''}`));
                for (const option of view.options) {
                    // 跟随模型时当前值虽解析成某一档，选中的仍是「默认」，不再给该档打 ✅
                    const isCurrent = !view.defaulted && current?.id === option.id;
                    lines.push(commandLinkRaw(`/reasoning ${option.id}`, `/reasoning ${optionLabel(option)}${isCurrent ? ' ✅' : ''}`));
                }
                await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
                return { kind: 'noop' };
            }
            // 切换：`default` 不是 adapter 档位，而是交回「不指定 effort，用模型默认」
            const isDefault = args === MODEL_DEFAULT;
            const outcome = await manager.selectEffort(scope, peerId, isDefault ? undefined : args);
            if (!outcome.ok) {
                if (outcome.reason === 'unsupported') {
                    return UNSUPPORTED_REASON;
                }
                if (outcome.reason === 'unknown-effort') {
                    return `⚠️ 不支持的档位: \`${args}\``;
                }
                return `❌ 思考强度切换失败${outcome.message ? `: ${outcome.message}` : ''}`;
            }
            const label = view.options?.find((option) => option.id === outcome.effort);
            const display = label ? optionLabel(label) : outcome.effort ?? '模型默认';
            if (isDefault) {
                return outcome.unchanged
                    ? `✅ 已是默认思考强度: ${display}`
                    : `✅ 思考强度已恢复默认: ${display}`;
            }
            if (outcome.unchanged)
                return `✅ 已是当前思考强度: ${display}`;
            return `✅ 思考强度已切换: ${display}`;
        },
    };
}
/** 档位在按钮/文案里的展示名：`高 (high)`，未知 id 直接用 id */
function optionLabel(option) {
    const label = effortLabel(option);
    return label === option.id ? option.id : `${label} (${option.id})`;
}
//# sourceMappingURL=reasoning.js.map