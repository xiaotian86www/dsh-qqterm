import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgType, type QQBot } from '@tencent-connect/qqbot-nodejs';
import { describe, expect, it } from 'vitest';
import { createReplyAwareBot } from './reply-bot.ts';
import { ReplyStore } from './reply-store.ts';
import type { Logger, ReplyTarget } from '../types.ts';

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
    openStream: (...args: unknown[]) => {
      calls.push({ method: 'openStream', args });
      return { update: async () => {}, complete: async () => {} };
    },
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

  it('event 候选通过 bot.send 的 extra 发出', async () => {
    const { bot, calls } = makeBot();
    const store = makeStore();
    createReplyAwareBot(bot, store);
    store.recordEvent('c2c', 'u1', 'evt-1');

    await bot.sendMarkdown(target, 'hello');
    expect(calls[0]!.method).toBe('send');
    expect(calls[0]!.args[0]).toMatchObject({
      target: { scope: 'c2c', targetId: 'u1', msgId: undefined },
      msgType: MsgType.MARKDOWN,
      markdown: { content: 'hello' },
      extra: { event_id: 'INTERACTION_CREATE:evt-1' },
    });
  });

  it('文本与媒体只用 msg 候选，不会拿 event 顶上', async () => {
    const { bot, calls } = makeBot();
    const store = makeStore();
    createReplyAwareBot(bot, store);
    store.recordEvent('c2c', 'u1', 'evt-1');

    await bot.sendText(target, 'hi');
    await bot.sendFile(target, { localPath: 'a.txt' });
    expect(calls.map((call) => call.method)).toEqual(['sendText', 'sendFile']);
    expect((calls[0]!.args[0] as ReplyTarget).msgId).toBeUndefined();
    expect((calls[1]!.args[0] as ReplyTarget).eventId).toBeUndefined();
  });

  it('openStream 解析出 msgId 后再交给 SDK', async () => {
    const { bot, calls } = makeBot();
    const store = makeStore();
    createReplyAwareBot(bot, store);
    store.recordMessage('c2c', 'u1', 'm1');

    bot.openStream({ target });
    expect(calls[0]!.method).toBe('openStream');
    expect((calls[0]!.args[0] as { target: ReplyTarget }).target.msgId).toBe('m1');
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
