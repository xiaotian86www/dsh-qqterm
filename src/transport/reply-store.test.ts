import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReplyStore } from './reply-store.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function tempStore(options: {
  file?: string;
  appId?: string;
  now?: () => number;
  limit?: number;
} = {}): { store: ReplyStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'reply-store-'));
  const file = options.file ?? join(dir, 'reply-ids.json');
  const store = new ReplyStore({
    appId: options.appId ?? 'app1',
    logger,
    file,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  return { store, file };
}

describe('ReplyStore', () => {
  it('返回最近收到的 msgId，并记录用量', () => {
    const { store } = tempStore();
    store.recordMessage('c2c', 'u1', 'm1');
    store.recordMessage('c2c', 'u1', 'm2');
    const first = store.resolve({ scope: 'c2c', targetId: 'u1' }, true);
    expect(first.msgId).toBe('m2');
    expect(first.eventId).toBeUndefined();
    const second = store.resolve({ scope: 'c2c', targetId: 'u1' }, true);
    expect(second.msgId).toBe('m2');
  });

  it('用满后回退到更早的候选', () => {
    const { store } = tempStore({ limit: 1 });
    store.recordMessage('c2c', 'u1', 'm1');
    store.recordMessage('c2c', 'u1', 'm2');
    expect(store.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBe('m2');
    expect(store.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBe('m1');
    expect(store.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBeUndefined();
  });

  it('canReply 只看可用性，不消耗用量', () => {
    const { store } = tempStore({ limit: 1 });
    store.recordMessage('c2c', 'u1', 'm1');
    expect(store.canReply({ scope: 'c2c', targetId: 'u1' })).toBe(true);
    expect(store.canReply({ scope: 'c2c', targetId: 'u1' })).toBe(true);
    // 两次查询之后仍能真正用一次
    expect(store.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBe('m1');
    expect(store.canReply({ scope: 'c2c', targetId: 'u1' })).toBe(false);
  });

  it('超过平台窗口的候选不再参与（并回退到更新的候选）', () => {
    let now = 1_000_000;
    const { store } = tempStore({ now: () => now });
    store.recordMessage('c2c', 'u1', 'stale');
    now += 31 * 60 * 1000;
    store.recordMessage('c2c', 'u1', 'fresh');
    const result = store.resolve({ scope: 'c2c', targetId: 'u1' }, true);
    expect(result.msgId).toBe('fresh');
  });

  it('每个 target 只保留最近 3 条', () => {
    const { store } = tempStore({ limit: 1 });
    for (const id of ['m1', 'm2', 'm3', 'm4']) store.recordMessage('c2c', 'u1', id);
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const resolved = store.resolve({ scope: 'c2c', targetId: 'u1' }, true);
      if (resolved.msgId !== undefined) seen.push(resolved.msgId);
    }
    expect(seen).toEqual(['m4', 'm3', 'm2']);
  });

  it('event 只在 allowEvent 时参与，且不落盘', () => {
    const { store, file } = tempStore();
    store.recordEvent('c2c', 'u1', 'evt-1');
    store.recordMessage('c2c', 'u1', 'm1');
    expect(store.resolve({ scope: 'c2c', targetId: 'u1' }, false).eventId).toBeUndefined();
    const withEvent = store.resolve({ scope: 'c2c', targetId: 'u1' }, true);
    expect(withEvent.eventId).toBe('INTERACTION_CREATE:evt-1');
    expect(withEvent.msgId).toBeUndefined();
    // 内存里只有 event，落盘文件不会出现它
    const disk = JSON.parse(readFileSync(file, 'utf8')) as { targets: Record<string, unknown> };
    expect(JSON.stringify(disk)).not.toContain('evt-1');
  });

  it('msgId 与用量一起落盘，重启后继续生效', () => {
    let now = 2_000_000;
    const first = tempStore({ now: () => now });
    first.store.recordMessage('c2c', 'u1', 'm1');
    for (let i = 0; i < 2; i += 1) first.store.resolve({ scope: 'c2c', targetId: 'u1' }, true);

    now += 60_000;
    const second = new ReplyStore({
      appId: 'app1',
      logger,
      file: first.file,
      limit: 4,
      now: () => now,
    });
    // 用量 2 已从磁盘恢复：还能用 2 次
    expect(second.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBe('m1');
    expect(second.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBe('m1');
    expect(second.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBeUndefined();
  });

  it('载入时丢弃过期条目', () => {
    let now = 3_000_000;
    const first = tempStore({ now: () => now });
    first.store.recordMessage('c2c', 'u1', 'm1');

    now += 31 * 60 * 1000;
    const second = new ReplyStore({ appId: 'app1', logger, file: first.file, now: () => now });
    expect(second.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBeUndefined();
  });

  it('不同 appId 互不串用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reply-store-'));
    const file = join(dir, 'reply-ids.json');
    const a = new ReplyStore({ appId: 'appA', logger, file });
    a.recordMessage('c2c', 'u1', 'm1');
    const b = new ReplyStore({ appId: 'appB', logger, file });
    expect(b.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBeUndefined();
    expect(a.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBe('m1');
  });

  it('文件损坏时按空处理，不影响启动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reply-store-'));
    const file = join(dir, 'reply-ids.json');
    writeFileSync(file, '{not json', 'utf8');
    const store = new ReplyStore({ appId: 'app1', logger, file });
    expect(store.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBeUndefined();
    store.recordMessage('c2c', 'u1', 'm1');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('重复记录同一条消息不重置用量', () => {
    const { store } = tempStore({ limit: 2 });
    store.recordMessage('c2c', 'u1', 'm1');
    store.resolve({ scope: 'c2c', targetId: 'u1' }, true);
    store.recordMessage('c2c', 'u1', 'm1');
    store.resolve({ scope: 'c2c', targetId: 'u1' }, true);
    expect(store.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBeUndefined();
  });
});
