import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgType, type QQBot } from '@tencent-connect/qqbot-nodejs';
import { describe, expect, it } from 'vitest';
import { createReplyAwareBot } from '../../src/transport/reply-bot.ts';
import { ReplyStore } from '../../src/transport/reply-store.ts';
import type { Logger, ReplyTarget } from '../../src/types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

interface Call {
  method: string;
  args: unknown[];
}

function makeBot(): { bot: QQBot; calls: Call[] } {
  const calls: Call[] = [];
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return Promise.resolve({ id: 'sent' });
  };
  const raw = {
    send: record('send'),
    sendMarkdown: record('sendMarkdown'),
    sendText: record('sendText'),
    sendTextWithKeyboard: record('sendTextWithKeyboard'),
    sendImage: record('sendImage'),
    sendVideo: record('sendVideo'),
    sendVoice: record('sendVoice'),
    sendFile: record('sendFile'),
    sendMedia: record('sendMedia'),
  };
  return { bot: raw as unknown as QQBot, calls };
}

function makeStore(): ReplyStore {
  const dir = mkdtempSync(join(tmpdir(), 'reply-bot-'));
  return new ReplyStore({ appId: 'app1', logger, file: join(dir, 'reply-ids.json') });
}

const target: ReplyTarget = { scope: 'c2c', targetId: 'u1' };

