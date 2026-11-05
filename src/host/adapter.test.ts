import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHostAdapter, _resetAdapterCache } from './adapter.ts';

/** 最小 ctx：服务直接挂在 ctx 上（宿主已通过 inject 保证存在） */
function makeCtx(services: Record<string, unknown> = {}) {
  return { agentPresets: {}, ...services } as never;
}

describe('host adapter', () => {
  beforeEach(() => {
    _resetAdapterCache();
    vi.unstubAllGlobals();
  });

  it('sessionEvents：新宿主 snapshotEvents() 优先', () => {
    const adapter = createHostAdapter(makeCtx());
    const events = [{ type: 'a', seq: 0 }];
    expect(adapter.sessionEvents({ snapshotEvents: () => events })).toBe(events);
  });

  it('sessionEvents：旧宿主 events getter 兜底', () => {
    const adapter = createHostAdapter(makeCtx());
    const events = [{ type: 'a', seq: 0 }];
    expect(adapter.sessionEvents({ events })).toEqual(events);
  });

  it('sessionEvents：两者皆无返回空数组（不抛）', () => {
    const adapter = createHostAdapter(makeCtx());
    expect(adapter.sessionEvents({})).toEqual([]);
  });

  it('serviceFor：presets 实例方法直接命中', async () => {
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
    const adapter = createHostAdapter(makeCtx());
    expect(await adapter.serviceFor({ ctx: {} }, 'compaction')).toBe(compaction);
  });

  it('globalService：未注册返回 undefined（不抛）', () => {
    const adapter = createHostAdapter(makeCtx());
    expect(adapter.globalService('compaction')).toBeUndefined();
  });

  it('globalService：已注册返回服务', () => {
    const compaction = { compactNow: () => {} };
    const adapter = createHostAdapter(makeCtx({ compaction }));
    expect(adapter.globalService('compaction')).toBe(compaction);
  });

  it('buildForkSeed：模块不可解析时返回 undefined（不抛）', async () => {
    const adapter = createHostAdapter(makeCtx());
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

  it('capabilities 固定列出必需服务', () => {
    const adapter = createHostAdapter(makeCtx());
    expect(adapter.capabilities).toEqual(expect.arrayContaining([
      'sessionPersistence.stat',
      'workspaceRegistry',
      'sessionQuery',
      'sessionTitle.rename',
    ]));
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

  it('archivedSessionIds / pinnedSessionIds 返回 Set', () => {
    const adapter = createHostAdapter(makeCtx({
      workspaceRegistry: makeRegistry({ pinnedSessionIds: ['session-p'] }),
    }));
    expect([...adapter.archivedSessionIds()]).toEqual(['session-a']);
    expect([...adapter.pinnedSessionIds()]).toEqual(['session-p']);
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

  it('unarchiveSession 成功返回 ok', async () => {
    const registry = makeRegistry();
    const adapter = createHostAdapter(makeCtx({ workspaceRegistry: registry }));
    expect(await adapter.unarchiveSession('session-x')).toEqual({ ok: true });
    expect(registry.unarchiveSession).toHaveBeenCalledWith('session-x');
  });
});

describe('会话改名（sessionTitle）', () => {
  const session = { id: 'session-x' };

  it('把用户标题交给宿主，并回报宿主规范化后的标题', () => {
    const sessionTitle = { rename: vi.fn(() => ({ title: '修登录' })) };
    const adapter = createHostAdapter(makeCtx({ sessionTitle }));

    expect(adapter.renameSession(session, '  修登录  ')).toEqual({ ok: true, title: '修登录' });
    expect(sessionTitle.rename).toHaveBeenCalledWith(session, '  修登录  ');
  });

  it('标题被规范化成空 → invalid（按错误名识别，不依赖 instanceof）', () => {
    const error = new Error('title is empty');
    error.name = 'SessionTitleInvalidError';
    const adapter = createHostAdapter(makeCtx({
      sessionTitle: { rename: vi.fn(() => { throw error; }) },
    }));

    const outcome = adapter.renameSession(session, '   ');
    expect(outcome.ok === false && outcome.reason).toBe('invalid');
  });

  it('会话已关闭 → not-live', () => {
    const adapter = createHostAdapter(makeCtx({
      sessionTitle: { rename: vi.fn(() => { throw new Error('session is not live'); }) },
    }));

    const outcome = adapter.renameSession(session, '新名字');
    expect(outcome.ok === false && outcome.reason).toBe('not-live');
  });

  it('其它错误 → failed，并保留原始文案', () => {
    const adapter = createHostAdapter(makeCtx({
      sessionTitle: { rename: vi.fn(() => { throw new Error('EIO'); }) },
    }));

    const outcome = adapter.renameSession(session, '新名字');
    expect(outcome.ok === false && outcome.reason).toBe('failed');
    expect(outcome.ok === false && outcome.message).toContain('EIO');
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

  it('registry 无 create() 时 warn 并跳过', async () => {
    const logger = makeLogger();
    const adapter = createHostAdapter(makeCtx({ workspaceRegistry: {} }), logger);

    await expect(adapter.attachSessionToWorkspace('sess-1', '/proj')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
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
