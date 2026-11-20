import { describe, expect, it } from 'vitest';
import { attrValue, cleanInline, clip, commandLink, commandLinkRaw } from '../../src/shared/inline.ts';

describe('cleanInline', () => {
  it('把换行与连续空白压成单个空格并去掉首尾空白', () => {
    expect(cleanInline('  第一行\n第二行\t\t第三行  ')).toBe('第一行 第二行 第三行');
  });

  it('去掉会破坏行内标签的 markdown 与属性字符', () => {
    expect(cleanInline('**加粗** `代码` _斜体_ ~删除~ <b> "引号" \'单引\'')).toBe('加粗 代码 斜体 删除 b 引号 单引');
  });

  it('空串仍是空串', () => {
    expect(cleanInline(' \n ')).toBe('');
  });
});

describe('attrValue', () => {
  it('转义 & 与引号，尖括号也不会提前结束属性', () => {
    expect(attrValue('a&b"c<d>e')).toBe('a&amp;b&quot;c&lt;d&gt;e');
  });

  it('先转义 & 再处理其它字符，不会二次转义', () => {
    expect(attrValue('<')).toBe('&lt;');
  });
});

describe('clip', () => {
  it('超过上限时截断并保证总长等于上限', () => {
    expect(clip('abcdef', 5)).toBe('abcd…');
    expect(clip('abcdef', 5)).toHaveLength(5);
  });

  it('未超过上限时原样返回', () => {
    expect(clip('abc', 5)).toBe('abc');
  });
});

describe('commandLink', () => {
  it('拼出可点击命令，展示文本先净化', () => {
    expect(commandLink('/to #12345678 ', '回\n复')).toBe(
      '<qqbot-cmd-input text="/to #12345678 " show="回 复"/>',
    );
  });

  it('展示文本为空时退回命令本身', () => {
    expect(commandLink('/stop', '')).toBe('<qqbot-cmd-input text="/stop" show="/stop"/>');
  });

  it('命令里的引号与 & 被转义', () => {
    expect(commandLink('/ls "a&b"', '目录')).toBe(
      '<qqbot-cmd-input text="/ls &quot;a&amp;b&quot;" show="目录"/>',
    );
  });
});

describe('commandLinkRaw', () => {
  it('展示文本不过净化，下划线与波浪号原样保留', () => {
    expect(commandLinkRaw('/ls C:\\work\\a_b~c', 'a_b~c')).toBe(
      '<qqbot-cmd-input text="/ls C:\\work\\a_b~c" show="a_b~c"/>',
    );
  });

  it('只去换行再转义属性字符', () => {
    expect(commandLinkRaw('/get x', 'a\nb"c')).toBe('<qqbot-cmd-input text="/get x" show="a b&quot;c"/>');
  });
});
