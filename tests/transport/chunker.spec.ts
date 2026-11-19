import { describe, expect, it } from 'vitest';
import { splitForLimit } from '../../src/transport/chunker.ts';
import { decorateSessionMessage } from '../../src/transport/session-source.ts';

describe('splitForLimit', () => {
  const id = 'session-04de1556-8c54-4b78-93e1-5714e079fca6';
  const body = Array.from({ length: 30 }, (_, i) => `第 ${i} 行：内容内容内容内容`).join('\n');

  it('装饰后的整条消息：首片带来源头、末片带尾部行、中间片不重复', () => {
    const chunks = splitForLimit(decorateSessionMessage(body, id, '修登录'), 260);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.startsWith('> `#04de1556` · 修登录')).toBe(true);
    const last = chunks[chunks.length - 1]!;
    expect(last).toContain('show="恢复"');
    for (const chunk of chunks.slice(1, -1)) {
      expect(chunk).not.toContain('#04de1556');
    }
  });

  it('切完拼回原文，一个字都不丢', () => {
    const text = decorateSessionMessage(body, id, '修登录', true);

    expect(splitForLimit(text, 260).join('\n')).toBe(text);
  });

  it('每片都不超过上限（带归档入口时也一样）', () => {
    for (const limit of [260, 460]) {
      for (const archivable of [false, true]) {
        const chunks = splitForLimit(decorateSessionMessage(body, id, '修登录', archivable), limit);
        for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('单行超长时按字符硬切，不切断行内标签', () => {
    const tag = '<qqbot-cmd-input text="/get 报告.md" show="报告.md"/>';
    const text = `${'a'.repeat(180)}${tag}${'b'.repeat(120)}`;
    const chunks = splitForLimit(text, 200);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
      expect((chunk.match(/</g) ?? []).length).toBe((chunk.match(/>/g) ?? []).length);
    }
  });
});
