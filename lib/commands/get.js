import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { parseRest } from "./args.js";
import { getScopePeer } from "../shared/index.js";
import { sessionAdminAuth } from "./sessions.js";
import { resolveLsTarget } from "./ls.js";
import { sendMediaFile } from "../media/send-media.js";
const USAGE = [
    '### 📖 /get 用法',
    '',
    '`/get <路径>` 发送文件',
    '路径相对当前工作区，也可用绝对路径或 `~`',
].join('\n');
/** 命令上下文里的投递目标：SDK 通常已注入，缺失时按当前私聊补 */
function replyTargetOf(cmdCtx, peerId) {
    const injected = cmdCtx.replyTarget;
    return injected ?? { scope: 'c2c', targetId: peerId };
}
export function getCommand({ manager, config, bot, logger }) {
    return {
        name: 'get',
        // 发文件等于让人取走 agent 能碰的文件：与 /ls 同一权限面
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
                return '⚠️ 发送通道不可用';
            const { scope, peerId } = getScopePeer(cmdCtx);
            const info = await manager.currentWorkspaceInfo(scope, peerId).catch(() => undefined);
            if (info === undefined)
                return '⚠️ 读不到当前工作区。';
            const target = resolveLsTarget(info.path, raw);
            let isFile = false;
            try {
                isFile = statSync(target).isFile();
            }
            catch {
                return `⚠️ 文件不存在: \`${target}\``;
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