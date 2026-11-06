import { commandAllowlistAuth } from "./auth.js";
import { getScopePeer, sendMarkdownChunked } from "../shared/index.js";
export function presetCommand({ manager, config, logger }) {
    return {
        name: 'preset',
        category: 'agent',
        // 管理类指令：私聊可用，但仅限白名单用户（复用审批的名单语义）
        scope: 'all',
        authorized: commandAllowlistAuth(config, logger),
        description: '查看或切换全局 agent preset（用法: /preset [id]）',
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const args = (cmdCtx.command?.raw ?? '').trim();
            // 无参数：列出可用 preset + 默认项
            if (!args) {
                const presets = await manager.listPresets();
                if (presets.length === 0) {
                    return '⚠️ 当前部署无可用的 agent preset';
                }
                // 全局值：之后新建的会话会用它；已开始的会话保持自己的 preset
                const currentId = manager.getEffectivePreset(scope, peerId);
                const defaultId = presets.find((p) => p.isDefault)?.id ?? currentId;
                const lines = ['### 🧩 Agent Preset', ''];
                lines.push(`**全局**: ${defaultId ?? '—'}`);
                lines.push('', '**可用 preset**');
                for (const p of presets) {
                    const display = p.name ? `${p.name} (${p.id})` : p.id;
                    // 默认项带 ✅；链接统一指向真实切换命令，重复切换由命令自身幂等处理
                    const suffix = p.id === defaultId ? ' ✅' : '';
                    lines.push(`<qqbot-cmd-input text="/preset ${p.id}" show="/preset ${display}${suffix}"/>`);
                }
                lines.push('', '对之后新建的会话生效');
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
                    default:
                        return `❌ 切换失败: ${outcome.message ?? '未知错误'}`;
                }
            }
            const target = outcome.presetId ?? args;
            if (outcome.unchanged)
                return `✅ 已是全局 preset: ${target}`;
            return `✅ preset 已切换: ${target}（之后新建的会话生效）`;
        },
    };
}
//# sourceMappingURL=preset.js.map