import { sendMarkdownChunked } from "../shared/index.js";
/** /bot-reload — 重新加载 profile 里已变更的插件文件 */
export function reloadCommand({ config, reloader }) {
    return {
        name: 'bot-reload',
        category: 'qqbot',
        scope: 'all',
        description: '应用磁盘上的插件变更（热重载）',
        panelDesc: '热重载插件',
        usage: [
            '/bot-reload',
            '',
            '重新加载 profile 目录里已变更的插件文件。',
            '只影响磁盘上真的变过的插件；重载期间机器人会短暂断开。',
            '需要重启才能生效的改动会在完成后提示。',
        ].join('\n'),
        handler: async (cmdCtx) => {
            if (reloader === undefined || !reloader.available) {
                return '⚠️ 当前 profile 未启用热重载';
            }
            // 先回复再调度：重载会 dispose 当前 fiber，回复必须在此之前送出
            await sendMarkdownChunked(cmdCtx, '🔄 正在应用插件变更…', config.textChunkLimit);
            // 被动回复凭证由 ReplyStore 落盘，重载后新 fiber 自己读；这里只留投递目标
            const replyTarget = cmdCtx.replyTarget;
            const bot = cmdCtx.bot;
            const targetId = replyTarget?.targetId;
            reloader.run(targetId === undefined || targetId === ''
                ? undefined
                : { targetId }, bot);
            return { kind: 'noop' };
        },
    };
}
//# sourceMappingURL=reload.js.map