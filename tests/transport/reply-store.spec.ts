import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReplyStore } from '../../src/transport/reply-store.ts';
import type { Logger } from '../../src/types.ts';

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

  it('forget 清掉该 target 的凭证，之后解析降级为主动推送', () => {
    const { store } = tempStore();
    store.recordMessage('c2c', 'u1', 'm1');
    expect(store.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBe('m1');
    store.forget({ scope: 'c2c', targetId: 'u1' });
    expect(store.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBeUndefined();
  });

  it('用量按需合并落盘，flush 之后才可见', () => {
    const { store, file } = tempStore();
    store.recordMessage('c2c', 'u1', 'm1');
    // 合并窗口内不落盘：消息路径上不做同步全量读写
    expect(() => readFileSync(file, 'utf8')).toThrow();
    store.flush();
    const disk = JSON.parse(readFileSync(file, 'utf8')) as { targets: Record<string, { ids: { id: string }[] }> };
    expect(Object.values(disk.targets)[0]!.ids.map((item) => item.id)).toEqual(['m1']);
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
    let now = 1_000_000;
    // limit=1：先用掉唯一一条 msg 用量，才能验证「只剩 event 时只有 allowEvent 能用它」
    const { store, file } = tempStore({ now: () => now, limit: 1 });
    store.recordMessage('c2c', 'u1', 'm1');
    now += 1_000;
    store.recordEvent('c2c', 'u1', 'evt-1');
    const msgOnly = store.resolve({ scope: 'c2c', targetId: 'u1' }, false);
    expect(msgOnly.msgId).toBe('m1');
    expect(msgOnly.eventId).toBeUndefined();
    // msg 已用满，event 仍不允许 → 没有可用凭证
    expect(store.resolve({ scope: 'c2c', targetId: 'u1' }, false).eventId).toBeUndefined();
    const withEvent = store.resolve({ scope: 'c2c', targetId: 'u1' }, true);
    expect(withEvent.eventId).toBe('INTERACTION_CREATE:evt-1');
    expect(withEvent.msgId).toBeUndefined();
    expect(withEvent.msgSeq).toBe(1);
    // 内存里只有 event，落盘文件不会出现它
    store.flush();
    const disk = JSON.parse(readFileSync(file, 'utf8')) as { targets: Record<string, unknown> };
    expect(JSON.stringify(disk)).not.toContain('evt-1');
  });

  it('同一次互动连回多条时 msg_seq 递增', () => {
    const { store } = tempStore();
    store.recordEvent('c2c', 'u1', 'evt-1');
    expect(store.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgSeq).toBe(1);
    // 平台按 (event_id, msg_seq) 去重，第二次必须换 seq
    expect(store.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgSeq).toBe(2);
  });

  it('msgId 与用量一起落盘，重启后继续生效', () => {
    let now = 2_000_000;
    const first = tempStore({ now: () => now });
    first.store.recordMessage('c2c', 'u1', 'm1');
    for (let i = 0; i < 2; i += 1) first.store.resolve({ scope: 'c2c', targetId: 'u1' }, true);
    first.store.flush();

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
    first.store.flush();

    now += 31 * 60 * 1000;
    const second = new ReplyStore({ appId: 'app1', logger, file: first.file, now: () => now });
    expect(second.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBeUndefined();
  });

  it('不同 appId 互不串用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reply-store-'));
    const file = join(dir, 'reply-ids.json');
    const a = new ReplyStore({ appId: 'appA', logger, file });
    a.recordMessage('c2c', 'u1', 'm1');
    a.flush();
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
    store.flush();
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

  it('离线的旧消息被重推也不会续命（窗口按原始消息时间算）', () => {
    let now = 4_000_000;
    const { store } = tempStore({ now: () => now });
    store.recordMessage('c2c', 'u1', 'm1');
    now += 20 * 60 * 1000;
    // RESUME 补发 / 平台重推：同一条消息带的是原来的 timestamp
    store.recordMessage('c2c', 'u1', 'm1', now - 20 * 60 * 1000);
    now += 11 * 60 * 1000; // 距原消息 31 分钟，超出 TTL
    expect(store.resolve({ scope: 'c2c', targetId: 'u1' }, true).msgId).toBeUndefined();
  });
});
