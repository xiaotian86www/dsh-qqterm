/**
 * /bot-sync — 把插件当前配置同步到 QQ 侧的两个展示面
 *
 *   - 指令面板（输入 `/` 弹出的列表）
 *   - 自定义菜单（私聊窗口底部的固定入口，含权限 / 思考两个子菜单）
 *
 * 两者都是机器人级配置，改完不会自动生效（菜单甚至要退出对话框再进来），
 * 所以合在一个命令里手动重推。启动时的自动同步见 bootstrap。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { ownerOnlyAuth } from './auth.ts';
import { formatPanelSummary, syncCommandPanels } from '../features/command-panel.ts';
import { syncCommandMenu } from '../features/command-menu.ts';

/** 单次同步的结果行 */
interface SyncLine {
  ok: boolean;
  text: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 结果行 → 用户可见文案（2~3 行，失败时写清是哪一项） */
export function formatSyncReply(lines: readonly SyncLine[]): string {
  const failed = lines.filter((line) => !line.ok);

  if (failed.length === 0) {
    return ['✅ 已同步 QQ 侧配置', ...lines.map((line) => line.text)].join('\n');
  }
  if (failed.length === lines.length) {
    return ['❌ QQ 侧配置同步失败', ...lines.map((line) => line.text)].join('\n');
  }
  return [
    '⚠️ QQ 侧配置部分同步失败',
    ...lines.map((line) => (line.ok ? `✅ ${line.text}` : `❌ ${line.text}`)),
  ].join('\n');
}

/** /bot-sync — 同步指令面板与自定义菜单 */
export function syncCommand(
  { bot, config, logger }: CommandDeps,
  allCommands: () => CategorizedCommand[],
): CategorizedCommand {
  return {
    name: ['bot-sync', 'bot-refresh'],
    category: 'qqbot',
    scope: 'all',
    description: '同步指令面板与自定义菜单',
    authorized: ownerOnlyAuth(config, logger),
    handler: async () => {
      if (!bot) return '⚠️ 同步失败: 机器人未就绪';

      const lines: SyncLine[] = [];

      try {
        const panels = await syncCommandPanels(bot.api, allCommands(), logger);
        lines.push({ ok: true, text: `指令面板: ${formatPanelSummary(panels) || '无可写指令'}` });
      } catch (err) {
        lines.push({ ok: false, text: `指令面板: ${errorMessage(err)}` });
      }

      try {
        const menu = await syncCommandMenu(bot.api, logger);
        lines.push({ ok: true, text: `自定义菜单: ${menu.count} 项${menu.action === 'unchanged' ? '（已是最新）' : ''}` });
      } catch (err) {
        lines.push({ ok: false, text: `自定义菜单: ${errorMessage(err)}` });
      }

      for (const line of lines) {
        if (!line.ok) logger?.warn(`[qqterm] /bot-sync failed: ${line.text}`);
      }
      return formatSyncReply(lines);
    },
  };
}
