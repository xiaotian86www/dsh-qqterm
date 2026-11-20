/**
 * 未知指令守卫 — 拦下拼错的 `/xxx`，不再让它们当作普通提问转发给大模型
 *
 * SDK 的 slashCommand 只认已注册的命令：名字对不上时它直接 `next()`，
 * 消息会一路走到 bot.on('message')，被组装成 prompt 交给 agent。用户手滑
 * 打错一个字母，换来的是一次完整推理（花钱，还答非所问）。
 *
 * 这里在链路中途截住：直接回「没有这个指令 + 最接近的指令」，并 stop 掉
 * 本次消息。判定刻意保守——只有「前缀 + 纯 ASCII 指令名」这种明确的指令
 * 形态才会被拦，`/usr/local/bin`、`/今天天气` 这类普通文本照旧走模型。
 *
 * 位置很关键：
 * - 必须在 slashCommand 之后：命中的命令已经短路返回，这里只看漏网的；
 * - 必须在 questionAnswer 之后：待答问题的答案优先，不能被守卫吃掉。
 */
import type { Middleware, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { commandLink } from '../shared/inline.ts';
import { errorMessage } from '../shared/utils.ts';


/** 指令前缀：半角 `/` 与中文输入法下很容易打出的全角 `／` */
const PREFIXES = ['/', '／'] as const;

/** 合法指令名：字母开头，字母/数字/下划线/连字符，最长 32 */
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** 名字尾部的标点（`/model?`、`/status。` 这类手滑） */
const TRAILING_PUNCT_RE = /[?!.,;:。，、；：！？…]+$/;

/** 解析出的「疑似指令」 */
export interface CommandCandidate {
  /** 原始指令名（保留大小写与尾部标点，回显用） */
  raw: string;
  /** 归一化后的指令名（小写、去掉尾部标点） */
  name: string;
  /** 命中的前缀 */
  prefix: string;
}

/** 未知指令的回复：markdown 版带可点击按钮，纯文本版做发送失败兜底 */
export interface UnknownCommandReply {
  markdown: string;
  text: string;
}

/**
 * 把消息内容解析成疑似指令；不像指令时返回 undefined
 *
 * 只认「前缀紧跟一个 ASCII 指令名」的形态：
 * - `/help`、`/model?` → 指令
 * - `/`、`/ model`、`/usr/local/bin`、`/今天` → 普通文本
 */
export function parseCommandCandidate(content: string): CommandCandidate | undefined {
  const text = content.replace(/<@!?[^>]+>\s*/g, '').trim();
  const prefix = PREFIXES.find((p) => text.startsWith(p));
  if (prefix === undefined) return undefined;

  const rest = text.slice(prefix.length);
  // `/` 后面紧跟空白：用户在写正文，不是敲指令
  if (rest === '' || /^\s/.test(rest)) return undefined;

  const token = rest.split(/\s+/)[0] ?? '';
  const name = token.toLowerCase().replace(TRAILING_PUNCT_RE, '');
  if (!NAME_RE.test(name)) return undefined;

  return { raw: token, name, prefix };
}

/**
 * 在已注册指令里找最接近的一个（编辑距离）
 *
 * 阈值随名字长度收紧：`/stp` 这种 3 字母只容 1 个编辑，
 * `/sesions` 这种长名字容 2 个，避免把毫不相干的词硬凑成建议。
 */
export function suggestCommand(name: string, candidates: readonly string[]): string | undefined {
  const target = name.toLowerCase();
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = levenshtein(target, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  if (best === undefined) return undefined;
  const threshold = target.length <= 4 ? 1 : 2;
  return bestDistance <= threshold ? best : undefined;
}

/** 拼装拒绝文案（带建议时给可点击指令按钮） */
export function buildUnknownCommandReply(
  candidate: CommandCandidate,
  suggestion: string | undefined,
): UnknownCommandReply {
  const typed = `${candidate.prefix}${candidate.raw}`;
  const markdown = [`⚠️ 没有 \`${typed}\` 这个指令${candidate.prefix === '/' ? '' : '（前缀要半角 `/`）'}。`];
  const text = [`⚠️ 没有 ${typed} 这个指令${candidate.prefix === '/' ? '' : '（前缀要半角 /）'}。`];

  if (suggestion !== undefined) {
    markdown.push(`你想用的是不是 ${commandLink(`/${suggestion}`, `/${suggestion}`)}？`);
    text.push(`你想用的是不是 /${suggestion}？`);
  } else {
    markdown.push('如果只是普通文本，去掉开头的 `/` 再发；全部指令见 `/help`。');
    text.push('如果只是普通文本，去掉开头的 / 再发；全部指令见 /help。');
  }

  return { markdown: markdown.join('\n'), text: text.join('\n') };
}

/** 展平命令列表里的名字与别名（不含前缀） */
export function collectCommandNames(commands: ReadonlyArray<{ name: string | string[] }>): string[] {
  const names: string[] = [];
  for (const command of commands) {
    const list = Array.isArray(command.name) ? command.name : [command.name];
    for (const name of list) names.push(name);
  }
  return names;
}

/**
 * 发回复用的函数：目标用 SDK 的 ReplyTarget（scope 是 'c2c' | 'group'），
 * bootstrap 传 sender.text 时把 scope 收窄成插件自己的 'c2c'。
 */
export type UnknownCommandSend = (target: MiddlewareContext['replyTarget'], body: string) => Promise<void>;

export interface UnknownCommandGuardOptions {
  /** 已注册的指令名（含别名，不含前缀） */
  commandNames: readonly string[];
  /** 发回复用的函数（bootstrap 注入 sender.text：分片 + 网络类重试） */
  sendText: UnknownCommandSend;
}

/**
 * 未知指令守卫中间件
 *
 * 命中已注册名字时不拦截（正常应被 slashCommand 提前短路，这里只做兜底）；
 * 回复发不出去时退回 `next()`，不让用户的消息凭空消失。
 */
export function rejectUnknownCommands(options: UnknownCommandGuardOptions): Middleware {
  const registered = new Set(options.commandNames.map((name) => name.toLowerCase()));

  return async (ctx, next) => {
    const content = (ctx.message.content ?? '').trim();
    if (content === '') {
      await next();
      return;
    }

    const candidate = parseCommandCandidate(content);
    if (candidate === undefined) {
      await next();
      return;
    }

    // 已注册名字（大小写不敏感）不归守卫管
    if (registered.has(candidate.raw.toLowerCase())) {
      await next();
      return;
    }

    const suggestion = suggestCommand(candidate.name, options.commandNames);
    const reply = buildUnknownCommandReply(candidate, suggestion);
    ctx.log.debug?.(`[qqterm] unknown command: ${candidate.prefix}${candidate.raw}`);

    if (!(await sendReply(ctx, reply, options.sendText))) {
      // markdown / 纯文本都发不出去：退回正常转发，至少别静默丢消息
      await next();
      return;
    }

    ctx.stop(`command:unknown:${candidate.name}`);
  };
}

/** 先走 markdown（带按钮），失败再退纯文本；都失败返回 false */
async function sendReply(
  ctx: MiddlewareContext,
  reply: UnknownCommandReply,
  sendText: UnknownCommandSend,
): Promise<boolean> {
  try {
    await sendText(ctx.replyTarget, reply.markdown);
    return true;
  } catch (err) {
    ctx.log.warn?.(`[qqterm] unknown-command markdown reply failed: ${errorMessage(err)}`);
  }

  try {
    await ctx.bot.sendText(ctx.replyTarget, reply.text);
    return true;
  } catch (err) {
    ctx.log.error(`[qqterm] unknown-command text reply failed: ${errorMessage(err)}`);
    return false;
  }
}

/** 编辑距离（滚动两行，长名字也只占 O(n) 内存） */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

