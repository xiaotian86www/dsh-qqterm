/**
 * 命令参数切词：与命令行一致的约定俗成规则
 *
 * 空格是分隔符；一个值里要留空格就用成对的 `"` 或 `'` 包起来，引号本身不进值。
 * 引号没闭合算用户写错，命令回用法提示，不猜着补齐。
 *
 * 开关可以合写：`-w -b` 与 `-wb`、`-bw` 等价；带值的短参数只能收尾（`-wd <值>`）。
 *
 * 两类命令共用这一个模块：
 * - 带参数的命令（/new、/sessions、/plugins、/run、/to）走 parseArgs：按声明认
 *   `--dir` 这类参数，剩下的词是位置参数；认不出的参数只回 error，不猜。
 * - 整行就是一个值的命令（路径、标题）走 parseRest：两端成对的引号去掉，其余
 *   原样，写不写引号都对。
 *
 * 切出来的词就是参数的最终形态，拆完不再拼回字符串：一条命令要几个位置参数、
 * 多给一个算什么错、带空格的一个值用引号还是写在 `--` 之后，都由各命令自己判
 * （`/run` 只收一条命令，`/new` 只收一段提示词，`/to` 只收一段正文）。
 */

/** 引号没有闭合 */
export type TokenizeError = 'quote-open';

/** 回执里给用户看的原文；后面接 ` · 用法: /help <命令>` */
export const QUOTE_OPEN_TEXT = '⚠️ 引号没有闭合';

/** 切出来的一个词；`quoted` 表示它整个被引号包着，不参与参数识别 */
export interface RawToken {
  value: string;
  quoted: boolean;
  /** 词在原文里的起点（引号包着的词从引号算）：`--` 之后要取原文时用 */
  offset: number;
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
  let offset = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw[index] as string;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (!started) {
        quoted = true;
        offset = index;
      }
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push({ value: current, quoted, offset });
        current = '';
        quoted = false;
        started = false;
      }
      continue;
    }
    if (!started) offset = index;
    current += ch;
    started = true;
  }
  if (quote !== undefined) return { tokens, error: 'quote-open' };
  if (started) tokens.push({ value: current, quoted, offset });
  return { tokens };
}

/** 参数样子的词：`-` 开头的非空词，被引号包着的除外 */
export function looksLikeParam(token: { value: string; quoted: boolean }): boolean {
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

/**
 * 把一个值放回命令里：含空白或引号时用成对引号包住，引号本身不进值。
 *
 * 可点击命令的 `text` 必须真能执行——路径里的空格原样拼进去会被切词器切成两个
 * 词，`/new --dir D:\\My Dir` 就成了「目录 D:\\My」加一句提示词。值里同时出现
 * `"` 与 `'` 时没法在这一层表达（切词器没有转义），返回 undefined，调用方降级
 * 成纯文本，不给一条点了会出错的命令。
 */
export function quoteArg(value: string): string | undefined {
  if (!/[\s"']/.test(value)) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return undefined;
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
  /**
   * 认 `--`，两种收尾：
   * - `words`：之后的词仍按位置参数切（`/run` 用：一次只收一条命令，`--` 只隔开
   *   `-` 开头的命令）
   * - `rest`：之后的原文整段进 `rest`，不再切词（正文、提示词、标题里要保住空格与
   *   引号时用）
   */
  terminator?: 'words' | 'rest';
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
  /** `terminator: 'rest'` 且写了 `--` 时：之后的原文（可能为空串） */
  rest?: string;
  /** 用户写错时的回执：有值就直接回它，别动状态 */
  error?: string;
}

/**
 * 合写的短参数：`-wb` 拆成 `-w`、`-b`。
 *
 * 只拆以单个 `-` 开头、不含 `=`、且整体不是已知参数名的词；每个字符都必须是
 * 已知短名。带值的短名只能收尾（`-wd <值>`），因为后面的字符没位置再取值。
 * `--` 之后的词原样保留，那是提示词。
 */
function expandShortFlags(tokens: readonly RawToken[], known: readonly FlagSpec[], terminator: boolean): RawToken[] {
  const expanded: RawToken[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as RawToken;
    if (terminator && !token.quoted && token.value === '--') {
      expanded.push(...tokens.slice(i));
      break;
    }
    if (!isShortCluster(token, known)) {
      expanded.push(token);
      continue;
    }
    for (const letter of token.value.slice(1)) {
      expanded.push({ value: `-${letter}`, quoted: false, offset: token.offset });
    }
  }
  return expanded;
}

/** `-wb` 这种词能不能按字符拆成已知短名 */
function isShortCluster(token: RawToken, known: readonly FlagSpec[]): boolean {
  if (token.quoted) return false;
  const value = token.value;
  if (!value.startsWith('-') || value.startsWith('--') || value.length < 3) return false;
  if (value.includes('=')) return false;
  const name = value.slice(1);
  // 整体就是一个已知名字（含 `-dir` 这种单横线长名）时不拆
  if (known.some((item) => item.name === name || item.alias === name)) return false;
  for (let i = 1; i < value.length; i += 1) {
    const flag = known.find((item) => item.alias === value[i]);
    if (flag === undefined) return false;
    if (flag.value === true && i !== value.length - 1) return false;
  }
  return true;
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
  const queue = expandShortFlags(tokens, known, spec.terminator !== undefined);
  let rest: string | undefined;
  for (let i = 0; i < queue.length; i += 1) {
    const token = queue[i] as RawToken;
    // 引号包着的词、不带 `-` 的词都是位置参数
    if (token.quoted || !looksLikeParam(token)) {
      if (token.value === '') continue;
      words.push(token.value);
      continue;
    }
    // `--` 终止参数识别：之后的词按声明收成位置参数，或整段原文进 rest
    if (spec.terminator !== undefined && token.value === '--') {
      if (spec.terminator === 'rest') {
        rest = raw.slice(token.offset + 2).trimStart();
        break;
      }
      for (const remaining of queue.slice(i + 1)) {
        if (remaining.value !== '') words.push(remaining.value);
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
      const next = queue[i + 1];
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
  return rest === undefined ? { words, flags, values, lists } : { words, flags, values, lists, rest };
}
