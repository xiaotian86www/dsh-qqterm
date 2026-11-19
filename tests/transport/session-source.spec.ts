import { describe, it, expect } from 'vitest';
import type { SessionRecord } from '../../src/session/index.ts';
import {
  UNNAMED_SESSION_TITLE,
  decorateSessionMessage,
  sessionArchiveLink,
  sessionLinkRow,
  sessionReplyLink,
  sessionResumeLink,
  sessionSourceHeader,
  sessionTargetLabel,
  sessionTitleOf,
  sourceTitle,
} from '../../src/transport/session-source.ts';

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

describe('来源行与尾部动作', () => {
  it('来源行独占一行，只留短 id 与标题（不带图标）', () => {
    expect(sessionSourceHeader('session-04de1556-8c54-4b78-93e1-5714e079fca6', '修登录'))
      .toBe('> `#04de1556` · 修登录');
  });

  it('回复链接把 /to #短id 填进输入框，标签写全动作、不再重复 id', () => {
    expect(sessionReplyLink('session-04de1556-8c54-4b78-93e1-5714e079fca6'))
      .toBe('<qqbot-cmd-input text="/to #04de1556 " show="回复"/>');
  });

  it('恢复链接切回该会话，标签同样写全动作', () => {
    expect(sessionResumeLink('session-04de1556-8c54-4b78-93e1-5714e079fca6'))
      .toBe('<qqbot-cmd-input text="/sessions resume #04de1556" show="恢复"/>');
  });

  it('归档链接把 /sessions archive #短id 直接执行', () => {
    expect(sessionArchiveLink('session-04de1556-8c54-4b78-93e1-5714e079fca6'))
      .toBe('<qqbot-cmd-input text="/sessions archive #04de1556" show="归档"/>');
  });

  it('没有归档能力时尾部行只有回复 + 恢复', () => {
    expect(sessionLinkRow('session-04de1556'))
      .toBe('<qqbot-cmd-input text="/to #04de1556 " show="回复"/>'
        + ' · <qqbot-cmd-input text="/sessions resume #04de1556" show="恢复"/>');
  });

  it('有归档能力时尾部行多一个归档链接，排在最后', () => {
    expect(sessionLinkRow('session-04de1556', true))
      .toBe('<qqbot-cmd-input text="/to #04de1556 " show="回复"/>'
        + ' · <qqbot-cmd-input text="/sessions resume #04de1556" show="恢复"/>'
        + ' · <qqbot-cmd-input text="/sessions archive #04de1556" show="归档"/>');
  });

  it('整段装饰：来源头 + 正文 + 链接行（含归档）', () => {
    expect(decorateSessionMessage('hello', 'session-04de1556', '修登录', true))
      .toBe('> `#04de1556` · 修登录\n\nhello\n\n'
        + '<qqbot-cmd-input text="/to #04de1556 " show="回复"/>'
        + ' · <qqbot-cmd-input text="/sessions resume #04de1556" show="恢复"/>'
        + ' · <qqbot-cmd-input text="/sessions archive #04de1556" show="归档"/>');
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
