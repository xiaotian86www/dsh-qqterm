/**
 * 命令参数切词与解析：空格分隔、成对引号包住一个值、选项按声明进具名结果，
 * 写错抛 ArgError（message 就是回执），命令不再自己拼字符串。
 */
import { describe, expect, it } from 'vitest';
import {
  ArgError,
  looksLikeParam,
  optionValue,
  parseArgs,
  parseRest,
  quoteArg,
  tokenize,
} from '../../src/commands/args.ts';
import type { CommandSpec } from '../../src/commands/args.ts';

type DemoOptions = {
  dir?: string;
  worktree?: boolean;
  background?: boolean;
  'allow-builds'?: string[];
};

const spec: CommandSpec = {
  command: 'demo',
  options: [
    { name: 'dir', alias: 'd', kind: 'value' },
    { name: 'worktree', alias: 'w' },
    { name: 'background', alias: 'b' },
    { name: 'allow-builds', kind: 'list' },
  ],
  terminator: 'words',
};

/** 取写错时的回执；没写错返回 undefined */
function errorOf(raw: string, commandSpec: CommandSpec = spec): string | undefined {
  try {
    parseArgs(raw, commandSpec);
    return undefined;
  } catch (error) {
    if (error instanceof ArgError) return error.message;
    throw error;
  }
}

function optionsOf(raw: string, commandSpec: CommandSpec = spec): DemoOptions {
  return parseArgs(raw, commandSpec).options as DemoOptions;
}

describe('tokenize', () => {
  it('按空格切词，连续空白不产生空词', () => {
    expect(tokenize('  a   b\tc ').tokens).toEqual([
      { value: 'a', quoted: false, offset: 2 },
      { value: 'b', quoted: false, offset: 6 },
      { value: 'c', quoted: false, offset: 8 },
    ]);
  });

  it('引号包住的空白留在同一个词里，引号本身去掉', () => {
    const { tokens } = tokenize('install "dsh  x" --allow-builds=a');
    expect(tokens).toEqual([
      { value: 'install', quoted: false, offset: 0 },
      { value: 'dsh  x', quoted: true, offset: 8 },
      { value: '--allow-builds=a', quoted: false, offset: 17 },
    ]);
  });

  it('双引号与单引号等价', () => {
    expect(tokenize("a 'b c' d").tokens.map((token) => token.value)).toEqual(['a', 'b c', 'd']);
  });

  it('引号没闭合只报错，尽量保留已切出来的词', () => {
    expect(tokenize('a "b c')).toEqual({ tokens: [{ value: 'a', quoted: false, offset: 0 }], error: 'quote-open' });
  });

  it('空串与纯空白没有词', () => {
    expect(tokenize('   ').tokens).toEqual([]);
  });
});

describe('looksLikeParam', () => {
  it('短横线开头的非空词是参数', () => {
    expect(looksLikeParam({ value: '--dir', quoted: false })).toBe(true);
    expect(looksLikeParam({ value: '-w', quoted: false })).toBe(true);
  });

  it('单独的 -、普通词、引号包着的词都不是参数', () => {
    expect(looksLikeParam({ value: '-', quoted: false })).toBe(false);
    expect(looksLikeParam({ value: 'dir', quoted: false })).toBe(false);
    expect(looksLikeParam({ value: '-w', quoted: true })).toBe(false);
  });
});

describe('parseRest', () => {
  it('整行都是值：中间的空格原样保留，不切词', () => {
    expect(parseRest('  D:\\My Repo\\src  ')).toBe('D:\\My Repo\\src');
  });

  it('两端成对的引号去掉', () => {
    expect(parseRest('"我的 标题"')).toBe('我的 标题');
    expect(parseRest("'a b'")).toBe('a b');
  });

  it('没有成对引号时原样（只去首尾空白）', () => {
    expect(parseRest('"没闭合')).toBe('"没闭合');
    expect(parseRest('"a" b')).toBe('"a" b');
    expect(parseRest('')).toBe('');
  });
});

