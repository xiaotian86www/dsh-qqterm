/**
 * 被动回复凭证装饰器 — 把 msg_id / event_id 的解析下沉到 bot 实例。
 *
 * 业务层只传「想回给谁」（ReplyTarget），由这里统一决定能不能走被动回复：
 *   - 有可用凭证 → 填 msg_id（或 event_id）发出去；
 *   - 全不可用 → 不填凭证，SDK 自动降级为主动推送。
 *
 * 为什么必须装饰实例而不是在各自 adapter 里 resolve：SDK 内部的
 * slashCommand 返回值、errorHandler、typingIndicator 直接调 ctx.bot 的方法，
 * 这些调用点不在插件代码里，只有装饰实例才能覆盖。
 *
 * `send` 不装饰：它是低层原语，event_id 就靠它传 extra；装饰会导致二次解析。
 *
 * 流式没法降级成事件回复：resolve 不到 msg_id 时 openStream 返回 undefined，
 * 由调用方转静态发送（少一次「先 peek 再 resolve」的竞态判断）。
 */
import { MsgType } from '@tencent-connect/qqbot-nodejs';
/**
 * 这些方法只能填 msg_id（sendMessage / 文件接口 / 流式都不支持 event_id）
 *
 * 不装饰 `sendMedia`：SDK 的 sendImage / sendVideo / sendFile 内部都走
 * `this.sendMedia({ target, ...source })`，再包一层会让第一次调用被当成
 * target 二次解析，source 丢失（表现为 uploadMedia 报「没有 url/fileData/
 * buffer/localPath」）。媒体一律从三个便利方法进入，够用了。
 */
const MSG_ONLY_METHODS = [
    'sendText',
    'sendTextWithKeyboard',
    'sendImage',
    'sendVideo',
    'sendVoice',
    'sendFile',
];
function bindMethod(bot, name) {
    const fn = bot[name];
    return typeof fn === 'function' ? fn.bind(bot) : undefined;
}
/**
 * 就地装饰 bot 实例的所有发送方法，返回同一个实例。
 *
 * @throws 当实例缺少低层 `send()` 时（SDK 版本不兼容），宁可启动失败也不要静默丢消息。
 */
export function createReplyAwareBot(bot, store) {
    const target = bot;
    const send = bindMethod(bot, 'send');
    if (send === undefined) {
        throw new Error('QQBot 实例缺少 send()，无法接管被动回复');
    }
    const markdown = bindMethod(bot, 'sendMarkdown');
    if (markdown !== undefined) {
        target['sendMarkdown'] = (replyTarget, content, opts) => {
            const resolved = store.resolve(replyTarget, true);
            if (resolved.eventId !== undefined) {
                // SDK sendMarkdown 不支持 event_id，只能走低层 send 的 extra。
                // msg_seq 必须每次不同：平台按 (event_id, msg_seq) 去重，缺省时 SDK 恒填 1。
                return send({
                    target: { scope: resolved.scope, targetId: resolved.targetId, msgId: undefined },
                    msgType: MsgType.MARKDOWN,
                    markdown: { content },
                    keyboard: opts?.keyboard,
                    extra: { event_id: resolved.eventId, msg_seq: resolved.msgSeq },
                });
            }
            return markdown(resolved, content, opts);
        };
    }
    for (const name of MSG_ONLY_METHODS) {
        const original = bindMethod(bot, name);
        if (original === undefined)
            continue;
        target[name] = (replyTarget, ...rest) => original(store.resolve(replyTarget, false), ...rest);
    }
    const openStream = bindMethod(bot, 'openStream');
    if (openStream !== undefined) {
        target['openStream'] = (params) => {
            const resolved = store.resolve(params.target, false);
            // 没有 msg_id 就开不了流（SDK 会抛），直接返回 undefined 让调用方走静态
            if (resolved.msgId === undefined)
                return undefined;
            return openStream({ ...params, target: resolved });
        };
    }
    return bot;
}
//# sourceMappingURL=reply-bot.js.map