describe('createReplyAwareBot', () => {
  it('sendMarkdown 填上最近一条 msgId', async () => {
    const { bot, calls } = makeBot();
    const store = makeStore();
    createReplyAwareBot(bot, store);
    store.recordMessage('c2c', 'u1', 'm1');

    await bot.sendMarkdown(target, 'hi');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('sendMarkdown');
    expect(calls[0]!.args[0]).toEqual({ scope: 'c2c', targetId: 'u1', msgId: 'm1' });
  });

  it('没有可用凭证时不填 msgId（降级为主动推送）', async () => {
    const { bot, calls } = makeBot();
    createReplyAwareBot(bot, makeStore());
    await bot.sendMarkdown(target, 'hi');
    expect(calls[0]!.args[0]).toEqual({ scope: 'c2c', targetId: 'u1', msgId: undefined });
  });

  it('event 候选通过 bot.send 的 extra 发出，并带上递增的 msg_seq', async () => {
    const { bot, calls } = makeBot();
    const store = makeStore();
    createReplyAwareBot(bot, store);
    store.recordEvent('c2c', 'u1', 'evt-1');

    await bot.sendMarkdown(target, 'hello');
    await bot.sendMarkdown(target, 'again');
    expect(calls.map((call) => call.method)).toEqual(['send', 'send']);
    expect(calls[0]!.args[0]).toMatchObject({
      target: { scope: 'c2c', targetId: 'u1', msgId: undefined },
      msgType: MsgType.MARKDOWN,
      markdown: { content: 'hello' },
      extra: { event_id: 'INTERACTION_CREATE:evt-1', msg_seq: 1 },
    });
    // 同一次互动回两条：平台按 (event_id, msg_seq) 去重，seq 必须换
    expect(calls[1]!.args[0]).toMatchObject({ extra: { msg_seq: 2 } });
  });

  it('文本与媒体只用 msg 候选，不会拿 event 顶上', async () => {
    const { bot, calls } = makeBot();
    const store = makeStore();
    createReplyAwareBot(bot, store);
    store.recordEvent('c2c', 'u1', 'evt-1');

    await bot.sendText(target, 'hi');
    await bot.sendFile(target, { localPath: 'a.txt' });
    await bot.sendMedia({ target, fileType: 1, url: 'x' });
    expect(calls.map((call) => call.method)).toEqual(['sendText', 'sendFile', 'sendMedia']);
    expect((calls[0]!.args[0] as ReplyTarget).msgId).toBeUndefined();
    expect((calls[1]!.args[0] as ReplyTarget).eventId).toBeUndefined();
    expect((calls[2]!.args[0] as { target: ReplyTarget }).target.eventId).toBeUndefined();
  });

  it('sendImage 走 SDK 的 sendMedia 委托时 source 不被当成 target', async () => {
    // 复刻 SDK 真实结构：sendImage(target, source) 内部 this.sendMedia({ target, ...source })
    const calls: Call[] = [];
    const raw = {
      send: () => Promise.resolve({}),
      sendMedia: async (opts: Record<string, unknown>) => {
        calls.push({ method: 'sendMedia', args: [opts] });
        return { upload: { file_uuid: 'u' }, message: { id: 'm' } };
      },
      sendImage: async (t: unknown, source: Record<string, unknown>) =>
        (raw.sendMedia as (opts: unknown) => Promise<unknown>)({ target: t, fileType: 1, ...source }),
    };
    const bot = raw as unknown as QQBot;
    const store = makeStore();
    createReplyAwareBot(bot, store);
    store.recordMessage('c2c', 'u1', 'm1');

    await bot.sendImage(target, { localPath: 'a.png' });
    const opts = calls[0]!.args[0] as Record<string, unknown>;
    expect(opts['target']).toEqual({ scope: 'c2c', targetId: 'u1', msgId: 'm1' });
    expect(opts['localPath']).toBe('a.png');
    expect(opts['fileType']).toBe(1);
  });

  it('媒体只在 sendMedia 一层解析凭证：一次发送只记一次用量', async () => {
    // 复刻 SDK 委托结构，连发 4 张图占满被动回复额度，第 5 张应降级为主动推送
    const calls: Call[] = [];
    const raw = {
      send: () => Promise.resolve({}),
      sendMedia: async (opts: Record<string, unknown>) => {
        calls.push({ method: 'sendMedia', args: [opts] });
        return { upload: { file_uuid: 'u' }, message: { id: 'm' } };
      },
      sendImage: async (t: unknown, source: Record<string, unknown>) =>
        (raw.sendMedia as (opts: unknown) => Promise<unknown>)({ target: t, fileType: 1, ...source }),
    };
    const bot = raw as unknown as QQBot;
    const store = makeStore();
    createReplyAwareBot(bot, store);
    store.recordMessage('c2c', 'u1', 'm1');

    for (let i = 0; i < 5; i += 1) await bot.sendImage(target, { localPath: `${i}.png` });
    const targets = calls.map((call) => (call.args[0] as { target: ReplyTarget }).target);
    expect(targets.slice(0, 4).every((t) => t.msgId === 'm1')).toBe(true);
    expect(targets[4]!.msgId).toBeUndefined();
    expect(targets[4]!.targetId).toBe('u1');
  });

  it('凭证过期（40034005）丢掉该 target 的凭证后原样抛出：重试即降级主动推送', async () => {
    let attempt = 0;
    const calls: Call[] = [];
    const raw = {
      send: async () => ({}),
      sendMarkdown: async (t: ReplyTarget) => {
        attempt += 1;
        calls.push({ method: 'sendMarkdown', args: [t] });
        if (attempt === 1) throw Object.assign(new Error('API Error'), { httpStatus: 400, bizCode: 40034005 });
        return {};
      },
    };
    const bot = raw as unknown as QQBot;
    const store = makeStore();
    store.recordMessage('c2c', 'u1', 'm1');
    createReplyAwareBot(bot, store);

    await expect(bot.sendMarkdown(target, 'hi')).rejects.toThrow('API Error');
    // 凭证已被丢掉，第二次解析不再填 msgId
    await bot.sendMarkdown(target, 'hi');
    expect((calls[0]!.args[0] as { msgId?: string }).msgId).toBe('m1');
    expect((calls[1]!.args[0] as { msgId?: string }).msgId).toBeUndefined();
  });

  it('发送失败原样抛给上层，不做自动重试', async () => {
    const bot = {
      send: async () => ({}),
      sendMarkdown: async () => {
        throw new Error('40034005');
      },
    } as unknown as QQBot;
    const store = makeStore();
    store.recordMessage('c2c', 'u1', 'm1');
    createReplyAwareBot(bot, store);
    await expect(bot.sendMarkdown(target, 'hi')).rejects.toThrow('40034005');
  });

  it('不装饰低层 send，避免二次解析', () => {
    const { bot } = makeBot();
    const original = bot.send;
    createReplyAwareBot(bot, makeStore());
    expect(bot.send).toBe(original);
  });
});
