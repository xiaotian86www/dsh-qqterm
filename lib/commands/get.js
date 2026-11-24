import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { parseRest } from "./args.js";
import { getScopePeer } from "../shared/index.js";
import { sessionAdminAuth } from "./sessions.js";
import { resolveLsTarget } from "./ls.js";
import { execRoot } from "../shell/local-exec.js";
import { sendMediaFile } from "../media/send-media.js";
const USAGE = [
    '### 📖 /get 用法',
    '',
    '`/get <路径>` 发送文件',
    '路径相对当前目录（dsh 进程启动时所在的位置），也可用绝对路径或 `~`',
].join('\n');
/** 命令上下文里的投递目标：SDK 通常已注入，缺失时按当前私聊补 */
function replyTargetOf(cmdCtx, peerId) {
    const injected = cmdCtx.replyTarget;
    return injected ?? { scope: 'c2c', targetId: peerId };
}
export function getCommand({ config, bot, logger }) {
    return {
        name: 'get',
        // 发文件等于让人取走这台电脑上的文件：与 /ls 同一权限面
        scope: 'c2c',
        authorized: sessionAdminAuth(config, logger),
        description: '发送本地文件',
        usage: USAGE,
        handler: async (cmdCtx) => {
            // 整行都是路径：带空格的路径不用引号也对，写了引号就去掉
            const raw = parseRest(cmdCtx.command?.raw ?? '');
            if (raw === '')
                return '⚠️ 缺少文件路径 · 用法: /help get';
            const sender = bot;
            if (sender === undefined)
                return '⚠️ 发送通道不可用，稍后重试。';
            const { peerId } = getScopePeer(cmdCtx);
            const target = resolveLsTarget(execRoot(), raw);
            let isFile = false;
            try {
                isFile = statSync(target).isFile();
            }
            catch {
                return `⚠️ 文件不存在: \`${target}\`\n用 \`/ls\` 看看目录里有什么。`;
            }
            if (!isFile)
                return `⚠️ 不是文件: \`${target}\``;
            const result = await sendMediaFile(sender, replyTargetOf(cmdCtx, peerId), target);
            switch (result.outcome) {
                case 'sent':
                    return { kind: 'noop' };
                case 'missing':
                    return `⚠️ 文件不存在: \`${target}\``;
                default:
                    return `❌ 发送失败: ${basename(target)}\n${result.error}`;
            }
        },
    };
}
//# sourceMappingURL=get.js.map