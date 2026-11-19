/**
 * 命令参数切词的共用规则：空格分隔、成对引号包住一个值、\`--\` 与参数识别交给各命令
 */
import { describe, expect, it } from 'vitest';
import { looksLikeParam, parseRest, tokenize } from '../../src/commands/args.ts';

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
