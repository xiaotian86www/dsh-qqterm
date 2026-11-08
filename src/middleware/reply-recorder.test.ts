import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { describe, expect, it } from 'vitest';
import { replyRecorder } from './reply-recorder.ts';
import { ReplyStore } from '../transport/reply-store.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeStore(): ReplyStore {
  const dir = mkdtempSync(join(tmpdir(), 'reply-recorder-'));
  return new ReplyStore({ appId: 'app1', logger, file: join(dir, 'reply-ids.json') });
}

function context(msgId: string | undefined): MiddlewareContext {
  return {
    replyTarget: { scope: 'c2c', targetId: 'u1', msgId },
  } as unknown as MiddlewareContext;
}

describe('replyRecorder', () => {
  it('登记 msgId 后继续调用下一个中间件', async () => {
    const store = makeStore();
    let called = false;
    await replyRecorder(store)(context('m1'), async () => {
      called = true;
    });

    expect(called).toBe(true);
    expect(store.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBe('m1');
  });

  it('没有 msgId 的消息不记坏条目', async () => {
    const store = makeStore();
    await replyRecorder(store)(context(undefined), async () => {});

    expect(store.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBeUndefined();
  });
});
