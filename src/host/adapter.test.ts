import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHostAdapter, _resetAdapterCache } from './adapter.ts';

/** 最小 ctx：可控的 get() */
function makeCtx(services: Record<string, unknown>) {
  return {
    get: (name: string) => {
      if (!(name in services)) throw new Error(`cannot get property "${name}" without inject`);
      return services[name];
    },
  } as never;
}

describe('host adapter', () => {
  beforeEach(() => {
    _resetAdapterCache();
    vi.unstubAllGlobals();
  });

  it('sessionEvents：新宿主 snapshotEvents() 优先', () => {
    const adapter = createHostAdapter(makeCtx({}));
    const events = [{ type: 'a', seq: 0 }];
    expect(adapter.sessionEvents({ snapshotEvents: () => events })).toBe(events);
  });

  it('sessionEvents：旧宿主 events getter 兜底', () => {
    const adapter = createHostAdapter(makeCtx({}));
    const events = [{ type: 'a', seq: 0 }];
    expect(adapter.sessionEvents({ events })).toEqual(events);
  });

  it('sessionEvents：两者皆无返回空数组（不抛）', () => {
    const adapter = createHostAdapter(makeCtx({}));
    expect(adapter.sessionEvents({})).toEqual([]);
  });

  it('serviceFor：旧宿主 presets 实例方法直接命中', async () => {
    const compaction = { compactNow: () => {} };
    const presets = { serviceFor: (agent: unknown, name: string) => (name === 'compaction' ? compaction : undefined) };
    const adapter = createHostAdapter(makeCtx({ agentPresets: presets }));
    expect(await adapter.serviceFor({ ctx: {} }, 'compaction')).toBe(compaction);
    expect(adapter.capabilities).toContain('serviceFor(presets实例方法)');
  });

  it('serviceFor：无实例方法时走动态模块函数', async () => {
    const compaction = { compactNow: () => {} };
    vi.doMock('@deepseek-ai/dsh-agent-presets', () => ({
      serviceForAgent: (_ctx: unknown, agent: unknown, name: string) =>
        name === 'compaction' ? compaction : undefined,
    }));
    const adapter = createHostAdapter(makeCtx({}));
    expect(await adapter.serviceFor({ ctx: {} }, 'compaction')).toBe(compaction);
  });

  it('globalService：未注册返回 undefined（不抛）', () => {
    const adapter = createHostAdapter(makeCtx({}));
    expect(adapter.globalService('compaction')).toBeUndefined();
  });

  it('globalService：已注册返回服务', () => {
    const compaction = { compactNow: () => {} };
    const adapter = createHostAdapter(makeCtx({ compaction }));
    expect(adapter.globalService('compaction')).toBe(compaction);
  });

  it('buildForkSeed：模块不可解析时返回 undefined（不抛）', async () => {
    const adapter = createHostAdapter(makeCtx({}));
    expect(await adapter.buildForkSeed([{ seq: 0 }], 0)).toBeUndefined();
  });

  it('sessionHeader：取 stat().header（agentPreset 在 header 顶层）', async () => {
    const header = { id: 's1', agentPreset: 'coder' };
    const adapter = createHostAdapter(makeCtx({ sessionPersistence: { stat: async () => ({ header }) } }));
    expect(await adapter.sessionHeader('s1')).toBe(header);
  });

  it('sessionHeader：会话不存在（stat → undefined）或读取失败均返回 undefined（不抛）', async () => {
    const absent = createHostAdapter(makeCtx({ sessionPersistence: { stat: async () => undefined } }));
    expect(await absent.sessionHeader('s1')).toBeUndefined();

    const failing = createHostAdapter(makeCtx({
      sessionPersistence: { stat: async () => { throw new Error('EIO'); } },
    }));
    expect(await failing.sessionHeader('s1')).toBeUndefined();
  });

  it('sessionExists：stat 返回快照 → true，返回 undefined → false', async () => {
    const present = createHostAdapter(makeCtx({ sessionPersistence: { stat: async () => ({ header: { id: 's1' } }) } }));
    expect(await present.sessionExists('s1')).toBe(true);

    const absent = createHostAdapter(makeCtx({ sessionPersistence: { stat: async () => undefined } }));
    expect(await absent.sessionExists('s1')).toBe(false);
  });

  it('sessionExists：后端故障照常抛出（求证失败 ≠ 不存在）', async () => {
    const adapter = createHostAdapter(makeCtx({
      sessionPersistence: { stat: async () => { throw new Error('EIO: backend unavailable'); } },
    }));
    await expect(adapter.sessionExists('s1')).rejects.toThrow(/EIO/);
  });

  it('sessionExists：服务未注册 → undefined', async () => {
    const adapter = createHostAdapter(makeCtx({}));
    expect(await adapter.sessionExists('s1')).toBeUndefined();
    expect(adapter.capabilities).toContain('sessionPersistence.stat(不可用，会话存在性判定降级)');
  });

  it('sessionExists：服务形态不含 stat → undefined，不让 TypeError 冒出', async () => {
    // 回归：此前按不存在的 load() 调用，TypeError 被当成「后端故障」，
    // 全新会话被误判为「可能存在」而拒绝创建，用户侧表现为处理消息异常
    const adapter = createHostAdapter(makeCtx({ sessionPersistence: { open: async () => ({}) } }));
    expect(await adapter.sessionExists('s1')).toBeUndefined();
    expect(await adapter.sessionHeader('s1')).toBeUndefined();
  });
});

