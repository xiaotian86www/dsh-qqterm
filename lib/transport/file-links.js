/**
 * markdown 本地文件链接 → `/get` 命令链接
 *
 * agent 在正文里写的 `[报告](D:\out\report.md)` 在 QQ 里点不开：QQ 不认本地路径。
 * 发送前把这类链接改写成可点击的 `/get <绝对路径>`，点一下就让插件把文件发到聊天里。
 *
 * 判定与 Web 端一致：目标以 `/`、`./`、`../` 或盘符开头算本地文件；不带前缀的
 * 相对写法（`report.md`）只有相对工作目录命中真实文件时才算。带 `?` 的一律当外链；
 * 带行号锚点（`#L10` / `#L10-L20`）的链接指向具体代码行，发送整个文件没有意义，
 * 保持原样。只改写真实存在的普通文件，目录与坏路径保持原样，不造点不开的按钮。
 *
 * 代码块与行内代码里的内容不改写——那里是示例，不是真链接。
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
/** 本地路径判定（与 Web markdown 渲染器同一套规则） */
const LOCAL_PATH = /^(?:[\/\\]|\.{1,2}[\/\\]|[a-z]:[\/\\])/i;
/** `[label](target)` 或 `[label](<target> "title")` */
const LINK = /\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
/** 行内代码：里面的链接是示例，不改写 */
const INLINE_CODE = /`[^`\n]*`/g;
/** 可点击命令的 show 上限（与按钮短标签一致） */
const SHOW_MAX = 28;
/** 行内展示净化：换行与 markdown / 属性字符会破坏标签 */
function cleanInline(raw) {
    return raw
        .replace(/[\r\n]+/g, ' ')
        .replace(/[`*_~<>"']/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
/** XML 属性值转义（`&` 在 QQ 的指令标签里必须先转义） */
function attrValue(raw) {
    return raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
/** 超长文本截断（带省略号） */
function clip(raw, max) {
    return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}
/**
 * 把链接目标解析成允许发送的绝对路径；不是本地文件、不存在、不是普通文件时返回 undefined。
 *
 * @param rawTarget markdown 里的目标（已去掉尖括号）
 * @param cwd 会话工作目录：相对路径的基准；未知时只认绝对路径与 `~`
 */
export function resolveLocalFile(rawTarget, cwd) {
    const target = rawTarget.trim();
    if (target === '' || target.includes('?'))
        return undefined;
    const hash = target.indexOf('#');
    // 行号锚点指向具体代码行，换成「发送整个文件」丢掉了链接的原意
    if (hash !== -1 && /^L\d/i.test(target.slice(hash + 1)))
        return undefined;
    const path = (hash === -1 ? target : target.slice(0, hash)).trim();
    if (path === '')
        return undefined;
    // 不含 `/` `./` `../` 盘符的写法只有「相对工作目录能命中真实文件」才算本地路径；
    // 其它带协议的（http:、mailto: 等）仍是外链
    if (!LOCAL_PATH.test(path)) {
        if (cwd === undefined || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//'))
            return undefined;
    }
    let absolute;
    if (path === '~')
        absolute = homedir();
    else if (path.startsWith('~/') || path.startsWith('~\\'))
        absolute = resolve(homedir(), path.slice(2));
    else if (isAbsolute(path))
        absolute = path;
    else if (cwd !== undefined)
        absolute = resolve(cwd, path);
    else
        return undefined;
    try {
        if (!statSync(absolute).isFile())
            return undefined;
    }
    catch {
        return undefined;
    }
    return absolute;
}
/** 把一段普通文本里的本地文件链接改写成 `/get` 命令 */
function rewriteText(part, cwd) {
    return part.replace(LINK, (whole, label, rawTarget, offset) => {
        // `![alt](x)` 是 markdown 图片：留一个 `!` 在按钮前面没有意义，图片由出站图片链路处理
        if (part[offset - 1] === '!')
            return whole;
        const target = rawTarget.startsWith('<') ? rawTarget.slice(1, -1) : rawTarget;
        const absolute = resolveLocalFile(target, cwd);
        if (absolute === undefined)
            return whole;
        const show = clip(cleanInline(label), SHOW_MAX) || basename(absolute);
        return `<qqbot-cmd-input text="${attrValue(`/get ${absolute}`)}" show="${attrValue(show)}"/>`;
    });
}
/** 一行里跳过行内代码，只改写普通文本 */
function rewriteLine(line, cwd) {
    let out = '';
    let last = 0;
    for (const match of line.matchAll(INLINE_CODE)) {
        const start = match.index ?? 0;
        out += rewriteText(line.slice(last, start), cwd);
        out += match[0];
        last = start + match[0].length;
    }
    return out + rewriteText(line.slice(last), cwd);
}
/**
 * 改写文本里的本地文件链接。
 *
 * @param text 出站 markdown
 * @param cwd 会话工作目录（相对链接的基准）；未知时只改写绝对路径与 `~`
 * @returns 改写后的文本；没有可改写的链接时原样返回
 */
export function rewriteLocalFileLinks(text, cwd) {
    if (!text.includes(']('))
        return text;
    const lines = text.split('\n');
    let fenced = false;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        if (/^\s*(```|~~~)/.test(line)) {
            fenced = !fenced;
            continue;
        }
        if (!fenced)
            lines[i] = rewriteLine(line, cwd);
    }
    return lines.join('\n');
}
//# sourceMappingURL=file-links.js.map