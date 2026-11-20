import { parseCommandCandidate } from "./unknown-command.js";
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
export function preserveMultilineCommands(commandNames) {
    const registered = new Set(commandNames.map((name) => name.toLowerCase()));
    return async (ctx, next) => {
        const content = ctx.message.content ?? '';
        const candidate = parseCommandCandidate(content);
        if (candidate === undefined
            || !registered.has(candidate.name)
            || !LINE_BREAK_RE.test(content)) {
            await next();
            return;
        }
        ctx.message.content = content.replace(LINE_BREAK_ALL_RE, NEWLINE_MARK);
        try {
            await next();
        }
        finally {
            // 还原原文：命令没被截获时，后续链路与日志看到的仍是用户写的那条消息
            ctx.message.content = content;
        }
    };
}
/** 把占位符换回换行 */
function restoreText(text) {
    return text.includes(NEWLINE_MARK) ? text.split(NEWLINE_MARK).join('\n') : text;
}
/**
 * 命令 handler 执行前把 command.raw / args 里的占位符换回换行
 *
 * 就地改 ParsedCommand（与 ctx.state.command 是同一个对象），命令读到的就是
 * 用户原样写的正文。原地包装而不浅拷贝：usage 是 getter，浅拷贝会把它冻成
 * 启动那一刻的值。
 */
export function restoreMultilineCommands(commands) {
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
//# sourceMappingURL=multiline-command.js.map