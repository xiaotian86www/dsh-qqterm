/**
 * 命令参数切词：与命令行一致的约定俗成规则
 *
 * 空格是分隔符；一个值里要留空格就用成对的 `"` 或 `'` 包起来，引号本身不进值。
 * 引号没闭合算用户写错，命令回用法提示，不猜着补齐。
 *
 * 两类命令共用这一个模块：
 * - 带参数的命令（/new、/sessions、/plugins）走 parseArgs：按声明认 `--dir` 这类
 *   参数，剩下的词是位置参数；认不出的参数只回 error，不猜。
 * - 整行就是一个值的命令（路径、标题、提示词）走 parseRest：两端成对的引号
 *   去掉，其余原样，写不写引号都对。
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

/** 一条命令参数：`--dir` / `-d` 这种 */
export interface FlagSpec {
  /** 长名，不带 `--`（`--dir` → `dir`） */
  name: string;
  /** 短名，不带 `-`（`-d` → `d`） */
  alias?: string;
  /** 要一个值（`--dir 值` / `--dir=值`）；缺省是开关 */
  value?: boolean;
  /** 逗号分隔、可重复出现，结果是列表（`--allow-builds=a,b`） */
  list?: boolean;
  /** 缺值时回给用户的整句；缺省用通用文案 */
  missing?: string;
}

/** 解析规则：`command` 只用于回执里的 `/help <命令>` */
export interface ParseSpec {
  /** 命令名（不带斜杠），拼进「用法: /help x」 */
  command: string;
  /** 认识的参数；其余 `-` 开头的词一律回未知参数 */
  flags?: readonly FlagSpec[];
  /** 认 `--`：之后的词一律当位置参数（提示词里要写 `-w` 时用） */
  terminator?: boolean;
}

/** 解析结果 */
export interface ParsedArgs {
  /** 位置参数，按出现顺序，引号已去掉 */
  words: string[];
  /** 出现过的开关（没声明 value 的参数） */
  flags: Set<string>;
  /** 带值参数的值；重复出现取最后一次 */
  values: Map<string, string>;
  /** 列表参数的值，按出现顺序累积 */
  lists: Map<string, string[]>;
  /** 用户写错时的回执：有值就直接回它，别动状态 */
  error?: string;
}

/**
 * 按声明解析一条命令的参数。
 *
 * 位置参数进 `words`，开关进 `flags`，带值的进 `values`，`list` 参数进 `lists`。
 * 认不出的参数、缺值、引号没闭合都只回 `error`，让调用方在动状态之前回绝；已解析
 * 出的部分照常给出（回执只看 error，不影响判断）。
 */
export function parseArgs(raw: string, spec: ParseSpec): ParsedArgs {
  const words: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const usage = ` · 用法: /help ${spec.command}`;
  const fail = (message: string): ParsedArgs => ({ words, flags, values, lists, error: message + usage });
  const missingValue = (flag: FlagSpec, written: string): ParsedArgs =>
    flag.missing === undefined
      ? fail(`⚠️ ${written} 后要跟值`)
      : { words, flags, values, lists, error: flag.missing };
  const { tokens, error } = tokenize(raw);
  if (error !== undefined) {
    return { words: [], flags: new Set(), values: new Map(), lists: new Map(), error: `${QUOTE_OPEN_TEXT}${usage}` };
  }
  const known = spec.flags ?? [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as RawToken;
    // 引号包着的词、不带 `-` 的词都是位置参数
    if (token.quoted || !looksLikeParam(token)) {
      if (token.value !== '') words.push(token.value);
      continue;
    }
    // `--` 终止参数识别：提示词里要写字面量 `-w` 时这样写
    if (spec.terminator === true && token.value === '--') {
      for (const rest of tokens.slice(i + 1)) {
        if (rest.value !== '') words.push(rest.value);
      }
      break;
    }
    const eq = token.value.indexOf('=');
    const name = (eq === -1 ? token.value : token.value.slice(0, eq)).replace(/^--?/, '');
    const flag = known.find((item) => item.name === name || item.alias === name);
    if (flag === undefined) return fail(`⚠️ 未知参数: ${token.value}`);
    const inline = eq === -1 ? undefined : token.value.slice(eq + 1);
    if (flag.value !== true) {
      // 开关不接值：`--worktree=1` 是写错，不猜成开着
      if (inline !== undefined) return fail(`⚠️ 未知参数: ${token.value}`);
      flags.add(flag.name);
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = tokens[i + 1];
      // 值不能缺，也不能紧跟另一个参数（`--dir -w` 是写错，不把 -w 当路径）
      if (next === undefined || next.value === '' || looksLikeParam(next)) {
        return missingValue(flag, token.value);
      }
      value = next.value;
      i += 1;
    }
    if (value === '') return missingValue(flag, token.value);
    if (flag.list !== true) {
      values.set(flag.name, value);
      continue;
    }
    const names = value.split(',').map((item) => item.trim()).filter((item) => item !== '');
    if (names.length === 0) return missingValue(flag, token.value);
    const collected = lists.get(flag.name);
    if (collected === undefined) lists.set(flag.name, names);
    else collected.push(...names);
  }
  return { words, flags, values, lists };
}
