/**
 * 命令参数切词的共用规则：空格分隔、成对引号包住一个值、\`--\` 与参数识别交给各命令
 */
import { describe, expect, it } from 'vitest';
import { looksLikeParam, parseArgs, parseRest, tokenize } from '../../src/commands/args.ts';

describe('tokenize', () => {
  it('按空格切词，连续空白不产生空词', () => {
    expect(tokenize('  a   b\tc ').tokens).toEqual([
      { value: 'a', quoted: false },
      { value: 'b', quoted: false },
      { value: 'c', quoted: false },
    ]);
  });

  it('引号包住的空白留在同一个词里，引号本身去掉', () => {
    const { tokens } = tokenize('install "dsh  x" --allow-builds=a');
    expect(tokens).toEqual([
      { value: 'install', quoted: false },
      { value: 'dsh  x', quoted: true },
      { value: '--allow-builds=a', quoted: false },
    ]);
  });

  it('双引号与单引号等价', () => {
    expect(tokenize("a 'b c' d").tokens.map((token) => token.value)).toEqual(['a', 'b c', 'd']);
  });

  it('引号没闭合只报错，尽量保留已切出来的词', () => {
    expect(tokenize('a "b c')).toEqual({ tokens: [{ value: 'a', quoted: false }], error: 'quote-open' });
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
  const spec = {
    command: 'demo',
    flags: [
      { name: 'dir', alias: 'd', value: true },
      { name: 'worktree', alias: 'w' },
      { name: 'allow-builds', value: true, list: true },
    ],
    terminator: true,
  };

  it('开关进 flags，其余是位置参数', () => {
    const parsed = parseArgs('修一下 -w 再跑', spec);
    expect(parsed.words).toEqual(['修一下', '再跑']);
    expect(parsed.flags.has('worktree')).toBe(true);
    expect(parsed.error).toBeUndefined();
  });

  it('带值参数 `--dir 值` 与 `--dir=值` 等价，重复给取最后一次', () => {
    expect(parseArgs('--dir repo', spec).values.get('dir')).toBe('repo');
    expect(parseArgs('--dir=repo', spec).values.get('dir')).toBe('repo');
    expect(parseArgs('-d a --dir b', spec).values.get('dir')).toBe('b');
  });

  it('列表参数按逗号拆开、多次出现累积', () => {
    const parsed = parseArgs('--allow-builds a,b --allow-builds=c', spec);
    expect(parsed.lists.get('allow-builds')).toEqual(['a', 'b', 'c']);
  });

  it('缺值回声明里的整句', () => {
    const strict = {
      command: 'demo',
      flags: [{ name: 'dir', alias: 'd', value: true, missing: '⚠️ --dir 后要跟工作区' }],
    };
    expect(parseArgs('--dir', strict).error).toBe('⚠️ --dir 后要跟工作区');
    expect(parseArgs('--dir=', strict).error).toBe('⚠️ --dir 后要跟工作区');
    expect(parseArgs('--dir -w', strict).error).toBe('⚠️ --dir 后要跟工作区');
  });

  it('没声明 missing 时用通用文案', () => {
    expect(parseArgs('--dir', spec).error).toBe('⚠️ --dir 后要跟值 · 用法: /help demo');
  });

  it('认不出的参数与开关带值都回未知参数', () => {
    expect(parseArgs('--nope x', spec).error).toBe('⚠️ 未知参数: --nope · 用法: /help demo');
    expect(parseArgs('--worktree=1', spec).error).toBe('⚠️ 未知参数: --worktree=1 · 用法: /help demo');
  });

  it('引号包着的参数名是位置参数', () => {
    const parsed = parseArgs('看下 "-w" 这个参数', spec);
    expect(parsed.words).toEqual(['看下', '-w', '这个参数']);
    expect(parsed.flags.size).toBe(0);
  });

  it('`--` 之后的词一律是位置参数', () => {
    const parsed = parseArgs('--dir repo -- -w --dir', spec);
    expect(parsed.values.get('dir')).toBe('repo');
    expect(parsed.words).toEqual(['-w', '--dir']);
  });

  it('引号没闭合时回命令名对应的用法', () => {
    expect(parseArgs('--dir "D:\\My Repo', spec).error).toBe('⚠️ 引号没有闭合 · 用法: /help demo');
  });
});
