import { describe, it, expect } from 'vitest';
import type { SessionRecord } from '../session/index.ts';
import {
  UNNAMED_SESSION_TITLE,
  chunkDecoratedSessionMessage,
  decorateSessionMessage,
  sessionLinkRow,
  sessionReplyLink,
  sessionResumeLink,
  sessionSourceHeader,
  sessionTargetLabel,
  sessionTitleOf,
  sourceTitle,
} from './session-source.ts';

function recordWithEvents(events: ReadonlyArray<{ type?: string; data?: { title?: unknown } }>): SessionRecord {
  return {
    sessionKey: 'k',
    sessionId: 'session-04de1556-8c54-4b78-93e1-5714e079fca6',
    replyTarget: { scope: 'c2c', targetId: 'u' },
    agent: { session: { id: 's', snapshotEvents: () => events } },
  } as unknown as SessionRecord;
}

describe('sourceTitle', () => {
  it('压成单行并去掉 markdown / 标签字符', () => {
    expect(sourceTitle('  修\n登录 `v2` <b>  ')).toBe('修 登录 v2 b');
  });

  it('空标题用兜底名', () => {
    expect(sourceTitle(undefined)).toBe(UNNAMED_SESSION_TITLE);
    expect(sourceTitle('   ')).toBe(UNNAMED_SESSION_TITLE);
  });

  it('超长截断补省略号', () => {
    const title = sourceTitle('一'.repeat(40));
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(21);
  });
});

describe('来源行与尾部链接', () => {
  it('来源行独占一行，只留短 id 与标题（不带图标）', () => {
    expect(sessionSourceHeader('session-04de1556-8c54-4b78-93e1-5714e079fca6', '修登录'))
      .toBe('> `#04de1556` · 修登录');
  });

  it('回复链接把 /to #短id 填进输入框，按钮文本不再重复 id', () => {
    expect(sessionReplyLink('session-04de1556-8c54-4b78-93e1-5714e079fca6'))
      .toBe('<qqbot-cmd-input text="/to #04de1556 " show="回复"/>');
  });

  it('恢复链接切回该会话，按钮文本同样只写动作', () => {
    expect(sessionResumeLink('session-04de1556-8c54-4b78-93e1-5714e079fca6'))
      .toBe('<qqbot-cmd-input text="/sessions resume #04de1556" show="恢复"/>');
  });

  it('尾部行是回复 + 恢复两个链接', () => {
    expect(sessionLinkRow('session-04de1556'))
      .toBe('> <qqbot-cmd-input text="/to #04de1556 " show="回复"/>'
        + ' · <qqbot-cmd-input text="/sessions resume #04de1556" show="恢复"/>');
  });

  it('整段装饰：来源头 + 空行 + 正文 + 空行 + 链接行', () => {
    expect(decorateSessionMessage('hello', 'session-04de1556', '修登录'))
      .toBe('> `#04de1556` · 修登录\n\nhello\n\n'
        + '> <qqbot-cmd-input text="/to #04de1556 " show="回复"/>'
        + ' · <qqbot-cmd-input text="/sessions resume #04de1556" show="恢复"/>');
  });
});

describe('sessionTargetLabel', () => {
  it('标题 + 短 id 一起给：认得出会话，也对得上列表', () => {
    expect(sessionTargetLabel('session-04de1556-8c54-4b78-93e1-5714e079fca6', '修登录'))
      .toBe('「修登录」 · `#04de1556`');
  });

  it('没有标题时只给 id，不补「未命名会话」这种噪音', () => {
    expect(sessionTargetLabel('session-04de1556', undefined)).toBe('`#04de1556`');
    expect(sessionTargetLabel('session-04de1556', '   ')).toBe('`#04de1556`');
  });

  it('标题净化并截断，不破坏行内代码与引号', () => {
    expect(sessionTargetLabel('session-04de1556', '修 `登录`\n第二行')).toBe('「修 登录 第二行」 · `#04de1556`');
    expect(sessionTargetLabel('session-04de1556', '一'.repeat(40)).endsWith('…」 · `#04de1556`')).toBe(true);
  });
});

describe('chunkDecoratedSessionMessage', () => {
  const id = 'session-04de1556-8c54-4b78-93e1-5714e079fca6';
  const body = Array.from({ length: 30 }, (_, i) => `第 ${i} 行：内容内容内容内容`).join('\n');

  it('首片带来源头、末片带链接行，中间片不重复', () => {
    const chunks = chunkDecoratedSessionMessage(body, id, '修登录', 260);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.startsWith('> `#04de1556` · 修登录\n\n')).toBe(true);
    expect(chunks[0]).not.toContain('<qqbot-cmd-input');
    expect(chunks[chunks.length - 1]!.endsWith('show="恢复"/>')).toBe(true);
    for (const chunk of chunks.slice(1, -1)) {
      expect(chunk).not.toContain('#04de1556');
    }
  });

  it('加完装饰后每条都不超过 textChunkLimit', () => {
    for (const chunk of chunkDecoratedSessionMessage(body, id, '修登录', 260)) {
      expect(chunk.length).toBeLessThanOrEqual(260);
    }
  });
});

describe('sessionTitleOf', () => {
  it('取最新一条 session/title', () => {
    const record = recordWithEvents([
      { type: 'session/title', data: { title: '旧标题' } },
      { type: 'assistant/message', data: {} },
      { type: 'session/title', data: { title: '修登录' } },
    ]);
    expect(sessionTitleOf(record)).toBe('修登录');
  });

  it('新追加的标题事件会被补扫到', () => {
    const events: Array<{ type?: string; data?: { title?: unknown } }> = [
      { type: 'session/title', data: { title: '旧标题' } },
    ];
    const record = recordWithEvents(events);
    expect(sessionTitleOf(record)).toBe('旧标题');

    events.push({ type: 'session/title', data: { title: '新标题' } });
    expect(sessionTitleOf(record)).toBe('新标题');
  });

  it('没有标题事件时返回 undefined', () => {
    expect(sessionTitleOf(recordWithEvents([{ type: 'user/message', data: {} }]))).toBeUndefined();
  });

  it('快照读取失败不影响出站', () => {
    const record = {
      sessionKey: 'k',
      sessionId: 's',
      replyTarget: { scope: 'c2c', targetId: 'u' },
      agent: { session: { id: 's', snapshotEvents: () => { throw new Error('boom'); } } },
    } as unknown as SessionRecord;
    expect(sessionTitleOf(record)).toBeUndefined();
  });
});
