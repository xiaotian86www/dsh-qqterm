/**
 * 发送端口：三条语义各自承诺什么，失败怎么降级
 *
 * 这里的用例直接打 createSender，不走 outbound / channel：那两层已经各自有
 * 用例，再经由它们测只会把「分片、重试、入队、降级」的断言绕远。
 */
import { describe, expect, it, vi } from 'vitest';
import { createSender, sendChunkedText, type QQBotSender, type SendText } from '../../src/transport/send.ts';
import { Outbox } from '../../src/transport/outbox.ts';
import type { QQTermConfig } from '../../src/config.ts';
import type { Logger, ReplyTarget } from '../../src/types.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const TARGET: ReplyTarget = { scope: 'c2c', targetId: 'u1' };

/** 平台错误：按 SDK 的字段形状给 bizCode，分类器认得 */
function apiError(bizCode: number): Error {
  return Object.assign(new Error(`biz ${bizCode}`), { bizCode });
}

function netError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** 可编排的 bot：script 里排好每次调用要抛的错，用光之后一律成功 */
function makeBot(script: Array<Error | undefined> = []): {
  bot: QQBotSender;
  calls: Array<{ body: string; keyboard?: unknown }>;
} {
  const calls: Array<{ body: string; keyboard?: unknown }> = [];
  const sendMarkdown = vi.fn(async (_target: ReplyTarget, body: string, opts?: { keyboard?: unknown }) => {
    const next = script.shift();
    if (next !== undefined) throw next;
    calls.push(opts?.keyboard === undefined ? { body } : { body, keyboard: opts.keyboard });
    return { id: `m${calls.length}` };
  });
  return { bot: { sendMarkdown }, calls };
}

const config = { textChunkLimit: 20 } as unknown as QQTermConfig;

function view(current = true): { isCurrent: (id: string) => boolean; titleOf: () => string; canArchive: () => boolean } {
  return { isCurrent: () => current, titleOf: () => '标题', canArchive: () => true };
}

function makeSender(script: Array<Error | undefined> = [], current = true) {
  const { bot, calls } = makeBot(script);
  const outbox = new Outbox({ logger });
  const sender = createSender({ bot, config, logger, sessions: view(current), outbox });
  return { sender, calls, outbox };
}

describe('text：一次性消息', () => {
  it('按上限分片逐条发，拼回原文', async () => {
    const { sender, calls } = makeSender();
    const body = ['第一行内容比较长一些', '第二行内容比较长一些', '第三行内容比较长一些'].join('\n');

    await sender.text(TARGET, body);

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every(call => call.body.length <= 20)).toBe(true);
    // 切分点吃掉换行，只校验内容没被截断
    const joined = calls.map(call => call.body).join('');
    expect(joined).toContain('第一行内容');
    expect(joined).toContain('第三行内容');
    expect(calls.every(call => call.keyboard === undefined)).toBe(true);
  });

  it('空正文不发', async () => {
    const { sender, calls } = makeSender();
    await sender.text(TARGET, '');
    expect(calls).toHaveLength(0);
  });

  it('网络类失败重试一次后成功', async () => {
    const { sender, calls } = makeSender([netError('ETIMEDOUT')]);
    await sender.text(TARGET, 'hello');
    expect(calls).toHaveLength(1);
  });

  it('内容类失败不重试，直接抛给调用方', async () => {
    const { sender, calls } = makeSender([apiError(40054007)]);
    await expect(sender.text(TARGET, 'hello')).rejects.toThrow('biz 40054007');
    expect(calls).toHaveLength(0);
  });
});

