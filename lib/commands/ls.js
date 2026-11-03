import { getScopePeer, sendMarkdownChunked } from "../shared/index.js";
import { sessionAdminAuth } from "./sessions.js";
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
/** 一次最多列多少个子目录（够逛，又不至于刷屏） */
const MAX_ENTRIES = 40;
const USAGE = [
    '**目录**',
    '`/ls` 看当前工作区的子目录',
    '`/ls <路径>` 看指定目录（相对当前工作区、绝对路径、`~` 都行）',
].join('\n');
/** /ls — 列出目录里的子目录 */
export function lsCommand({ manager, config, logger }) {
    return {
        name: 'ls',
        category: 'agent',
        // 列目录 = 暴露文件系统结构：与 /workspace 同一权限面
        scope: 'c2c',
        authorized: sessionAdminAuth(config, logger),
        description: '列出子目录（点条目进下一层）',
        usage: USAGE,
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const arg = (cmdCtx.command?.raw ?? '').trim();
            let text;
            try {
                text = await renderListing(manager, scope, peerId, arg);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logger?.warn(`/ls 失败: ${message}`);
                text = `⚠️ 列目录失败：${message}`;
            }
            // 统一走 markdown 通道：否则 `###` 与 <qqbot-cmd-input> 会成为字面文本
            await sendMarkdownChunked(cmdCtx, text, config.textChunkLimit);
            return { kind: 'noop' };
        },
    };
}
/**
 * 把参数解析成绝对路径。
 *
 * - 空 → 当前工作区目录；
 * - `~` / `~/xxx` → home 目录（手机上比敲绝对路径省事）；
 * - 绝对路径 → 原样规范化；
 * - 其它 → 相对当前工作区解析。
 *
 * @param base 当前工作区目录
 * @param arg 用户输入（已 trim）
 */
export function resolveLsTarget(base, arg) {
    if (arg === '')
        return resolve(base);
    if (arg === '~')
        return homedir();
    if (arg.startsWith('~/') || arg.startsWith('~\\'))
        return resolve(homedir(), arg.slice(2));
    return isAbsolute(arg) ? resolve(arg) : resolve(base, arg);
}
/** 列出一个目录里的子目录（符号链接指向目录的也算） */
function listDirectories(target) {
    let stats;
    try {
        stats = statSync(target);
    }
    catch (err) {
        const code = err.code;
        return { ok: false, reason: code === 'EACCES' || code === 'EPERM' ? 'denied' : 'missing' };
    }
    if (!stats.isDirectory())
        return { ok: false, reason: 'not-directory' };
    try {
        const dirs = readdirSync(target, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isDirectoryLink(target, entry.name)))
            .map((entry) => entry.name)
            .sort((left, right) => left.localeCompare(right));
        return { ok: true, dirs };
    }
    catch {
        return { ok: false, reason: 'denied' };
    }
}
/** 符号链接是否指向目录（读不到就当作不是，别让一个坏链接拖垮整个列表） */
function isDirectoryLink(parent, name) {
    try {
        return statSync(join(parent, name)).isDirectory();
    }
    catch {
        return false;
    }
}
/** 一个可点击条目：点一下把 `text` 填进输入框，显示 `show` */
function button(path, show) {
    return `<qqbot-cmd-input text="${attr(`/ls ${path}`)}" show="${attr(show)}"/>`;
}
/** 属性值转义：目录名里出现引号/尖括号不能把按钮标签弄坏 */
function attr(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
/** 渲染 `/ls` 的输出 */
async function renderListing(manager, scope, peerId, arg) {
    const info = await manager.currentWorkspaceInfo(scope, peerId).catch(() => undefined);
    if (!info)
        return '⚠️ 读不到当前工作区。';
    if (info.missing)
        return `⚠️ 当前工作区目录不存在：\`${info.path}\``;
    const target = resolveLsTarget(info.path, arg);
    const listing = listDirectories(target);
    if (!listing.ok) {
        switch (listing.reason) {
            case 'not-directory':
                return `⚠️ 不是目录：\`${target}\``;
            case 'denied':
                return `⚠️ 没有权限读取：\`${target}\``;
            default:
                return `⚠️ 目录不存在：\`${target}\``;
        }
    }
    const lines = [`### 📁 ${basename(target) || target} · \`${target}\``, ''];
    const shown = listing.dirs.slice(0, MAX_ENTRIES);
    for (const name of shown)
        lines.push(button(join(target, name), name));
    if (listing.dirs.length === 0)
        lines.push('（没有子目录）');
    if (listing.dirs.length > shown.length) {
        lines.push('', `还有 ${listing.dirs.length - shown.length} 个子目录未列出：直接 \`/ls <路径>\` 进去`);
    }
    return lines.join('\n');
}
//# sourceMappingURL=ls.js.map