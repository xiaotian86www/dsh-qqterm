/**
 * 轮次失败后的「重发 / 放弃」卡片。
 *
 * 回归点：失败时曾把宿主原始 code + JSON 抛给用户，且没有恢复入口；
 * 现在改成可重试失败挂两个按钮，配置类失败只讲原因。
 */
import { describe, it, expect, vi } from 'vitest';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { RetryChannel, type RetrySessionRecordLike } from './retry-channel.ts';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface SentMessage {
  text: string;
  opts?: { keyboard?: unknown };
}

function createSender(sent: SentMessage[], opts?: { failKeyboard?: boolean; failAll?: boolean }) {
  return {
    sendMarkdown: vi.fn(async (_target: ReplyTarget, content: string, o?: { keyboard?: unknown }) => {
      if (opts?.failAll) throw new Error('send failed');
      if (o?.keyboard && opts?.failKeyboard) throw new Error('keyboard not permitted');
      sent.push({ text: content, opts: o });
    }),
  };
}

const failure = { code: 'RATE_LIMIT', message: '429: {"type":"server_error"}' };
const PROMPT = '上一条原始消息';

function makeRecord(opts?: {
  sessionKey?: string;
  peerId?: string | null;
  lastPrompt?: string | null;
}): RetrySessionRecordLike & { agent: { followup: ReturnType<typeof vi.fn> } } {
  const scope: ChatScope = 'c2c';
  const sessionKey = opts?.sessionKey ?? 'qqbot:app:chat';
  const record: RetrySessionRecordLike & { agent: { followup: ReturnType<typeof vi.fn> } } = {
    sessionKey,
    sessionId: sessionKey,
    scope,
    replyTarget: { scope, targetId: 'x', msgId: 'm' },
    agent: { followup: vi.fn() },
  };
  const peerId = opts?.peerId === undefined ? 'U1' : opts.peerId;
  if (peerId !== null) record.peerId = peerId;
  const lastPrompt = opts?.lastPrompt === undefined ? PROMPT : opts.lastPrompt;
  if (lastPrompt !== null) record.lastPrompt = lastPrompt;
  return record;
}

function createManager(record: RetrySessionRecordLike | undefined, opts?: { current?: boolean; title?: string }) {
  return {
    getSessionRecord: () => record,
    isCurrentSession: () => opts?.current ?? true,
    sessionTitle: () => opts?.title,
  };
}

function createChannel(
  record: RetrySessionRecordLike | undefined,
  sent: SentMessage[],
  opts?: { current?: boolean; title?: string; enabled?: boolean; timeoutMs?: number; failKeyboard?: boolean; failAll?: boolean },
) {
  const sender = createSender(sent, { failKeyboard: opts?.failKeyboard, failAll: opts?.failAll });
  const channel = new RetryChannel(
    createManager(record, { current: opts?.current, title: opts?.title }),
    sender,
    { retryOffer: { enabled: opts?.enabled ?? true, timeoutMs: opts?.timeoutMs ?? 60_000 } },
    createLogger(),
  );
  return { channel, sender };
}

function makeEvent(data?: string, user?: string): InteractionEvent {
  return {
    id: 'i1',
    type: 1,
    version: 1,
    ...(user !== undefined ? { user_openid: user } : {}),
    data: { type: 1, resolved: { ...(data !== undefined ? { button_data: data } : {}) } },
  } as InteractionEvent;
}

