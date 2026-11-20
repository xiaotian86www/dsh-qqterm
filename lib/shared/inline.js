/**
 * 行内标签工具：可点击命令（`<qqbot-cmd-input …/>`）与行内展示文本的净化、转义、截断。
 *
 * 命令层、插件列表、文件链接都要拼这类标签，规则只在这里维护一份：展示文本先净化
 * （换行会打散列表，markdown 与属性字符会破坏渲染），属性值再转义。
 */
/** 行内展示净化：换行与 markdown / 属性字符会破坏标签 */
export function cleanInline(raw) {
    return raw
        .replace(/[\r\n]+/g, ' ')
        .replace(/[`*_~<>"']/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
/** XML 属性值转义：`&` 必须先转义，引号与尖括号会提前结束属性 */
export function attrValue(raw) {
    return raw
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
/** 截断到 max 个字符（含省略号）：展示上限要能数得出来 */
export function clip(raw, max) {
    return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}
/** 可点击命令：QQ 渲染成按钮，点一下把 `command` 填进输入框；`show` 是纯文本短标签 */
export function commandLink(command, show) {
    return `<qqbot-cmd-input text="${attrValue(command)}" show="${attrValue(cleanInline(show) || command)}"/>`;
}
/**
 * 可点击命令（不过净化）：`show` 是路径、id 这类必须原样显示的值。
 *
 * 净化会删掉 `_` `~` 之类字符，按钮上的值和真实值就对不上；这里只去换行再转义。
 */
export function commandLinkRaw(command, show) {
    const label = show.replace(/[\r\n]+/g, ' ').trim() || command;
    return `<qqbot-cmd-input text="${attrValue(command)}" show="${attrValue(label)}"/>`;
}
//# sourceMappingURL=inline.js.map