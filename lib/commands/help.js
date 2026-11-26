import { ArgError, parseArgs } from "./args.js";
import { sendMarkdownChunked } from "../shared/index.js";
import { commandLink } from "../shared/inline.js";
import { visibleCommands } from "./availability.js";
/** 命令的主名：name 可能是数组，第一项是主名 */
function primaryName(cmd) {
    return Array.isArray(cmd.name) ? (cmd.name[0] ?? '') : cmd.name;
}
/** 按主名或别名查找命令（`/help think` 与 `/help reasoning` 等价） */
function findCommand(commands, name) {
    const needle = name.toLowerCase();
    return commands.find((cmd) => {
        const names = Array.isArray(cmd.name) ? cmd.name : [cmd.name];
        return names.some((candidate) => candidate.toLowerCase() === needle);
    });
}
/** 用法页：命令自带 usage；不带参数的指令用一行签名兜底 */
function usagePage(cmd) {
    if (cmd.usage !== undefined)
        return cmd.usage;
    const name = primaryName(cmd);
    return [`### 📖 /${name} 用法`, '', `\`/${name}\` ${cmd.description ?? ''}`.trimEnd()].join('\n');
}
/** /help — 平铺查看所有指令 */
export function helpCommand({ config }, allCommands) {
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
            // 参数走共用解析器：只收一个指令名，多写一段按参数错误回绝
            let parsed;
            try {
                parsed = parseArgs(cmdCtx.command?.raw ?? '', { command: 'help' });
            }
            catch (error) {
                if (error instanceof ArgError)
                    return error.message;
                throw error;
            }
            // 能力门控在每次查看时现算：晚挂载的服务立刻出现在用法页
            const commands = visibleCommands(allCommands());
            const [name] = parsed.words;
            if (name !== undefined) {
                if (parsed.words.length > 1)
                    return '⚠️ 只能看一个指令 · 用法: /help';
                const target = findCommand(commands, name);
                if (target === undefined)
                    return '⚠️ 没有这个指令 · 用法: /help';
                await sendMarkdownChunked(cmdCtx, usagePage(target), config.textChunkLimit);
                return { kind: 'noop' };
            }
            const lines = ['### 🤖 QQ 超级终端指令', ''];
            for (const cmd of commands) {
                if (cmd.hidden)
                    continue;
                const name = primaryName(cmd);
                // 点击填 `/help <命令>` 而不是直接执行：看用法不会误触发换会话、发文件
                lines.push(`${commandLink(`/help ${name}`, `/${name}`)} ${cmd.description ?? ''}`);
            }
            await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
            return { kind: 'noop' };
        },
    };
}
//# sourceMappingURL=help.js.map