describe('session：会话输出', () => {
  it('当前会话不加署名', async () => {
    const { sender, calls } = makeSender([], true);
    await sender.session('sess-1', TARGET, '正文', 'assistant');
    expect(calls[0]?.body).toBe('正文');
  });

  it('非当前会话加来源头与回复入口', async () => {
    const { sender, calls } = makeSender([], false);
    await sender.session('abcd1234-xyz', TARGET, '正文', 'assistant');
    const body = calls.map(call => call.body).join('');
    expect(body).toContain('> `#abcd1234` · 标题');
    expect(body).toContain('/to #abcd1234');
    expect(body).toContain('正文');
  });

  it('超长被平台拒绝：折半重切后继续发完', async () => {
    const { sender, calls } = makeSender([apiError(40054007)]);
    const body = 'A'.repeat(60);
    await sender.session('sess-1', TARGET, body, 'assistant');
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.map(call => call.body).join('').length).toBeGreaterThanOrEqual(60);
  });

  it('两次网络失败：入队并停发后续分片，恢复后按序补发', async () => {
    const { sender, calls, outbox } = makeSender([netError('ECONNRESET'), netError('ECONNRESET')]);
    const body = ['第一段内容', '第二段内容', '第三段内容'].join('\n');

    await sender.session('sess-1', TARGET, body, 'assistant');

    expect(calls).toHaveLength(0);
    expect(outbox.hasPending('sess-1')).toBe(true);
    expect(sender.hasPending('sess-1')).toBe(true);
    // 后续分片也跟着入队：恢复后一次补完，不会剩下半截
    expect(outbox.hasPending()).toBe(true);

    await sender.flush();

    expect(calls.map(call => call.body).join('')).toBe(body);
    expect(sender.hasPending('sess-1')).toBe(false);
  });

  it('风控拦截：只发一条替代文案，不重复', async () => {
    const { sender, calls } = makeSender([apiError(40034006)]);
    await sender.session('sess-1', TARGET, '正文', 'assistant');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe('❌ 上一条消息被 QQ 拦截，未送达。');
  });

  it('超长且切不动：告知超长，不冒充风控拦截', async () => {
    const { sender, calls } = makeSender([apiError(40054007)]);
    await sender.session('sess-1', TARGET, 'A', 'assistant');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe('❌ 上一条消息超过长度上限，切到最小分片仍被拒，未送达。');
  });

  it('空正文不发', async () => {
    const { sender, calls } = makeSender();
    await sender.session('sess-1', TARGET, '', 'assistant');
    expect(calls).toHaveLength(0);
  });
});

describe('card：交互卡片', () => {
  const keyboard = { content: { rows: [] } } as never;

  it('带键盘发出', async () => {
    const { sender, calls } = makeSender();
    await sender.card(TARGET, '卡片正文', keyboard, '纯文本兜底');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe('卡片正文');
    expect(calls[0]?.keyboard).toBe(keyboard);
  });

  it('键盘发送失败且给了兜底：改发纯文本', async () => {
    const { sender, calls } = makeSender([new Error('keyboard unavailable')]);
    await sender.card(TARGET, '卡片正文', keyboard, '纯文本兜底');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe('纯文本兜底');
    expect(calls[0]?.keyboard).toBeUndefined();
  });

  it('键盘发送失败且没有兜底：原样抛出', async () => {
    const { sender } = makeSender([new Error('keyboard unavailable')]);
    await expect(sender.card(TARGET, '卡片正文', keyboard)).rejects.toThrow('keyboard unavailable');
  });
});

describe('decorate 与 sendChunkedText', () => {
  it('decorate 只给非当前会话加署名', async () => {
    const current = makeSender([], true).sender;
    expect(current.decorate('sess-1', '正文')).toBe('正文');

    const other = makeSender([], false).sender;
    expect(other.decorate('abcd1234-xyz', '正文')).toContain('> `#abcd1234` · 标题');
  });

  it('sendChunkedText 是命令层复用的分片发送', async () => {
    const { bot, calls } = makeBot([netError('EAI_AGAIN')]);
    const send: SendText = (target, body) => sendChunkedText(bot, target, body, 20);
    await send(TARGET, ['第一行内容', '第二行内容'].join('\n'));
    expect(calls.length).toBeGreaterThan(0);
  });
});
