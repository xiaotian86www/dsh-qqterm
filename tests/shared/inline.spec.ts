import { describe, expect, it } from 'vitest';
import {
  attrValue,
  cleanInline,
  clip,
  commandLink,
  commandLinkRaw,
  hasOversizedTag,
  stripInlineTags,
  tagTextFits,
} from '../../src/shared/inline.ts';

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

  it('命令超过属性上限：不出按钮，退回纯文本标签', () => {
    expect(commandLink(`/get ${'a'.repeat(120)}`, '文件')).toBe('文件');
    expect(commandLink('a'.repeat(101), '')).toBe('a'.repeat(101));
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

  it('命令超过属性上限：退回原样展示文本', () => {
    expect(commandLinkRaw(`/ls ${'a'.repeat(120)}`, 'a_b~c')).toBe('a_b~c');
  });
});

describe('tagTextFits', () => {
  it('按转义后的属性长度判定，正好 100 字符算合规', () => {
    expect(tagTextFits('a'.repeat(100))).toBe(true);
    expect(tagTextFits('a'.repeat(101))).toBe(false);
  });

  it('实体转义后超限也算不合规', () => {
    expect(tagTextFits('&'.repeat(50))).toBe(false);
  });
});

describe('hasOversizedTag', () => {
  it('普通正文与合规标签都不算', () => {
    expect(hasOversizedTag('普通正文')).toBe(false);
    expect(hasOversizedTag(commandLink('/stop', '停止'))).toBe(false);
  });

  it('text 超过上限或缺失都算必拒', () => {
    expect(hasOversizedTag(`<qqbot-cmd-input text="/get ${'a'.repeat(120)}" show="文件"/>`)).toBe(true);
    expect(hasOversizedTag('<qqbot-cmd-input show="文件"/>')).toBe(true);
  });
});

describe('stripInlineTags', () => {
  it('把标签换成可复制的命令原文，记住实体还原', () => {
    expect(stripInlineTags('见 <qqbot-cmd-input text="/ls &quot;a&amp;b&quot;" show="目录"/>')).toBe('见 `/ls "a&b"`');
  });

  it('没有标签的文本原样返回', () => {
    expect(stripInlineTags('普通正文')).toBe('普通正文');
  });
});
