import { parseRest } from "./args.js";
import { ownerOnlyAuth } from "./auth.js";
import { getScopePeer, sendMarkdownChunked } from "../shared/index.js";
import { commandLinkRaw } from "../shared/inline.js";
export function presetCommand({ manager, config, logger }) {
    return {
        name: 'preset',
        // 管理类指令：私聊可用，但仅限绑定用户（复用审批的 owner 语义）
        scope: 'all',
        authorized: ownerOnlyAuth(config, logger),
        description: '查看或切换 preset',
        usage: [
            '### 📖 /preset 用法',
            '',
            '`/preset` 查看可用 preset',
            '`/preset <id>` 切换 preset',
        ].join('\n'),
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const args = parseRest(cmdCtx.command?.raw ?? '');
            // 无参数：列出可用 preset + 默认项
            if (!args) {
                const presets = await manager.listPresets();
                if (presets.length === 0) {
                    return '⚠️ 当前部署无可用的 agent preset';
                }
                // 沿用「当前」的写法，不另造「全局」标签
                const currentId = manager.getEffectivePreset(scope, peerId);
                const defaultId = presets.find((p) => p.isDefault)?.id ?? currentId;
                const lines = ['### 🧩 Agent Preset', ''];
                lines.push(`**当前**: ${defaultId ?? '—'}`);
                // 列表本身就是全部可选 preset，不再加「可用 preset」这类小标题
                lines.push('');
                for (const p of presets) {
                    const display = p.name ? `${p.name} (${p.id})` : p.id;
                    // 默认项带 ✅；链接统一指向真实切换命令，重复切换由命令自身幂等处理
                    const suffix = p.id === defaultId ? ' ✅' : '';
                    lines.push(commandLinkRaw(`/preset ${p.id}`, `/preset ${display}${suffix}`));
                }
                await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
                return { kind: 'noop' };
            }
            // 把指定 preset 设为默认
            const outcome = await manager.setPresetOverride(scope, peerId, args);
            if (!outcome.ok) {
                switch (outcome.reason) {
                    case 'unknown-preset':
                        return `⚠️ 未知 preset: ${args}`;
                    case 'broken':
                        return `❌ preset ${args} 加载失败: ${outcome.message ?? '未知错误'}`;
                    case 'unavailable':
                        return '⚠️ 当前部署无可用的 agent preset';
                    default:
                        return `❌ preset 切换失败: ${outcome.message ?? '未知错误'}`;
                }
            }
            const target = outcome.presetId ?? args;
            if (outcome.unchanged)
                return `✅ 已是当前 preset: ${target}`;
            return `✅ preset 已切换: ${target}`;
        },
    };
}
//# sourceMappingURL=preset.js.map