import { parseRest } from "./args.js";
import { sendMarkdownChunked } from "../shared/index.js";
import { commandLinkRaw } from "../shared/inline.js";
import { sessionAdminAuth } from "./sessions.js";
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { execRoot } from "../shell/local-exec.js";
/** 一次最多列多少个子目录（够逛，又不至于刷屏） */
const MAX_ENTRIES = 40;
const USAGE = [
    '### 📖 /ls 用法',
    '',
    '`/ls [路径]` 列出子目录',
    '不写路径看当前目录（dsh 进程启动时所在的位置）；路径可用绝对路径或 `~`',
].join('\n');
/** /ls — 列出目录里的子目录 */
export function lsCommand({ config, logger }) {
    return {
        name: 'ls',
        // 列目录 = 暴露文件系统结构：与 /run、/get 同一权限面
        scope: 'c2c',
        authorized: sessionAdminAuth(config, logger),
        description: '列出子目录',
        usage: USAGE,
        handler: async (cmdCtx) => {
            // 整行都是路径：带空格的路径不用引号也对，写了引号就去掉
            const arg = parseRest(cmdCtx.command?.raw ?? '');
            const text = renderListing(arg);
            // 统一走 markdown 通道：否则 `###` 与 <qqbot-cmd-input> 会成为字面文本
            await sendMarkdownChunked(cmdCtx, text, config.textChunkLimit);
            return { kind: 'noop' };
        },
    };
}
/**
 * 把参数解析成绝对路径。
 *
 * - 空 → 根目录（宿主进程当前目录）；
 * - `~` / `~/xxx` → home 目录（手机上比敲绝对路径省事）；
 * - 绝对路径 → 原样规范化；
 * - 其它 → 相对根目录解析。
 *
 * @param base 根目录（`execRoot`）
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
/** 列出一个目录里的子目录与文件（符号链接按指向的类型归类） */
function listEntries(target) {
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
        const dirs = [];
        const files = [];
        for (const entry of readdirSync(target, { withFileTypes: true })) {
            const isDir = entry.isDirectory()
                || (entry.isSymbolicLink() && isDirectoryLink(target, entry.name));
            (isDir ? dirs : files).push(entry.name);
        }
        const byName = (left, right) => left.localeCompare(right);
        return { ok: true, dirs: dirs.sort(byName), files: files.sort(byName) };
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
/** 渲染 `/ls` 的输出 */
function renderListing(arg) {
    const target = resolveLsTarget(execRoot(), arg);
    const listing = listEntries(target);
    if (!listing.ok) {
        switch (listing.reason) {
            case 'not-directory':
                return `⚠️ 不是目录: \`${target}\``;
            case 'denied':
                return `⚠️ 没有权限读取: \`${target}\``;
            default:
                return `⚠️ 目录不存在: \`${target}\``;
        }
    }
    const lines = [`### 📁 ${basename(target) || target} · \`${target}\``, ''];
    // 目录在前、文件在后，合计不超过上限
    const entries = [
        ...listing.dirs.map((name) => ({ name, dir: true })),
        ...listing.files.map((name) => ({ name, dir: false })),
    ];
    const shown = entries.slice(0, MAX_ENTRIES);
    for (const entry of shown) {
        const path = join(target, entry.name);
        // 目录点一下填 `/ls <路径>`，文件点一下填 `/get <路径>` 直接发文件；
        // 文件名不过净化，否则 `_` `~` 会被删掉，按钮上的名字和真实文件对不上
        lines.push(commandLinkRaw(entry.dir ? `/ls ${path}` : `/get ${path}`, entry.name));
    }
    if (entries.length === 0)
        lines.push('（这里是空的）');
    if (entries.length > shown.length) {
        lines.push('', `还有 ${entries.length - shown.length} 个条目，用 \`/ls <路径>\` 看更多`);
    }
    return lines.join('\n');
}
//# sourceMappingURL=ls.js.map