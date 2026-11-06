/**
 * Preset 命令：/preset — 查看或切换 agent preset
 *
 * 无参数列出可用 preset（可点击切换），有参数切换，reset/default 重置为默认。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { commandAllowlistAuth } from './auth.ts';
import { getScopePeer, sendMarkdownChunked } from '../shared/index.ts';

export function presetCommand({ manager, config, logger }: CommandDeps): CategorizedCommand {
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

        // preset 跟着会话走：已开始的会话就是它锁定的值，未开始的会话显示待定值
        const currentId = manager.getEffectivePreset(scope, peerId);
        const started = manager.getSessionRecord(scope, peerId) !== undefined;

        const lines: string[] = ['### 🧩 Agent Preset', ''];
        lines.push(`**当前**: ${currentId ?? '默认'}`);
        lines.push('', '**可用 preset（点击切换）:**');
        for (const p of presets) {
          const display = p.name ? `${p.name} (${p.id})` : p.id;
          // 当前值带 ✅；链接统一指向真实切换命令，重复切换由命令自身幂等处理
          const isCurrent = p.id === currentId;
          const suffix = isCurrent ? ' ✅' : '';
          lines.push(`<qqbot-cmd-input text="/preset ${p.id}" show="/preset ${display}${suffix}"/>`);
        }
        lines.push(
          '',
          started
            ? '已开始的会话不能改 preset'
            : '手动指定: `/preset <id>`，重置默认: `/preset reset`',
        );

        await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
        return { kind: 'noop' as const };
      }

      // reset / default：清除当前会话的待定 preset，回到默认
      if (args === 'reset' || args === 'default') {
        const outcome = await manager.clearPresetOverride(scope, peerId);
        if (!outcome.ok) {
          return outcome.reason === 'session-started'
            ? '⚠️ 会话已开始，preset 不可再改'
            : `❌ 重置失败: ${outcome.message ?? '未知错误'}`;
        }
        return '✅ 已重置为默认 preset（下一条消息生效）';
      }

      // 切换到指定 preset
      const outcome = await manager.setPresetOverride(scope, peerId, args);
      if (!outcome.ok) {
        switch (outcome.reason) {
          case 'unknown-preset':
            return `⚠️ 未知 preset: ${args}`;
          case 'broken':
            return `❌ preset ${args} 加载失败: ${outcome.message ?? '未知错误'}`;
          case 'session-started':
            return '⚠️ 会话已开始，preset 不可再改';
          default:
            return `❌ 切换失败: ${outcome.message ?? '未知错误'}`;
        }
      }

      const target = outcome.presetId ?? args;
      if (outcome.unchanged) return `✅ 已是当前 preset: ${target}`;

      return `✅ preset 已切换: ${target}（下一条消息生效）`;
    },
  };
}
