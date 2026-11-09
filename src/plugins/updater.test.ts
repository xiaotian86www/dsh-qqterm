/**
 * 后台更新检查单测：启动延迟、周期、卸载清理、失败只记日志
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '../types.ts';
import type { PluginInstaller } from './index.ts';
import { CHECK_DELAY_MS, CHECK_INTERVAL_MS, startUpdateCheck } from './updater.ts';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

/** 只保留 effect 的 ctx 桩：拿到清理函数，模拟插件卸载 */
function fakeCtx(): { ctx: Context; dispose: () => void } {
  let cleanup: (() => void) | undefined;
  const ctx = {
    effect: (fn: () => (() => void) | void) => {
      cleanup = (fn() as (() => void) | undefined) ?? undefined;
    },
  } as unknown as Context;
  return { ctx, dispose: () => cleanup?.() };
}

const installerWith = (check: () => Promise<void>): PluginInstaller =>
  ({ checkUpdates: check }) as unknown as PluginInstaller;

describe('startUpdateCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(logger.warn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('启动两分钟后查一次，之后每六小时一次', async () => {
    const checkUpdates = vi.fn(async () => {});
    const { ctx } = fakeCtx();
    startUpdateCheck(ctx, installerWith(checkUpdates), logger);

    expect(checkUpdates).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(checkUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(checkUpdates).toHaveBeenCalledTimes(2);
  });

  it('插件卸载后不再检查', async () => {
    const checkUpdates = vi.fn(async () => {});
    const { ctx, dispose } = fakeCtx();
    startUpdateCheck(ctx, installerWith(checkUpdates), logger);

    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    dispose();

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(checkUpdates).toHaveBeenCalledTimes(1);
  });

  it('检查失败只记 warn，不抛到宿主', async () => {
    const { ctx } = fakeCtx();
    startUpdateCheck(ctx, installerWith(async () => {
      throw new Error('boom');
    }), logger);

    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