describe('会话归档（workspaceRegistry）', () => {
  function makeRegistry(over: Record<string, unknown> = {}) {
    return {
      create: vi.fn(async () => ({ path: '/proj', attachSession: async () => {} })),
      archivedSessionIds: ['session-a'],
      archiveSession: vi.fn(async () => {}),
      unarchiveSession: vi.fn(async () => {}),
      ...over,
    };
  }

  it('archiveSession 带 stopActivity 调宿主（先停工作再写归档集）', async () => {
    const registry = makeRegistry();
    const adapter = createHostAdapter(makeCtx({ workspaceRegistry: registry }));

    expect(await adapter.archiveSession('session-x')).toEqual({ ok: true });
    expect(registry.archiveSession).toHaveBeenCalledWith('session-x', { stopActivity: true });
  });

  it('archivedSessionIds 返回 Set，未挂载时为空集（不抛）', () => {
    const mounted = createHostAdapter(makeCtx({ workspaceRegistry: makeRegistry() }));
    expect([...mounted.archivedSessionIds()]).toEqual(['session-a']);

    const bare = createHostAdapter(makeCtx({}));
    expect(bare.archivedSessionIds().size).toBe(0);
  });

  it('宿主没有归档接口时返回 unavailable', async () => {
    const adapter = createHostAdapter(makeCtx({ workspaceRegistry: makeRegistry({ archiveSession: undefined }) }));

    const outcome = await adapter.archiveSession('session-x');

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('unavailable');
  });

  it('未知会话 → not-found（按错误名识别，不依赖 instanceof）', async () => {
    const error = new Error('no such session');
    error.name = 'WorkspaceUnknownSessionError';
    const registry = makeRegistry({ archiveSession: vi.fn(async () => { throw error; }) });
    const adapter = createHostAdapter(makeCtx({ workspaceRegistry: registry }));

    const outcome = await adapter.archiveSession('session-x');

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('not-found');
  });

  it('会话仍活跃 → busy', async () => {
    const error = new Error('the session is active (generating)');
    error.name = 'WorkspaceActiveSessionError';
    const registry = makeRegistry({ archiveSession: vi.fn(async () => { throw error; }) });
    const adapter = createHostAdapter(makeCtx({ workspaceRegistry: registry }));

    const outcome = await adapter.archiveSession('session-x');

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('busy');
  });

  it('其它宿主错误 → failed，并保留原始文案', async () => {
    const registry = makeRegistry({ archiveSession: vi.fn(async () => { throw new Error('EIO'); }) });
    const adapter = createHostAdapter(makeCtx({ workspaceRegistry: registry }));

    const outcome = await adapter.archiveSession('session-x');

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('failed');
    expect(outcome.ok === false && outcome.message).toContain('EIO');
  });

  it('unarchiveSession 成功返回 ok，宿主缺失时 unavailable', async () => {
    const registry = makeRegistry();
    const adapter = createHostAdapter(makeCtx({ workspaceRegistry: registry }));
    expect(await adapter.unarchiveSession('session-x')).toEqual({ ok: true });
    expect(registry.unarchiveSession).toHaveBeenCalledWith('session-x');

    const bare = createHostAdapter(makeCtx({ workspaceRegistry: makeRegistry({ unarchiveSession: undefined }) }));
    const outcome = await bare.unarchiveSession('session-x');
    expect(outcome.ok === false && outcome.reason).toBe('unavailable');
  });

  it('能力摘要里记录归档接口是否可用', () => {
    const withArchive = createHostAdapter(makeCtx({ workspaceRegistry: makeRegistry() }));
    expect(withArchive.capabilities.join('\n')).toContain('workspaceRegistry.archiveSession(可用');

    const withoutArchive = createHostAdapter(makeCtx({}));
    expect(withoutArchive.capabilities.join('\n')).toContain('workspaceRegistry.archiveSession(不可用');
  });
});