describe('parseArgs', () => {
  it('开关进具名 options，其余是位置参数', () => {
    const parsed = parseArgs('修一下 -w 再跑', spec);
    expect(parsed.words).toEqual(['修一下', '再跑']);
    expect(optionValue<boolean>(parsed, 'worktree')).toBe(true);
    expect(optionValue<boolean>(parsed, 'background')).toBe(false);
    expect(optionValue<string>(parsed, 'dir')).toBeUndefined();
  });

  it('开关可以合写，顺序随意', () => {
    for (const raw of ['-wb', '-bw']) {
      const parsed = parseArgs(raw, spec);
      expect(optionValue<boolean>(parsed, 'worktree')).toBe(true);
      expect(optionValue<boolean>(parsed, 'background')).toBe(true);
    }
  });

  it('合写里带值的 `-d` 只能收尾', () => {
    const parsed = parseArgs('-wbd repo', spec);
    expect(optionValue<boolean>(parsed, 'worktree')).toBe(true);
    expect(optionValue<boolean>(parsed, 'background')).toBe(true);
    expect(optionValue<string>(parsed, 'dir')).toBe('repo');
    expect(errorOf('-dw repo')).toBe('⚠️ 未知参数: -dw · 用法: /help demo');
  });

  it('合写里有认不出的短名时整词回未知参数', () => {
    expect(errorOf('-wx')).toBe('⚠️ 未知参数: -wx · 用法: /help demo');
  });

  it('`--` 之后与引号里的合写不拆', () => {
    expect(parseArgs('-- -wb', spec).words).toEqual(['-wb']);
    const quoted = parseArgs('看下 "-wb"', spec);
    expect(quoted.words).toEqual(['看下', '-wb']);
    expect(optionValue<boolean>(quoted, 'worktree')).toBe(false);
  });

  it('带值参数 `--dir 值` 与 `--dir=值` 等价，重复给取最后一次', () => {
    expect(optionValue<string>(parseArgs('--dir repo', spec), 'dir')).toBe('repo');
    expect(optionValue<string>(parseArgs('--dir=repo', spec), 'dir')).toBe('repo');
    expect(optionValue<string>(parseArgs('-d a --dir b', spec), 'dir')).toBe('b');
  });

  it('列表参数按逗号拆开、多次出现累积', () => {
    expect(optionsOf('--allow-builds a,b --allow-builds=c')['allow-builds']).toEqual(['a', 'b', 'c']);
  });

  it('缺值回声明里的整句', () => {
    const strict: CommandSpec = {
      command: 'demo',
      options: [{ name: 'dir', alias: 'd', kind: 'value', missing: '⚠️ --dir 后要跟工作区' }],
    };
    expect(errorOf('--dir', strict)).toBe('⚠️ --dir 后要跟工作区');
    expect(errorOf('--dir=', strict)).toBe('⚠️ --dir 后要跟工作区');
    expect(errorOf('--dir -w', strict)).toBe('⚠️ --dir 后要跟工作区');
  });

  it('没声明 missing 时用通用文案', () => {
    expect(errorOf('--dir')).toBe('⚠️ --dir 后要跟值 · 用法: /help demo');
  });

  it('认不出的参数与开关带值都回未知参数', () => {
    expect(errorOf('--nope x')).toBe('⚠️ 未知参数: --nope · 用法: /help demo');
    expect(errorOf('--worktree=1')).toBe('⚠️ 未知参数: --worktree=1 · 用法: /help demo');
  });

  it('引号包着的参数名是位置参数', () => {
    const parsed = parseArgs('看下 "-w" 这个参数', spec);
    expect(parsed.words).toEqual(['看下', '-w', '这个参数']);
    expect(optionValue<boolean>(parsed, 'worktree')).toBe(false);
  });

  it('`--` 之后的词一律是位置参数', () => {
    const parsed = parseArgs('--dir repo -- -w --dir', spec);
    expect(optionValue<string>(parsed, 'dir')).toBe('repo');
    expect(parsed.words).toEqual(['-w', '--dir']);
  });

  it('没写的选项：开关是 false，其余是 undefined', () => {
    const parsed = parseArgs('', spec);
    expect(parsed.options).toEqual({ dir: undefined, worktree: false, background: false, 'allow-builds': undefined });
  });

  it('声明里的 default 在没写时生效', () => {
    const custom: CommandSpec = {
      command: 'demo',
      options: [
        { name: 'count', kind: 'value', default: 3 },
        { name: 'mode', kind: 'value', default: 'fast' },
        { name: 'tags', kind: 'list', default: ['x'] },
        { name: 'quiet', default: true },
      ],
    };
    expect(parseArgs('', custom).options).toEqual({ count: 3, mode: 'fast', tags: ['x'], quiet: true });
  });

  it('convert 校验与换算：写对给转换值，写错抛的 message 原样回用户', () => {
    const timed: CommandSpec = {
      command: 'run',
      options: [{
        name: 'timeout',
        kind: 'value',
        convert: (raw) => {
          if (!/^\d+$/.test(raw)) throw new ArgError('⚠️ 超时秒数要在 1–600 之间 · 用法: /help run');
          return Number(raw) * 1_000;
        },
      }],
    };
    expect(optionValue<number>(parseArgs('--timeout 30', timed), 'timeout')).toBe(30_000);
    expect(errorOf('--timeout abc', timed)).toBe('⚠️ 超时秒数要在 1–600 之间 · 用法: /help run');
  });

  it('rest 模式：`--` 之后整段原样进 rest，不再切词', () => {
    const parsed = parseArgs('--dir repo -- 提 示 "x"', { ...spec, terminator: 'rest' });
    expect(optionValue<string>(parsed, 'dir')).toBe('repo');
    expect(parsed.words).toEqual([]);
    expect(parsed.rest).toBe('提 示 "x"');
  });

  it('rest 模式：`--` 之前的位置参数照旧切出来', () => {
    const parsed = parseArgs('目标 -- 正 文', { ...spec, terminator: 'rest' });
    expect(parsed.words).toEqual(['目标']);
    expect(parsed.rest).toBe('正 文');
  });

  it('rest 模式：没写 `--` 时没有 rest，`--` 后为空时 rest 是空串', () => {
    expect(parseArgs('--dir repo 提示', { ...spec, terminator: 'rest' }).rest).toBeUndefined();
    expect(parseArgs('--dir repo --', { ...spec, terminator: 'rest' }).rest).toBe('');
  });

  it('引号没闭合时回命令名对应的用法', () => {
    expect(errorOf('--dir "D:\\My Repo')).toBe('⚠️ 引号没有闭合 · 用法: /help demo');
  });
});

describe('quoteArg', () => {
  const newSpec: CommandSpec = {
    command: 'new',
    options: [{ name: 'dir', alias: 'd', kind: 'value' }],
  };

  it('没有空白与引号的值原样返回', () => {
    expect(quoteArg('/repo')).toBe('/repo');
  });

  it('带空白的值用成对双引号包住，放回命令里仍是一个词', () => {
    const quoted = quoteArg('D:\\My Repo');
    expect(quoted).toBe('"D:\\My Repo"');
    expect(optionValue<string>(parseArgs(`--dir ${quoted}`, newSpec), 'dir')).toBe('D:\\My Repo');
  });

  it('值里有双引号时改用单引号', () => {
    expect(quoteArg(`a"b c`)).toBe(`'a"b c'`);
  });

  it('两种引号都有时不返回，调用方降级成纯文本', () => {
    expect(quoteArg(`a"b'c`)).toBeUndefined();
  });

  it('没有空白但含引号的词也要包住，否则切词器会把它当引号起手', () => {
    expect(quoteArg(`a"b`)).toBe(`'a"b'`);
  });
});
