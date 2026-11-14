/**
 * 热重载能力单测：hmr 可选、先写状态后调度、结果落盘、ready 播报一次
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReloader } from '../../src/reload/index.ts';
import { readReloadState } from '../../src/reload/state.ts';
import type { Logger } from '../../src/types.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const dirs: string[] = [];

function statePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qqterm-reload-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

function fakeContext(services: Record<string, unknown>, loader?: unknown): Context {
  return {
    get: (name: string) => (name === 'loader' ? loader : services[name]),
  } as unknown as Context;
}

/**
 * loader 替身：entries() 每次调用时读当前 uid，用来模拟「本插件被换掉 / 没换掉」。
 * uid 用数字，跟 Cordis 真实分配的一致（按字符串判会一个都收不到）。
 */
function fakeLoader(current: () => number): {
  entries: () => { options: { id: string }; fiber: { uid: number } }[];
} {
  return { entries: () => [{ options: { id: 'qqterm' }, fiber: { uid: current() } }] };
}

function fakeBot(): QQBot & { sendMarkdown: ReturnType<typeof vi.fn> } {
  return { sendMarkdown: vi.fn(async () => ({})) } as unknown as QQBot & {
    sendMarkdown: ReturnType<typeof vi.fn>;
  };
}

function fakeHmr(result: { restartReason?: string } = {}): {
  runExclusive: ReturnType<typeof vi.fn>;
  reconcileProfile: ReturnType<typeof vi.fn>;
} {
  return {
    reconcileProfile: vi.fn(async () => result),
    runExclusive: vi.fn(async (op: () => Promise<unknown>) => await op()),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createReloader', () => {
  it('hmr 缺失时 available=false，run 不调度任何重载', async () => {
    const path = statePath();
    const reloader = createReloader(fakeContext({}), logger, { statePath: path });
    expect(reloader.available).toBe(false);

    reloader.run({ targetId: 'u1' });
    await vi.advanceTimersByTimeAsync(500);

    expect(readReloadState(path)).toMatchObject({ notify: { targetId: 'u1' } });
    expect(readReloadState(path)?.phase).toBeUndefined();
  });

  it('hmr 晚于 apply 注册时，available 随之变为 true 且能重载', async () => {
    const path = statePath();
    const services: Record<string, unknown> = {};
    const reloader = createReloader(fakeContext(services), logger, { statePath: path });
    expect(reloader.available).toBe(false);

    const hmr = fakeHmr();
    services.hmr = hmr;
    expect(reloader.available).toBe(true);

    reloader.run();
    await vi.advanceTimersByTimeAsync(300);
    expect(hmr.reconcileProfile).toHaveBeenCalledTimes(1);
    expect(readReloadState(path)?.phase).toBe('done');
  });

  it('run 先写待补发记录，延迟后再调 reconcileProfile 并落 done', async () => {
    const path = statePath();
    const hmr = fakeHmr();
    const reloader = createReloader(fakeContext({ hmr }), logger, { statePath: path });
    expect(reloader.available).toBe(true);

    reloader.run({ targetId: 'u1' });
    expect(readReloadState(path)).toMatchObject({
      notify: { targetId: 'u1' },
    });
    expect(readReloadState(path)?.phase).toBeUndefined();

    await vi.advanceTimersByTimeAsync(100);
    expect(hmr.reconcileProfile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(hmr.runExclusive).toHaveBeenCalledTimes(1);
    expect(hmr.reconcileProfile).toHaveBeenCalledTimes(1);
    expect(readReloadState(path)).toMatchObject({
      phase: 'done',
      notify: { targetId: 'u1' },
    });
  });

  it('restartReason 落盘，describe 提示需要重启', async () => {
    const path = statePath();
    const reloader = createReloader(
      fakeContext({ hmr: fakeHmr({ restartReason: 'package-moved' }) }),
      logger,
      { statePath: path },
    );

    reloader.run();
    await vi.advanceTimersByTimeAsync(300);

    expect(readReloadState(path)?.restartReason).toBe('package-moved');
    expect(reloader.describe()).toContain('⚠️');
  });

  it('上一轮重载装进来的实例也能再重载一次（上下文残留 executing=true）', async () => {
    const path = statePath();
    let nested = true;
    const hmr = {
      executing: {
        exit: (fn: () => unknown) => {
          const previous = nested;
          nested = false;
          try {
            return fn();
          } finally {
            nested = previous;
          }
        },
      },
      runExclusive: vi.fn(async (op: () => Promise<unknown>) => {
        if (nested) throw new Error('HMR transactions cannot be nested');
        return await op();
      }),
      reconcileProfile: vi.fn(async () => ({})),
    };
    const reloader = createReloader(fakeContext({ hmr }), logger, { statePath: path });

    reloader.run({ targetId: 'u1' });
    await vi.advanceTimersByTimeAsync(300);

    expect(hmr.reconcileProfile).toHaveBeenCalledTimes(1);
    expect(readReloadState(path)?.phase).toBe('done');
  });

  it('拿不到 executing 时，撞上嵌套就直接调 reconcileProfile', async () => {
    const path = statePath();
    const hmr = {
      runExclusive: vi.fn(async () => {
        throw new Error('HMR transactions cannot be nested');
      }),
      reconcileProfile: vi.fn(async () => ({})),
    };
    const reloader = createReloader(fakeContext({ hmr }), logger, { statePath: path });

    reloader.run({ targetId: 'u1' });
    await vi.advanceTimersByTimeAsync(300);

    expect(hmr.reconcileProfile).toHaveBeenCalledTimes(1);
    expect(readReloadState(path)?.phase).toBe('done');
  });

  it('reconcileProfile 抛错时落 failed 并记 warn', async () => {
    const path = statePath();
    const hmr = {
      runExclusive: vi.fn(async (op: () => Promise<unknown>) => await op()),
      reconcileProfile: vi.fn(async () => {
        throw new Error('activation failed');
      }),
    };
    const reloader = createReloader(fakeContext({ hmr }), logger, { statePath: path });

    reloader.run({ targetId: 'u1' });
    await vi.advanceTimersByTimeAsync(300);

    expect(readReloadState(path)).toMatchObject({ phase: 'failed', error: 'activation failed' });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('describe 无记录时返回 undefined', () => {
    const reloader = createReloader(fakeContext({}), logger, { statePath: statePath() });
    expect(reloader.describe()).toBeUndefined();
  });

  it('本插件没被替换时，当前实例自己补发结果，并说明没有任何变更', async () => {
    const path = statePath();
    const bot = fakeBot();
    const ctx = fakeContext({ hmr: fakeHmr() }, fakeLoader(() => 7));
    const reloader = createReloader(ctx, logger, { statePath: path });

    reloader.run({ targetId: 'u1' }, bot);
    await vi.advanceTimersByTimeAsync(300);

    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1);
    expect(bot.sendMarkdown.mock.calls[0]?.[0]).toEqual({ scope: 'c2c', targetId: 'u1' });
    expect(bot.sendMarkdown.mock.calls[0]?.[1]).toBe('✅ 没有需要应用的变更');
    expect(readReloadState(path)?.notify).toBeUndefined();
  });

  it('换了别的插件时列出被替换的 entry，本插件仍自己补发', async () => {
    const path = statePath();
    const bot = fakeBot();
    let otherUid = 11;
    const loader = {
      entries: () => [
        { options: { id: 'qqterm' }, fiber: { uid: 10 } },
        { options: { id: 'other-plugin' }, fiber: { uid: otherUid } },
      ],
    };
    const hmr = {
      runExclusive: vi.fn(async (op: () => Promise<unknown>) => await op()),
      reconcileProfile: vi.fn(async () => {
        otherUid = 12;
        return {};
      }),
    };
    const reloader = createReloader(fakeContext({ hmr }, loader), logger, { statePath: path });

    reloader.run({ targetId: 'u1' }, bot);
    await vi.advanceTimersByTimeAsync(300);

    expect(bot.sendMarkdown.mock.calls[0]?.[1]).toBe('✅ 已应用变更: other-plugin');
    expect(readReloadState(path)?.replaced).toEqual(['other-plugin']);
  });

  it('本插件被替换时不补发，留给新 fiber 的 ready', async () => {
    const path = statePath();
    const bot = fakeBot();
    let uid = 21;
    const hmr = {
      runExclusive: vi.fn(async (op: () => Promise<unknown>) => await op()),
      reconcileProfile: vi.fn(async () => {
        uid = 22;
        return {};
      }),
    };
    const reloader = createReloader(fakeContext({ hmr }, fakeLoader(() => uid)), logger, { statePath: path });

    reloader.run({ targetId: 'u1' }, bot);
    await vi.advanceTimersByTimeAsync(300);

    expect(bot.sendMarkdown).not.toHaveBeenCalled();
    expect(readReloadState(path)?.notify).toEqual({ targetId: 'u1' });
  });

  it('loader 一个条目都读不出时退回兜底文案，不谎报「没有变更」', async () => {
    const path = statePath();
    const bot = fakeBot();
    const loader = { entries: () => [] as { options: { id: string }; fiber: { uid: number } }[] };
    const reloader = createReloader(fakeContext({ hmr: fakeHmr() }, loader), logger, { statePath: path });

    reloader.run({ targetId: 'u1' }, bot);
    await vi.advanceTimersByTimeAsync(300);

    expect(bot.sendMarkdown.mock.calls[0]?.[1]).toBe('✅ 已应用变更');
    expect(readReloadState(path)?.replaced).toBeUndefined();
  });
});

describe('announce', () => {
  it('成功结果只播报一次，并清掉 notify', async () => {
    const path = statePath();
    const bot = fakeBot();
    const reloader = createReloader(fakeContext({ hmr: fakeHmr() }), logger, { statePath: path });

    reloader.run({ targetId: 'u1' });
    await vi.advanceTimersByTimeAsync(300);

    await reloader.announce(bot);
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1);
    expect(bot.sendMarkdown.mock.calls[0]?.[1]).toContain('✅');
    expect(readReloadState(path)?.notify).toBeUndefined();

    // 第二次（例如重连再次 ready）不再重复播报
    await reloader.announce(bot);
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1);
  });

  it('需要重启时播报警告文案', async () => {
    const path = statePath();
    const bot = fakeBot();
    const reloader = createReloader(
      fakeContext({ hmr: fakeHmr({ restartReason: 'module-comparison' }) }),
      logger,
      { statePath: path },
    );

    reloader.run({ targetId: 'u1' });
    await vi.advanceTimersByTimeAsync(300);
    await reloader.announce(bot);

    expect(bot.sendMarkdown.mock.calls[0]?.[1]).toContain('⚠️');
  });

  it('失败结果播报原因与下一步', async () => {
    const path = statePath();
    const bot = fakeBot();
    const hmr = {
      runExclusive: vi.fn(async (op: () => Promise<unknown>) => await op()),
      reconcileProfile: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const reloader = createReloader(fakeContext({ hmr }), logger, { statePath: path });

    reloader.run({ targetId: 'u1' });
    await vi.advanceTimersByTimeAsync(300);
    await reloader.announce(bot);

    const text = bot.sendMarkdown.mock.calls[0]?.[1] as string;
    expect(text).toContain('❌');
    expect(text).toContain('重启 dsh 恢复');
  });

  it('没有 notify 时不发送', async () => {
    const path = statePath();
    const bot = fakeBot();
    const reloader = createReloader(fakeContext({ hmr: fakeHmr() }), logger, { statePath: path });

    await reloader.announce(bot);
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('陈旧记录不再播报', async () => {
    const path = statePath();
    const bot = fakeBot();
    const reloader = createReloader(fakeContext({ hmr: fakeHmr() }), logger, { statePath: path });

    reloader.run({ targetId: 'u1' });
    await vi.advanceTimersByTimeAsync(300);
    // 把开始时间改成 20 分钟前，模拟「隔了很久才重启」
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await reloader.announce(bot);

    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('结论还没落盘时连上先不发，留给下一次命令前的补发', async () => {
    const path = statePath();
    const bot = fakeBot();
    // reconcile 卡住不返回：状态一直停在「有 notify、没结论」
    const hmr = { runExclusive: vi.fn(() => new Promise<never>(() => {})), reconcileProfile: vi.fn() };
    const reloader = createReloader(fakeContext({ hmr }), logger, { statePath: path });

    reloader.run({ targetId: 'u1' }); // 还没到调度时间
    await reloader.announce(bot);
    await vi.advanceTimersByTimeAsync(6_000);
    await reloader.announce(bot);

    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('连发两次重载时，第二轮不会顶掉第一轮的结果', async () => {
    const path = statePath();
    const bot = fakeBot();
    // 本插件每轮都被替换：结果只能落盘，等新 fiber 的 ready 补发
    let uid = 31;
    const hmr = {
      runExclusive: vi.fn(async (op: () => Promise<unknown>) => await op()),
      reconcileProfile: vi.fn(async () => {
        uid += 1;
        return {};
      }),
    };
    const reloader = createReloader(fakeContext({ hmr }, fakeLoader(() => uid)), logger, { statePath: path });

    reloader.run({ targetId: 'u1' });
    await vi.advanceTimersByTimeAsync(300);
    expect(readReloadState(path)?.notify).toEqual({ targetId: 'u1' });

    // 第二条 /plugins reload 到达：命令先补发上一轮，再开始新一轮
    await reloader.announce(bot);
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1);
    expect(readReloadState(path)?.notify).toBeUndefined();

    reloader.run({ targetId: 'u1' });
    await vi.advanceTimersByTimeAsync(300);
    await reloader.announce(bot);
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(2);
  });

  it('同一轮结果不会被补发两次', async () => {
    const path = statePath();
    let release: (value: unknown) => void = () => {};
    const bot = {
      sendMarkdown: vi.fn(
        () => new Promise((resolve) => {
          release = resolve;
        }),
      ),
    } as unknown as QQBot & { sendMarkdown: ReturnType<typeof vi.fn> };
    let uid = 41;
    const hmr = {
      runExclusive: vi.fn(async (op: () => Promise<unknown>) => await op()),
      reconcileProfile: vi.fn(async () => {
        uid = 42;
        return {};
      }),
    };
    const reloader = createReloader(fakeContext({ hmr }, fakeLoader(() => uid)), logger, { statePath: path });
    reloader.run({ targetId: 'u1' });
    await vi.advanceTimersByTimeAsync(300);

    // ready 补发与「下次命令前补发」同时到达
    const first = reloader.announce(bot);
    const second = reloader.announce(bot);
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1);

    release({});
    await first;
    await second;
    expect(readReloadState(path)?.notify).toBeUndefined();
  });
});