describe('attachSessionToWorkspace', () => {
  function makeLogger() {
    return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  }

  it('把会话挂载到 cwd 对应的工作区（标题交给宿主按目录名生成）', async () => {
    const ws = { path: '/proj', title: 'proj', attachSession: vi.fn().mockResolvedValue(undefined) };
    const registry = { create: vi.fn().mockResolvedValue(ws) };
    const logger = makeLogger();
    const adapter = createHostAdapter(makeCtx({ workspaceRegistry: registry }), logger);

    await adapter.attachSessionToWorkspace('sess-1', '/proj');

    // 不再传自定义标题：宿主的自动标题 = 目录名
    expect(registry.create).toHaveBeenCalledWith('/proj');
    expect(ws.attachSession).toHaveBeenCalledWith('sess-1');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('旧的硬编码标题 QQBot 就地迁移成目录名', async () => {
    const ws = {
      path: 'D:\\thirdparty\\dsh-qqbot',
      title: 'QQBot',
      attachSession: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
    };
    const registry = { create: vi.fn().mockResolvedValue(ws) };
    const adapter = createHostAdapter(makeCtx({ workspaceRegistry: registry }));

    await adapter.attachSessionToWorkspace('sess-1', 'D:\\thirdparty\\dsh-qqbot');

    expect(ws.setTitle).toHaveBeenCalledWith('dsh-qqbot');
    expect(ws.attachSession).toHaveBeenCalledWith('sess-1');
  });

  it('用户自己改过的工作区标题不动', async () => {
    const ws = {
      path: 'D:\\thirdparty\\dsh-qqbot',
      title: '我的项目',
      attachSession: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
    };
    const registry = { create: vi.fn().mockResolvedValue(ws) };
    const adapter = createHostAdapter(makeCtx({ workspaceRegistry: registry }));

    await adapter.attachSessionToWorkspace('sess-1', 'D:\\thirdparty\\dsh-qqbot');

    expect(ws.setTitle).not.toHaveBeenCalled();
  });

  it('workspaceRegistry 未挂载时静默降级（debug，不 warn）', async () => {
    const logger = makeLogger();
    const adapter = createHostAdapter(makeCtx({}), logger);

    await expect(adapter.attachSessionToWorkspace('sess-1', '/proj')).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('registry 无可用 create() 时静默降级', async () => {
    const logger = makeLogger();
    const adapter = createHostAdapter(makeCtx({ workspaceRegistry: {} }), logger);

    await expect(adapter.attachSessionToWorkspace('sess-1', '/proj')).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('create() 失败时吞掉异常并 warn', async () => {
    const logger = makeLogger();
    const registry = { create: vi.fn().mockRejectedValue(new Error('not a directory')) };
    const adapter = createHostAdapter(makeCtx({ workspaceRegistry: registry }), logger);

    await expect(adapter.attachSessionToWorkspace('sess-1', '/proj')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('attachSession() 失败时吞掉异常并 warn', async () => {
    const logger = makeLogger();
    const ws = { path: '/proj', attachSession: vi.fn().mockRejectedValue(new Error('cwd mismatch')) };
    const registry = { create: vi.fn().mockResolvedValue(ws) };
    const adapter = createHostAdapter(makeCtx({ workspaceRegistry: registry }), logger);

    await expect(adapter.attachSessionToWorkspace('sess-1', '/proj')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('create() 返回不含 attachSession 的对象时 warn（接口演进防护）', async () => {
    const logger = makeLogger();
    const registry = { create: vi.fn().mockResolvedValue({ path: '/proj' }) };
    const adapter = createHostAdapter(makeCtx({ workspaceRegistry: registry }), logger);

    await expect(adapter.attachSessionToWorkspace('sess-1', '/proj')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
