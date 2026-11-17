import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettledWatch } from '../../src/shared/state-watch.ts';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

interface State {
  startedAt: number;
  phase?: string;
  notify?: { targetId: string };
}

/** 状态文件的替身：测试里直接改 value */
function file(initial: State | undefined) {
  const box = { value: initial };
  return {
    box,
    read: () => box.value,
    write: (state: State) => {
      box.value = state;
    },
  };
}

describe('createSettledWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('结论落盘后补发一次', async () => {
    const store = file({ startedAt: 100 });
    const deliver = vi.fn(async () => {});
    const watch = createSettledWatch<State>({
      pollMs: 2_000,
      staleMs: 600_000,
      read: store.read,
      write: store.write,
      expire: (state) => ({ ...state, phase: 'failed' }),
      logger,
    });

    watch(100, deliver);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deliver).not.toHaveBeenCalled();

    store.box.value = { startedAt: 100, phase: 'done' };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({ phase: 'done' });

    // 已经送过：后续再 tick 也不会重复
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('同时只跑一条链，重复调用直接让位', async () => {
    const store = file({ startedAt: 1 });
    const deliver = vi.fn(async () => {});
    const watch = createSettledWatch<State>({
      pollMs: 1_000,
      staleMs: 600_000,
      read: store.read,
      write: store.write,
      expire: (state) => ({ ...state, phase: 'failed' }),
      logger,
    });

    watch(1, deliver);
    watch(1, deliver);
    store.box.value = { startedAt: 1, phase: 'done' };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('换了新一轮就让位，不播报别人那一轮', async () => {
    const store = file({ startedAt: 1 });
    const deliver = vi.fn(async () => {});
    const watch = createSettledWatch<State>({
      pollMs: 1_000,
      staleMs: 600_000,
      read: store.read,
      write: store.write,
      expire: (state) => ({ ...state, phase: 'failed' }),
      logger,
    });

    watch(1, deliver);
    store.box.value = { startedAt: 2, phase: 'done' };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deliver).not.toHaveBeenCalled();
    expect(store.box.value?.phase).toBe('done');
  });

  it('超过陈旧线仍未落盘：按失败收尾并播报', async () => {
    const store = file({ startedAt: 100 });
    const deliver = vi.fn(async () => {});
    const watch = createSettledWatch<State>({
      pollMs: 1_000,
      staleMs: 3_000,
      read: store.read,
      write: store.write,
      expire: (state) => ({ ...state, phase: 'failed' }),
      logger,
    });

    watch(100, deliver);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(store.box.value?.phase).toBe('failed');
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