const click = (sessionId: string, action: 'resend' | 'discard', user = 'U1'): InteractionEvent =>
  makeEvent(JSON.stringify({ t: 'retry', s: sessionId, d: action }), user);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('RetryChannel.offer', () => {
  it('可重试失败挂两个按钮，正文含真实重试次数与原因', async () => {
    const sent: SentMessage[] = [];
    const { channel } = createChannel(makeRecord(), sent);
    expect(await channel.offer(makeRecord(), failure, 5)).toBe(true);

    const text = sent[0]?.text ?? '';
    expect(text).toContain('⚠️ 上游服务异常，重试 5 次未成功');
    expect(text).toContain('原因: `RATE_LIMIT` · 429');
    expect(text).toContain('> 👇 点「重发」重跑上一条消息');
    expect(sent[0]?.opts?.keyboard).toBeDefined();
  });

  it('没有原文时不挂卡片（也没法重发）', async () => {
    const sent: SentMessage[] = [];
    const record = makeRecord({ lastPrompt: null });
    const { channel } = createChannel(record, sent);
    expect(await channel.offer(record, failure, 5)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('配置关闭时交给调用方发普通失败文案', async () => {
    const sent: SentMessage[] = [];
    const record = makeRecord();
    const { channel } = createChannel(record, sent, { enabled: false });
    expect(await channel.offer(record, failure, 5)).toBe(false);
    expect(channel.enabled).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('键盘发送失败时降级为纯文本并指向 /retry', async () => {
    const sent: SentMessage[] = [];
    const record = makeRecord();
    const { channel } = createChannel(record, sent, { failKeyboard: true });
    expect(await channel.offer(record, failure, 2)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.opts?.keyboard).toBeUndefined();
    expect(sent[0]?.text).toContain('> 💡 发送 `/retry` 重跑上一条消息');
  });

  it('两条通道都发不出去时返回 false，让调用方兜底', async () => {
    const sent: SentMessage[] = [];
    const record = makeRecord();
    const { channel } = createChannel(record, sent, { failAll: true });
    expect(await channel.offer(record, failure, 1)).toBe(false);
  });

  it('非当前会话的卡片带来源行', async () => {
    const sent: SentMessage[] = [];
    const record = makeRecord({ sessionKey: 'sess-a' });
    const { channel } = createChannel(record, sent, { current: false, title: '修登录' });
    await channel.offer(record, failure, 1);
    expect(sent[0]?.text.startsWith('> `#')).toBe(true);
    expect(sent[0]?.text).toContain('修登录');
  });
});

describe('RetryChannel.handleInteraction', () => {
  it('点「重发」重发上一条原文', async () => {
    const sent: SentMessage[] = [];
    const record = makeRecord({ sessionKey: 'sess-a' });
    const { channel } = createChannel(record, sent);
    await channel.offer(record, failure, 1);

    expect(channel.handleInteraction(click('sess-a', 'resend'))).toBe(true);
    expect(record.agent.followup).toHaveBeenCalledTimes(1);
    const message = record.agent.followup.mock.calls[0]?.[0] as { content?: Array<{ text?: string }> };
    expect(message.content?.[0]?.text).toBe(PROMPT);
    expect(sent.at(-1)?.text).toContain('✅ 已重发上一条消息');
  });

  it('点「放弃」只回执，不重发', async () => {
    const sent: SentMessage[] = [];
    const record = makeRecord({ sessionKey: 'sess-a' });
    const { channel } = createChannel(record, sent);
    await channel.offer(record, failure, 1);

    expect(channel.handleInteraction(click('sess-a', 'discard'))).toBe(true);
    expect(record.agent.followup).not.toHaveBeenCalled();
    expect(sent.at(-1)?.text).toContain('✅ 已放弃重发');
  });

  it('同一张卡只能点一次', async () => {
    const sent: SentMessage[] = [];
    const record = makeRecord({ sessionKey: 'sess-a' });
    const { channel } = createChannel(record, sent);
    await channel.offer(record, failure, 1);

    expect(channel.handleInteraction(click('sess-a', 'resend'))).toBe(true);
    expect(channel.handleInteraction(click('sess-a', 'resend'))).toBe(false);
    expect(record.agent.followup).toHaveBeenCalledTimes(1);
  });

  it('别人点不动这张卡', async () => {
    const sent: SentMessage[] = [];
    const record = makeRecord({ sessionKey: 'sess-a', peerId: 'U1' });
    const { channel } = createChannel(record, sent);
    await channel.offer(record, failure, 1);

    expect(channel.handleInteraction(click('sess-a', 'resend', 'U2'))).toBe(false);
    expect(record.agent.followup).not.toHaveBeenCalled();
  });

  it('非重发按钮 / 缺会话 id 一律忽略', async () => {
    const sent: SentMessage[] = [];
    const record = makeRecord({ sessionKey: 'sess-a' });
    const { channel } = createChannel(record, sent);
    await channel.offer(record, failure, 1);

    expect(channel.handleInteraction(makeEvent(JSON.stringify({ t: 'approval', d: 'deny' }), 'U1'))).toBe(false);
    expect(channel.handleInteraction(makeEvent(JSON.stringify({ t: 'retry', d: 'resend' }), 'U1'))).toBe(false);
    expect(channel.handleInteraction(makeEvent('not-json', 'U1'))).toBe(false);
    expect(channel.handleInteraction(makeEvent(undefined, 'U1'))).toBe(false);
    expect(record.agent.followup).not.toHaveBeenCalled();
  });

  it('超时后按钮失效', async () => {
    const sent: SentMessage[] = [];
    const record = makeRecord({ sessionKey: 'sess-a' });
    const { channel } = createChannel(record, sent, { timeoutMs: 5 });
    await channel.offer(record, failure, 1);

    await sleep(30);
    expect(channel.handleInteraction(click('sess-a', 'resend'))).toBe(false);
    expect(record.agent.followup).not.toHaveBeenCalled();
  });

  it('uninstall 清掉所有待确认状态', async () => {
    const sent: SentMessage[] = [];
    const record = makeRecord({ sessionKey: 'sess-a' });
    const { channel } = createChannel(record, sent);
    await channel.offer(record, failure, 1);

    channel.uninstall();
    expect(channel.handleInteraction(click('sess-a', 'resend'))).toBe(false);
  });
});
