/**
 * 行内标签工具：可点击命令（`<qqbot-cmd-input …/>`）与行内展示文本的净化、转义、截断。
 *
 * 命令层、插件列表、文件链接都要拼这类标签，规则只在这里维护一份：展示文本先净化
 * （换行会打散列表，markdown 与属性字符会破坏渲染），属性值再转义。
 */

/** 行内展示净化：换行与 markdown / 属性字符会破坏标签 */
export function cleanInline(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/[`*_~<>"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** XML 属性值转义：`&` 必须先转义，引号与尖括号会提前结束属性 */
export function attrValue(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 截断到 max 个字符（含省略号）：展示上限要能数得出来 */
export function clip(raw: string, max: number): string {
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

/**
 * 命令属性上限：文档写 text / show 各 100 字符，超了整条消息会被判「过长或异常」。
 *
 * 平台不要求（客户端也不解码）urlencode——现在带空格、反斜杠的标签一直能用，
 * 贸然编码会让点击插入 `%20` 这种字面量。真正必须的是 attrValue 的 XML 转义。
 */
export const TAG_TEXT_MAX = 100;

/** 命令能否塞进标签：生成处与发送端共用同一个判定，按转义后实际发出的属性长度算 */
export function tagTextFits(command: string): boolean {
  return attrValue(command).length <= TAG_TEXT_MAX;
}

/** 可点击命令：QQ 渲染成按钮，点一下把 `command` 填进输入框；`show` 是纯文本短标签 */
export function commandLink(command: string, show: string): string {
  const label = cleanInline(show) || cleanInline(command);
  // 超限的标签平台必拒，退成纯文本：按钮没了，句子还读得通
  if (!tagTextFits(command)) return label;
  return `<qqbot-cmd-input text="${attrValue(command)}" show="${attrValue(label)}"/>`;
}

/**
 * 可点击命令（不过净化）：`show` 是路径、id 这类必须原样显示的值。
 *
 * 净化会删掉 `_` `~` 之类字符，按钮上的值和真实值就对不上；这里只去换行再转义。
 */
export function commandLinkRaw(command: string, show: string): string {
  const label = show.replace(/[\r\n]+/g, ' ').trim() || command;
  if (!tagTextFits(command)) return label;
  return `<qqbot-cmd-input text="${attrValue(command)}" show="${attrValue(label)}"/>`;
}

/** 行内标签的整条形式：只认闭合的 `/>`，残片交给 chunker 兜底 */
const INLINE_TAG_ALL = /<qqbot-cmd-input\b[^>]*\/>/g;

/** 属性里的实体还原成原文（降级展示时用） */
function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 这段文本里有没有平台必拒的标签：缺 text，或 text 超过上限 */
export function hasOversizedTag(text: string): boolean {
  for (const [tag] of text.matchAll(INLINE_TAG_ALL)) {
    const attr = /text="([^"]*)"/.exec(tag)?.[1];
    if (attr === undefined || attr.length > TAG_TEXT_MAX) return true;
  }
  return false;
}

/**
 * 把行内标签降级成纯文本：保留命令原文（点不了，但看得见、能复制）。
 *
 * 只给发送端在被判「过长或异常」时用一次：标签属性不合规时，消息再短也发不出去，
 * 对半切只会把标签切坏、变成一段平台肯收的乱码。
 */
export function stripInlineTags(text: string): string {
  return text.replace(INLINE_TAG_ALL, (tag) => {
    const attr = /text="([^"]*)"/.exec(tag)?.[1];
    return attr === undefined ? '' : `\`${unescapeAttr(attr)}\``;
  });
}
