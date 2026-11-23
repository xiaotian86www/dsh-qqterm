import { shortSessionId } from "../shared/utils.js";
import { commandLink } from "../shared/inline.js";
/** 标题在来源行里的展示上限（日志标题可能很长，来源行要保持一行） */
const TITLE_MAX = 20;
/** 取不到标题时的兜底名，避免来源行只剩一个 id */
export const UNNAMED_SESSION_TITLE = '未命名会话';
/** 标题压成单行：换行会打散来源行，markdown / 标签字符会破坏渲染 */
function cleanTitle(raw) {
    return raw
        .replace(/[\r\n]+/g, ' ')
        .replace(/[`*_~<>"']/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
/** 标题压成单行的展示文本：净化 + 截断，空标题返回空串（由调用方决定兜底） */
function clipTitle(raw) {
    const cleaned = cleanTitle(raw ?? '');
    const chars = [...cleaned];
    return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('')}…` : cleaned;
}
/** 来源行里的标题：净化 + 截断，空值用兜底名 */
export function sourceTitle(raw) {
    return clipTitle(raw) || UNNAMED_SESSION_TITLE;
}
/**
 * 来源行（独占一行）：`` > `#短id` · 标题 ``。
 *
 * 不带图标：图标在 §4.3 里是「哪一类信息」的标记，来源行只是署名，
 * 与状态符号 / 领域图标混在一起反而认不出哪个是结论。
 *
 * 短 id 必须包进行内代码：QQ 的 markdown 会把引用行里以 `#` 开头的内容当成
 * 标题，整行渲染成大字加粗（2026-11 实测）。加反引号后行首不再是 `#`，
 * 标题样式随之消失；`#` 仍留在可见文本里，复制出来还是 `#短id`。
 */
export function sessionSourceHeader(sessionId, title) {
    return `> \`#${shortSessionId(sessionId)}\` · ${sourceTitle(title)}`;
}
/**
 * 回复链接：把 `/to #短id ` 填进输入框（label 可按场景改，如提问用「回答」）。
 *
 * `show` 只写动作，不再跟 `#短id`：id 已经在首行署名里，重复一遍只是噪音。
 */
export function sessionReplyLink(sessionId, label = '回复') {
    return commandLink(`/to #${shortSessionId(sessionId)} `, label);
}
/** 恢复链接：把这个会话切回当前（后续消息发给它）；`show` 同样只写动作 */
export function sessionResumeLink(sessionId, label = '恢复') {
    return commandLink(`/sessions resume #${shortSessionId(sessionId)}`, label);
}
/**
 * 归档链接：把这个会话移出列表与 Web 侧栏（日志保留，`/sessions unarchive` 找回）。
 *
 * 归档走 workspaceRegistry，部署没有该服务时 `/sessions archive` 按未知子命令处理，
 * 所以调用方要先问 `workspaceRegistryAvailable()` 再决定是否拼进尾部行。
 */
export function sessionArchiveLink(sessionId, label = '归档') {
    return commandLink(`/sessions archive #${shortSessionId(sessionId)}`, label);
}
/**
 * 停止链接：中止这个后台会话正在生成的回合。
 *
 * 只在该会话确实在生成时拼进尾部行：消息发出去时已经空闲的会话没有可停的东西，
 * 给了入口也只会回一句「没有进行中的生成」。
 */
export function sessionStopLink(sessionId, label = '停止') {
    return commandLink(`/stop #${shortSessionId(sessionId)}`, label);
}
/** 尾部链接行（正文下方独占一行）：回复 + 恢复 [+ 停止] [+ 归档] */
export function sessionLinkRow(sessionId, archivable = false, stoppable = false) {
    const links = [sessionReplyLink(sessionId), sessionResumeLink(sessionId)];
    if (stoppable)
        links.push(sessionStopLink(sessionId));
    if (archivable)
        links.push(sessionArchiveLink(sessionId));
    return links.join(' · ');
}
/**
 * 会话标签：`` 「标题」 · `#短id` ``，取不到标题时只给 id。
 *
 * 用于「对一个会话做了什么」的反馈（`/to` 的发送 / 回答 / 各种失败）：
 * 只有 id 看不出是哪个会话，只有标题在重名时又对不上列表，两样都要。
 */
export function sessionTargetLabel(sessionId, title) {
    const name = clipTitle(title);
    const id = `\`#${shortSessionId(sessionId)}\``;
    return name === '' ? id : `「${name}」 · ${id}`;
}
const titleCache = new WeakMap();
export function sessionTitleOf(record) {
    let events = [];
    try {
        events = record.agent.session.snapshotEvents();
    }
    catch {
        return undefined;
    }
    const cached = titleCache.get(record);
    if (cached !== undefined && cached.count === events.length)
        return cached.title;
    // 快照只追加；长度回退（重放/替换）时从头重扫
    const incremental = cached !== undefined && cached.count < events.length;
    let start = incremental ? cached.index + 1 : 0;
    let index = incremental ? cached.index : -1;
    let title = incremental ? cached.title : undefined;
    for (let i = start; i < events.length; i++) {
        const event = events[i];
        if (event?.type !== 'session/title')
            continue;
        const value = event.data?.title;
        if (typeof value === 'string' && value.trim() !== '') {
            title = value;
            index = i;
        }
    }
    titleCache.set(record, { count: events.length, index, title });
    return title;
}
/**
 * 整段文本加来源头与尾部链接行（不切分，用于短消息 / 交付物提示）。
 */
export function decorateSessionMessage(text, sessionId, title, archivable = false, stoppable = false) {
    const body = text.trim();
    if (body === '')
        return '';
    return `${sessionSourceHeader(sessionId, title)}\n\n${body}\n\n${sessionLinkRow(sessionId, archivable, stoppable)}`;
}
//# sourceMappingURL=session-source.js.map