import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { getScopePeer } from "../shared/index.js";
import { sessionAdminAuth } from "./sessions.js";
import { resolveLsTarget } from "./ls.js";
import { sendMediaFile } from "../media/send-media.js";
const USAGE = [
    '**/get** 发送文件',
    '`/get <路径>` 相对当前工作区、绝对路径、`~` 都行',
].join('\n');
/** 命令上下文里的投递目标：SDK 通常已注入，缺失时按当前私聊补 */
function replyTargetOf(cmdCtx, peerId) {
    const injected = cmdCtx.replyTarget;
    return injected ?? { scope: 'c2c', targetId: peerId };
}
export function getCommand({ manager, config, bot, logger }) {
    return {
        name: 'get',
        category: 'agent',
        // 发文件等于让人取走 agent 能碰的文件：与 /ls 同一权限面
        scope: 'c2c',
        authorized: sessionAdminAuth(config, logger),
        description: '把本地文件发到聊天',
        usage: USAGE,
        handler: async (cmdCtx) => {
            const raw = (cmdCtx.command?.raw ?? '').trim();
            if (raw === '')
                return `⚠️ 缺少文件路径\n${USAGE}`;
            const sender = bot;
            if (sender === undefined)
                return '⚠️ 发送通道不可用，稍后重试。';
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
                return `⚠️ 文件不存在: \`${target}\`\n用 \`/ls\` 看看目录里有什么。`;
            }
            if (!isFile)
                return `⚠️ 不是文件: \`${target}\``;
            const result = await sendMediaFile(sender, replyTargetOf(cmdCtx, peerId), target);
            switch (result.outcome) {
                case 'sent':
                    return `✅ 已发送: ${basename(target)}`;
                case 'missing':
                    return `⚠️ 文件不存在: \`${target}\``;
                default:
                    return `❌ 发送失败: ${basename(target)}\n${result.error}`;
            }
        },
    };
}
//# sourceMappingURL=get.js.map