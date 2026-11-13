/**
 * 权限命令：/permission — 查看或切换权限预设（沙箱模式 + 审批策略）
 *
 * 与宿主的 `/permission` 同语义：只切换本聊天**当前会话**，立即生效；`/new`
 * 之后的新会话仍回到 profile 的默认权限预设。
 *
 * 这是唯一能把沙箱关掉的指令（`auto` / `danger-full-access` 都不启用沙箱），
 * 因此和其他管理命令一样只允许唯一绑定用户执行（见 auth.ts 的 ownerOnlyAuth）。
 */
import type { CommandDeps, SlashCommand } from './types.ts';
import { ownerOnlyAuth } from './auth.ts';
import { getScopePeer, sendMarkdownChunked } from '../shared/index.ts';
import type { PermissionPresetEntry } from '../session/index.ts';

/** 宿主权限预设的中文名（宿主只给 id，Web 端的文案在客户端 locale 里） */
const PRESET_LABELS: Record<string, string> = {
  'read-only': '仅可查看',
  'workspace-write': '工作区内修改',
  'danger-full-access': '完全权限',
  auto: '自动审查',
};

/** 预设的风险提示：不启用沙箱的两种模式必须明说 */
const PRESET_WARNINGS: Record<string, string> = {
  auto: '⚠️ 不启用沙箱，每次工具调用先由模型预审（额外消耗 token）',
  'danger-full-access': '⚠️ 不启用沙箱，也不再逐次审批',
};

/** 展示用标签：中文名 (id)；未知预设按 id 展示（/status 的权限行同用） */
export function presetLabel(id: string, entry?: PermissionPresetEntry): string {
  const label = PRESET_LABELS[id] ?? entry?.name ?? id;
  return label === id ? id : `${label} (${id})`;
}

export function permissionCommand({ manager, config, logger }: CommandDeps): SlashCommand {
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
      const args = (cmdCtx.command?.raw ?? '').trim();

      const entries = manager.listPermissionPresets();
      if (entries.length === 0) {
        return '⚠️ 当前部署没有权限预设';
      }

      // 有会话看会话自己的值；没有会话时这里是宿主的部署默认值（新建会话会用它）
      // 沿用「当前」的写法，不另造标签
      const current = manager.getPermissionPreset(scope, peerId);

      // 无参数：一行现状 + 可点击切换的预设
      if (!args) {
        const lines: string[] = ['### 🛡️ 权限预设'];
        if (current) lines.push('', `当前: ${presetLabel(current)}`);
        lines.push('');
        for (const entry of entries) {
          const label = presetLabel(entry.id, entry);
          const suffix = entry.id === current ? ' ✅' : entry.id === 'auto' ? ' · EXP' : '';
          lines.push(`<qqbot-cmd-input text="/permission ${entry.id}" show="/permission ${label}${suffix}"/>`);
        }

        await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
        return { kind: 'noop' as const };
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
      if (warning) lines.push(warning);
      return lines.join('\n');
    },
  };
}
