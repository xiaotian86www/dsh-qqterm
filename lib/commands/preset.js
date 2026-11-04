import { commandAllowlistAuth } from "./auth.js";
import { getScopePeer, sendMarkdownChunked } from "../shared/index.js";
export function presetCommand({ manager, config, logger }) {
    return {
        name: 'preset',
        category: 'agent',
        // 管理类指令：私聊可用，但仅限白名单用户（复用审批的名单语义）
        scope: 'all',
        authorized: commandAllowlistAuth(config, logger),
        description: '查看或切换 agent preset（用法: /preset [id]）',
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const args = (cmdCtx.command?.raw ?? '').trim();
            // 无参数：列出可用 preset + 当前
            if (!args) {
                const presets = await manager.listPresets();
                if (presets.length === 0) {
                    return '⚠️ 当前部署无可用的 agent preset';
                }
                const effective = manager.getEffectivePreset(scope, peerId);
                const locked = manager.getSessionRecord(scope, peerId)?.agentPreset;
                // /preset 决定的是「新会话」的 preset：当前值取 effective，
                // 已开始会话锁定的旧值只在下面单独说明。
                const currentId = effective ?? locked;
                const lines = ['### 🧩 Agent Preset', ''];
                lines.push(`**当前**: ${currentId ?? '默认'}`);
                if (locked && currentId && locked !== currentId) {
                    lines.push(`当前会话仍使用 ${locked}，发送 /new 后切到 ${currentId}`);
                }
                lines.push('', '**可用 preset（点击切换）:**');
                for (const p of presets) {
                    const display = p.name ? `${p.name} (${p.id})` : p.id;
                    // 当前值带 ✅；链接统一指向真实切换命令，重复切换由命令自身幂等处理
                    const isCurrent = p.id === currentId;
                    const suffix = isCurrent ? ' ✅' : '';
                    lines.push(`<qqbot-cmd-input text="/preset ${p.id}" show="/preset ${display}${suffix}"/>`);
                }
                lines.push('', '手动指定: `/preset <id>`，重置默认: `/preset reset`');
                await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
                return { kind: 'noop' };
            }
            // reset / default：清除 per-peer 覆盖，回到默认
            if (args === 'reset' || args === 'default') {
                const outcome = await manager.clearPresetOverride(scope, peerId);
                return outcome.ok ? '✅ 已重置为默认 preset（新会话生效）' : '❌ 重置失败';
            }
            // 切换到指定 preset
            const outcome = await manager.setPresetOverride(scope, peerId, args);
            if (!outcome.ok) {
                switch (outcome.reason) {
                    case 'unavailable':
                        return '⚠️ 当前部署不支持 agent preset（agentPresets 服务未注入）';
                    case 'unknown-preset':
                        return `⚠️ 未知 preset: ${args}`;
                    case 'broken':
                        return `❌ preset ${args} 加载失败: ${outcome.message ?? '未知错误'}`;
                    default:
                        return `❌ 切换失败: ${outcome.message ?? '未知错误'}`;
                }
            }
            if (outcome.unchanged) {
                const target = outcome.presetId ?? args;
                const locked = manager.getSessionRecord(scope, peerId)?.agentPreset;
                const lines = [`✅ 已是当前 preset: ${target}`];
                if (locked && locked !== target) {
                    lines.push(`当前会话仍使用 ${locked}，发送 /new 后切到 ${target}`);
                }
                return lines.join('\n');
            }
            return `✅ preset 已切换: ${args}（新会话生效）`;
        },
    };
}
//# sourceMappingURL=preset.js.map