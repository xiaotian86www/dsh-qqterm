import { describe, it, expect, vi } from 'vitest';
import { Outbox, classifyDeliveryError } from '../../src/transport/outbox.ts';
import type { Logger } from '../../src/types.ts';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function failure(status: number): Error & { status: number } {
  return Object.assign(new Error(`http ${status}`), { status });
}

describe('classifyDeliveryError', () => {
  it('401 / 403 是渠道级失效，不重试', () => {
    expect(classifyDeliveryError(failure(401))).toBe('auth');
    expect(classifyDeliveryError(failure(403))).toBe('auth');
  });

  it('网络错误与 5xx / 429 是暂不可用', () => {
    expect(classifyDeliveryError(Object.assign(new Error('boom'), { code: 'ECONNRESET' }))).toBe('transient');
    expect(classifyDeliveryError(failure(503))).toBe('transient');
    expect(classifyDeliveryError(failure(429))).toBe('transient');
  });

  it('超长与内容违规是内容类失败', () => {
    // 真实失败长这样：HTTP 400 + err_code，SDK 包成 ApiError(httpStatus, bizCode)
    expect(classifyDeliveryError(Object.assign(new Error('invalid request'), { httpStatus: 400, bizCode: 40054007 }))).toBe('too-long');
    expect(classifyDeliveryError(Object.assign(new Error('invalid request'), { httpStatus: 400, bizCode: 40034006 }))).toBe('blocked');
    expect(classifyDeliveryError(new Error('message too long'))).toBe('too-long');
    expect(classifyDeliveryError(new Error('sensitive content detected'))).toBe('blocked');
  });

  it('机器人已下线是渠道级失效', () => {
    expect(classifyDeliveryError(Object.assign(new Error('robot offline'), { httpStatus: 400, bizCode: 40054016 }))).toBe('auth');
  });

  it('认不出的错误按暂不可用处理（宁可多试一次）', () => {
    expect(classifyDeliveryError(new Error('unknown'))).toBe('transient');
  });
});

describe('Outbox', () => {
  it('暂不可用时立刻重试一次，成功就返回 sent', async () => {
    const logger = createLogger();
    const outbox = new Outbox({ logger });
    const run = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(undefined);

    await expect(outbox.deliver('s1', 'sendMarkdown', run)).resolves.toBe('sent');
    expect(run).toHaveBeenCalledTimes(2);
    expect(outbox.hasPending()).toBe(false);
  });

  it('两次都失败就入队，等信号再补发', async () => {
    const logger = createLogger();
    const outbox = new Outbox({ logger });
    const run = vi.fn().mockRejectedValue(new Error('timeout'));

    await expect(outbox.deliver('s1', 'sendMarkdown', run)).resolves.toBe('queued');
    expect(run).toHaveBeenCalledTimes(2);
    expect(outbox.hasPending('s1')).toBe(true);

    run.mockResolvedValue(undefined);
    await outbox.flush();
    expect(outbox.hasPending()).toBe(false);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('队伍非空时后续消息直接排队，恢复后按原顺序补发', async () => {
    const logger = createLogger();
    const order: string[] = [];
    let down = true;
    const outbox = new Outbox({ logger });
    const send = (label: string) => async (): Promise<void> => {
      if (down) throw new Error('timeout');
      order.push(label);
    };

    await outbox.deliver('s1', 'a', send('a'));
    await outbox.deliver('s1', 'b', send('b'));
    await outbox.deliver('s1', 'c', send('c'));
    expect(order).toEqual([]);
    expect(outbox.pendingCount()).toBe(3);

    down = false;
    await outbox.flush();
    expect(order).toEqual(['a', 'b', 'c']);
    expect(outbox.hasPending()).toBe(false);
  });

  it('flush 遇到仍不可用就停在队首，不丢消息', async () => {
    const logger = createLogger();
    const outbox = new Outbox({ logger });
    await outbox.deliver('s1', 'sendMarkdown', async () => { throw new Error('timeout'); });
    await outbox.deliver('s1', 'sendMarkdown', async () => { throw new Error('timeout'); });

    await outbox.flush();
    expect(outbox.pendingCount()).toBe(2);
  });

  it('鉴权失败清空队列并通知渠道失效', async () => {
    const logger = createLogger();
    const broken = vi.fn();
    const outbox = new Outbox({ logger, onChannelBroken: broken });
    const authError = Object.assign(new Error('unauthorized'), { status: 401 });
    const flip = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValue(authError);
    await outbox.deliver('s1', 'sendMarkdown', flip);
    expect(outbox.hasPending()).toBe(true);

    // flush 时队首撞上 401：整条渠道失效，队列清空并通知
    await outbox.flush();
    expect(broken).toHaveBeenCalledTimes(1);
    expect(outbox.hasPending()).toBe(false);
  });

  it('内容类失败不入队，原样交给调用方降级', async () => {
    const logger = createLogger();
    const outbox = new Outbox({ logger });
    const run = vi.fn(async () => { throw new Error('message too long'); });

    await expect(outbox.deliver('s1', 'sendMarkdown', run)).resolves.toBe('too-long');
    expect(run).toHaveBeenCalledTimes(1);
    expect(outbox.hasPending()).toBe(false);
  });
});
