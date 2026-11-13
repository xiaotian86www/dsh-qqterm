/**
 * /help — 指令索引与用法页
 *
 * 不带参数：列出全部指令（一行一条，只有名字与短语）。
 * 带参数：把该命令声明的 `usage` 原样发出——参数写法只有这一处来源，
 * 命令缺参时也只指向 `/help <命令>`，不再各自拼用法。
 */
import type { CommandDeps, SlashCommand } from './types.ts';
import { sendMarkdownChunked } from '../shared/index.ts';

/** 命令的主名：name 可能是数组，第一项是主名 */
function primaryName(cmd: SlashCommand): string {
  return Array.isArray(cmd.name) ? (cmd.name[0] ?? '') : cmd.name;
}

/** 按主名或别名查找命令（`/help think` 与 `/help reasoning` 等价） */
function findCommand(commands: readonly SlashCommand[], name: string): SlashCommand | undefined {
  const needle = name.toLowerCase();
  return commands.find((cmd) => {
    const names = Array.isArray(cmd.name) ? cmd.name : [cmd.name];
    return names.some((candidate) => candidate.toLowerCase() === needle);
  });
}

/** 用法页：命令自带 usage；不带参数的指令用一行签名兜底 */
function usagePage(cmd: SlashCommand): string {
  if (cmd.usage !== undefined) return cmd.usage;
  const name = primaryName(cmd);
  return [`### 📖 /${name} 用法`, '', `\`/${name}\` ${cmd.description ?? ''}`.trimEnd()].join('\n');
}

/** /help — 平铺查看所有指令 */
export function helpCommand(
  { config }: CommandDeps,
  allCommands: () => SlashCommand[],
): SlashCommand {
  return {
    name: 'help',
    scope: 'all',
    description: '查看指令',
    usage: [
      '### 📖 /help 用法',
      '',
      '`/help` 查看所有指令',
      '`/help <命令>` 查看某个指令的用法',
    ].join('\n'),
    handler: async (cmdCtx) => {
      const arg = (cmdCtx.command?.raw ?? '').trim();
      const commands = allCommands();

      if (arg !== '') {
        const name = arg.split(/\s+/)[0] ?? '';
        const target = findCommand(commands, name);
        if (target === undefined) return '⚠️ 没有这个指令 · 用法: /help';

        await sendMarkdownChunked(cmdCtx, usagePage(target), config.textChunkLimit);
        return { kind: 'noop' as const };
      }

      const lines: string[] = ['### 🤖 QQ 超级终端指令', ''];
      for (const cmd of commands) {
        if (cmd.hidden) continue;
        const name = primaryName(cmd);
        // 点击填 `/help <命令>` 而不是直接执行：看用法不会误触发换会话、发文件
        lines.push(`<qqbot-cmd-input text="/help ${name}" show="/${name}"/> ${cmd.description ?? ''}`);
      }

      await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
      return { kind: 'noop' as const };
    },
  };
}
