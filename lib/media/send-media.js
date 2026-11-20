/**
 * 共享的媒体文件发送 — 按扩展名分发到 SDK 的四类发送器
 *
 * 单一事实源：交付物投递（present 声明的文件）与 `/get` 共用同一套
 * 扩展名分类与发送失败判定，行为不会漂移。
 *
 * 不限制目录：插件只服务唯一绑定用户（`access.owner`），文件永远只发到
 * 该用户的私聊，路径白名单没有额外的安全收益。
 */
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { resolveAgentCwd } from "../shared/dirs.js";
import { errorMessage } from "../shared/utils.js";
export { resolveAgentCwd };
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
const VOICE_EXTS = new Set(['.mp3', '.wav', '.ogg', '.aac', '.silk', '.amr']);
/**
 * 按扩展名分类发送一个本地文件
 *
 * 文件不存在、不是普通文件时返回 missing（不抛错，调用方决定降级文案）；
 * 平台发送失败返回 failed。文件名透传给通用文件通道。
 */
export async function sendMediaFile(bot, target, filePath, opts = {}) {
    let size;
    try {
        const info = await stat(filePath);
        if (!info.isFile())
            return { outcome: 'missing' };
        size = info.size;
    }
    catch {
        return { outcome: 'missing' };
    }
    const fileName = opts.fileName ?? basename(filePath);
    const ext = extname(filePath).toLowerCase();
    const source = { localPath: filePath };
    try {
        const result = ext === '.gif' || IMAGE_EXTS.has(ext)
            ? await bot.sendImage(target, source)
            : VIDEO_EXTS.has(ext)
                ? await bot.sendVideo(target, source)
                : VOICE_EXTS.has(ext)
                    ? await bot.sendVoice(target, source)
                    : await bot.sendFile(target, source, { fileName });
        return {
            outcome: 'sent',
            size,
            ...(result.upload.file_uuid !== undefined ? { fileUuid: result.upload.file_uuid } : {}),
            ...(result.message?.id !== undefined ? { messageId: result.message.id } : {}),
        };
    }
    catch (err) {
        return { outcome: 'failed', error: errorMessage(err) };
    }
}
//# sourceMappingURL=send-media.js.map