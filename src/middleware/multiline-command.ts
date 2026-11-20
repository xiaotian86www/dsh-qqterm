/**
 * 多行指令 — 正文带换行的 /cmd 也要能被 SDK 匹配到
 *
 * SDK 的 slashCommand 用 /^(\S+)(?:\s+(.*))?$/ 切命令（qqbot-nodejs 的
 * dist/middleware/slash-command.js）：点号不匹配换行，美元锚点又是整串结尾，
 * 正文里只要有一个换行，整条命令就匹配失败、直接 next() 放行。漏下来的消息
 * 又被「已注册名字」的兜底让过（unknown-command.ts 只拦拼错的名字），最后当成
 * 普通提问转给当前会话——用户写的是 /new -w -- 提示词，实际把命令原文当成
 * prompt 花了一次推理。
 *
 * 修法都在 SDK 外面，分两步：
 * 1. preserveMultilineCommands：在 slashCommand 之前把正文里的换行换成哨兵，
 *    让匹配正则能过；出栈后把 ctx.message.content 还原成原文。
 * 2. restoreMultilineCommands：handler 拿到的 command.raw / args 里还是哨兵，
 *    执行前换回换行。
 *
 * 选哨兵而不是折成空格：/to 这类原样转发正文的命令要保住用户写的换行与代码块。
 */
import type { Middleware, SlashCommand } from '@tencent-connect/qqbot-nodejs';
import { parseCommandCandidate } from './unknown-command.ts';

/**
 * 换行占位符。
 *
 * 取 U+0001（SOH）：点号认它，QQ 客户端不会把它当空白合并，正常文本里也不会
 * 出现。只在下面两个函数之间使用，出栈即还原。
 */
export const NEWLINE_MARK = '\u0001';

/** 需要占位的换行：Windows 的 CRLF 与 JS 正则眼里的全部行终止符 */
const LINE_BREAK_RE = /\r\n|[\r\n\u2028\u2029]/;
const LINE_BREAK_ALL_RE = /\r\n|[\r\n\u2028\u2029]/g;

/**
 * 指令消息里的换行换成占位符，让 SDK 的匹配正则过得去
 *
 * 只处理「前缀 + 已注册指令名 + 含换行」这种明确的指令形态：普通多行文本、
 * /usr/local/bin 这类路径、拼错的指令名都不动，交给后面的链路。
 */
export function preserveMultilineCommands(commandNames: readonly string[]): Middleware {
  const registered = new Set(commandNames.map((name) => name.toLowerCase()));

  return async (ctx, next) => {
    const content = ctx.message.content ?? '';
    const candidate = parseCommandCandidate(content);
    if (
      candidate === undefined
      || !registered.has(candidate.name)
      || !LINE_BREAK_RE.test(content)
    ) {
      await next();
      return;
    }

    ctx.message.content = content.replace(LINE_BREAK_ALL_RE, NEWLINE_MARK);
    try {
      await next();
    } finally {
      // 还原原文：命令没被截获时，后续链路与日志看到的仍是用户写的那条消息
      ctx.message.content = content;
    }
  };
}

/** 把占位符换回换行 */
function restoreText(text: string): string {
  return text.includes(NEWLINE_MARK) ? text.split(NEWLINE_MARK).join('\n') : text;
}

/**
 * 命令 handler 执行前把 command.raw / args 里的占位符换回换行
 *
 * 就地改 ParsedCommand（与 ctx.state.command 是同一个对象），命令读到的就是
 * 用户原样写的正文。原地包装而不浅拷贝：usage 是 getter，浅拷贝会把它冻成
 * 启动那一刻的值。
 */
export function restoreMultilineCommands(commands: SlashCommand[]): SlashCommand[] {
  for (const command of commands) {
    const handler = command.handler;
    command.handler = (ctx) => {
      const parsed = ctx.command;
      if (parsed !== undefined) {
        parsed.raw = restoreText(parsed.raw);
        parsed.args = parsed.args.map(restoreText);
      }
      return handler(ctx);
    };
  }
  return commands;
}
