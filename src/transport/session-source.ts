/**
 * 非当前会话消息的来源标注与快捷回复入口。
 *
 * 多个已获取会话的输出都回同一个 QQ 聊天：正文前标会话（短 id + 标题），
 * 正文后空一行给「回复」「恢复」「停止」「归档」四个行内指令链接。来源行
 * 独占一行、与正文之间空一行——不能把标记直接拼在正文前面，否则会和
 * markdown 标题、列表、代码块粘成一段。
 *
 * `回复` 把 `/to #短id ` 填进输入框，`恢复` 直接切走当前指针，`停止` 中止这个
 * 后台会话正在生成的回合，`归档` 把这个后台会话从列表里收走。四者独占一行、
 * 正文之后空一行，位置固定好找；停止只在会话确实在生成时出现，归档只在部署有
 * workspaceRegistry 时出现（没有对应能力时不给点了没用的入口）。
 */
import type { SessionEventLike, SessionRecord } from '../session/index.ts';
import { shortSessionId } from '../shared/utils.ts';
import { commandLink } from '../shared/inline.ts';

/** 标题在来源行里的展示上限（日志标题可能很长，来源行要保持一行） */
const TITLE_MAX = 20;

/** 取不到标题时的兜底名，避免来源行只剩一个 id */
export const UNNAMED_SESSION_TITLE = '未命名会话';

/** 标题压成单行：换行会打散来源行，markdown / 标签字符会破坏渲染 */
function cleanTitle(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/[`*_~<>"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 标题压成单行的展示文本：净化 + 截断，空标题返回空串（由调用方决定兜底） */
function clipTitle(raw?: string): string {
  const cleaned = cleanTitle(raw ?? '');
  const chars = [...cleaned];
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('')}…` : cleaned;
}

/** 来源行里的标题：净化 + 截断，空值用兜底名 */
export function sourceTitle(raw?: string): string {
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
export function sessionSourceHeader(sessionId: string, title?: string): string {
  return `> \`#${shortSessionId(sessionId)}\` · ${sourceTitle(title)}`;
}

/**
 * 回复链接：把 `/to #短id ` 填进输入框（label 可按场景改，如提问用「回答」）。
 *
 * `show` 只写动作，不再跟 `#短id`：id 已经在首行署名里，重复一遍只是噪音。
 */
export function sessionReplyLink(sessionId: string, label = '回复'): string {
  return commandLink(`/to #${shortSessionId(sessionId)} `, label);
}

/** 恢复链接：把这个会话切回当前（后续消息发给它）；`show` 同样只写动作 */
export function sessionResumeLink(sessionId: string, label = '恢复'): string {
  return commandLink(`/sessions resume #${shortSessionId(sessionId)}`, label);
}

/**
 * 归档链接：把这个会话移出列表与 Web 侧栏（日志保留，`/sessions unarchive` 找回）。
 *
 * 归档走 workspaceRegistry，部署没有该服务时 `/sessions archive` 按未知子命令处理，
 * 所以调用方要先问 `workspaceRegistryAvailable()` 再决定是否拼进尾部行。
 */
export function sessionArchiveLink(sessionId: string, label = '归档'): string {
  return commandLink(`/sessions archive #${shortSessionId(sessionId)}`, label);
}

/**
 * 停止链接：中止这个后台会话正在生成的回合。
 *
 * 只在该会话确实在生成时拼进尾部行：消息发出去时已经空闲的会话没有可停的东西，
 * 给了入口也只会回一句「没有进行中的生成」。
 */
export function sessionStopLink(sessionId: string, label = '停止'): string {
  return `<qqbot-cmd-input text="/stop #${shortSessionId(sessionId)}" show="${label}"/>`;
}

/** 尾部链接行（正文下方独占一行）：回复 + 恢复 [+ 停止] [+ 归档] */
export function sessionLinkRow(sessionId: string, archivable = false, stoppable = false): string {
  const links = [sessionReplyLink(sessionId), sessionResumeLink(sessionId)];
  if (stoppable) links.push(sessionStopLink(sessionId));
  if (archivable) links.push(sessionArchiveLink(sessionId));
  return links.join(' · ');
}

/**
 * 会话标签：`` 「标题」 · `#短id` ``，取不到标题时只给 id。
 *
 * 用于「对一个会话做了什么」的反馈（`/to` 的发送 / 回答 / 各种失败）：
 * 只有 id 看不出是哪个会话，只有标题在重名时又对不上列表，两样都要。
 */
export function sessionTargetLabel(sessionId: string, title?: string): string {
  const name = clipTitle(title);
  const id = `\`#${shortSessionId(sessionId)}\``;
  return name === '' ? id : `「${name}」 · ${id}`;
}

/**
 * 会话标题：优先取日志里最新一条 `session/title` 事件（内存快照，不读盘）。
 *
 * 宿主的标题生成是异步的，还没有标题时返回 undefined；调用方用兜底名。
 * 缓存记录「已扫到哪一条」：每条消息只补扫新增事件，不重复遍历长日志。
 */
interface TitleCache {
  count: number;
  /** 最近一条标题事件的下标；-1 表示还没找到 */
  index: number;
  title?: string;
}

const titleCache = new WeakMap<SessionRecord, TitleCache>();

export function sessionTitleOf(record: SessionRecord): string | undefined {
  let events: readonly SessionEventLike[] = [];
  try {
    events = record.agent.session.snapshotEvents();
  } catch {
    return undefined;
  }

  const cached = titleCache.get(record);
  if (cached !== undefined && cached.count === events.length) return cached.title;

  // 快照只追加；长度回退（重放/替换）时从头重扫
  const incremental = cached !== undefined && cached.count < events.length;
  let start = incremental ? cached.index + 1 : 0;
  let index = incremental ? cached.index : -1;
  let title = incremental ? cached.title : undefined;

  for (let i = start; i < events.length; i++) {
    const event = events[i];
    if (event?.type !== 'session/title') continue;
    const value = (event.data as { title?: unknown } | undefined)?.title;
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
export function decorateSessionMessage(
  text: string,
  sessionId: string,
  title?: string,
  archivable = false,
  stoppable = false,
): string {
  const body = text.trim();
  if (body === '') return '';
  return `${sessionSourceHeader(sessionId, title)}\n\n${body}\n\n${sessionLinkRow(sessionId, archivable, stoppable)}`;
}

