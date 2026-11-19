/**
 * 命令参数切词：与命令行一致的约定俗成规则
 *
 * 空格是分隔符；一个值里要留空格就用成对的 `"` 或 `'` 包起来，引号本身不进值。
 * 引号没闭合算用户写错，命令回用法提示，不猜着补齐。
 *
 * 不用切词的命令（整行就是一个值：路径、标题、提示词）走 parseRest：两端成对的
 * 引号去掉，其余原样，写不写引号都对。
 */

/** 引号没有闭合 */
export type TokenizeError = 'quote-open';

/** 回执里给用户看的原文；后面接 ` · 用法: /help <命令>` */
export const QUOTE_OPEN_TEXT = '⚠️ 引号没有闭合';

/** 切出来的一个词；`quoted` 表示它整个被引号包着，不参与参数识别 */
export interface RawToken {
  value: string;
  quoted: boolean;
}

/**
 * 按空格切词：成对 `"` / `'` 里的空白留在同一个词里，引号本身去掉。整个被引号
 * 包着的词（`"-w"`）不当参数，这样提示词里的 `-w` 能原样发出去。
 */
export function tokenize(raw: string): { tokens: RawToken[]; error?: TokenizeError } {
  const tokens: RawToken[] = [];
  let current = '';
  let quote: string | undefined;
  let quoted = false;
  let started = false;
  for (const ch of raw) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (!started) quoted = true;
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push({ value: current, quoted });
        current = '';
        quoted = false;
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote !== undefined) return { tokens, error: 'quote-open' };
  if (started) tokens.push({ value: current, quoted });
  return { tokens };
}

/** 参数样子的词：`-` 开头的非空词，被引号包着的除外 */
export function looksLikeParam(token: RawToken): boolean {
  return !token.quoted && token.value.startsWith('-') && token.value !== '-';
}

/**
 * 整段当一个值：两端成对的引号去掉，其余原样（保留中间的空格与换行）。
 *
 * 给「整行都是值」的命令用（`/ls <路径>`、`/rename <标题>`、`/new` 的提示词）：没有
 * 第二个位置参数，切词只会白白吃掉空格，引号反而成了值的一部分。
 */
export function parseRest(raw: string): string {
  const text = raw.trim();
  const quote = text[0];
  if ((quote === '"' || quote === "'") && text.length >= 2 && text.endsWith(quote)) {
    return text.slice(1, -1);
  }
  return text;
}
