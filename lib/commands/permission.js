import { parseRest } from "./args.js";
import { ownerOnlyAuth } from "./auth.js";
import { getScopePeer, sendMarkdownChunked } from "../shared/index.js";
import { commandLinkRaw } from "../shared/inline.js";
/** 宿主权限预设的中文名（宿主只给 id，Web 端的文案在客户端 locale 里） */
const PRESET_LABELS = {
    'read-only': '仅可查看',
    'workspace-write': '工作区内修改',
    'danger-full-access': '完全权限',
    auto: '自动审查',
};
/** 预设的风险提示：不启用沙箱的两种模式必须明说 */
const PRESET_WARNINGS = {
    auto: '⚠️ 不启用沙箱，每次工具调用先由模型预审（额外消耗 token）',
    'danger-full-access': '⚠️ 不启用沙箱，也不再逐次审批',
};
/** 展示用标签：中文名 (id)；未知预设按 id 展示（/status 的权限行同用） */
export function presetLabel(id, entry) {
    const label = PRESET_LABELS[id] ?? entry?.name ?? id;
    return label === id ? id : `${label} (${id})`;
}
export function permissionCommand({ manager, config, logger }) {
    return {
        name: 'permission',
        // 管理类指令：只允许唯一绑定用户
        scope: 'all',
        authorized: ownerOnlyAuth(config, logger),
        description: '查看或切换权限预设',
        usage: [
            '### 📖 /permission 用法',
            '',
            '`/permission` 查看当前权限',
            '`/permission <预设>` 切换权限预设',
        ].join('\n'),
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const args = parseRest(cmdCtx.command?.raw ?? '');
            const entries = manager.listPermissionPresets();
            if (entries.length === 0) {
                return '⚠️ 当前部署没有权限预设';
            }
            // 有会话看会话自己的值；没有会话时这里是宿主的部署默认值（新建会话会用它）
            // 沿用「当前」的写法，不另造标签
            const current = manager.getPermissionPreset(scope, peerId);
            // 无参数：一行现状 + 可点击切换的预设
            if (!args) {
                const lines = ['### 🛡️ 权限预设'];
                if (current)
                    lines.push('', `当前: ${presetLabel(current)}`);
                lines.push('');
                for (const entry of entries) {
                    const label = presetLabel(entry.id, entry);
                    const suffix = entry.id === current ? ' ✅' : entry.id === 'auto' ? ' · EXP' : '';
                    lines.push(commandLinkRaw(`/permission ${entry.id}`, `/permission ${label}${suffix}`));
                }
                await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
                return { kind: 'noop' };
            }
            const target = args;
            const outcome = await manager.setPermissionPreset(scope, peerId, target);
            if (!outcome.ok) {
                switch (outcome.reason) {
                    case 'unknown-preset':
                        return `⚠️ 未知权限预设: ${target}`;
                    default:
                        return `❌ 权限切换失败: ${outcome.message ?? '未知错误'}`;
                }
            }
            const label = presetLabel(target, entries.find((entry) => entry.id === target));
            if (outcome.unchanged) {
                return `✅ 已是当前权限预设: ${label}`;
            }
            const lines = [`✅ 权限已切换: ${label}`];
            const warning = PRESET_WARNINGS[target];
            if (warning)
                lines.push(warning);
            return lines.join('\n');
        },
    };
}
//# sourceMappingURL=permission.js.map