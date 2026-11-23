import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHostAdapter } from '../../src/host/adapter.ts';

/** 最小 ctx：服务直接挂在 ctx 上（宿主已通过 inject 保证存在） */
function makeCtx(services: Record<string, unknown> = {}) {
  return { get: (name: string) => services[name], ...services } as never;
}

describe('host adapter', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('sessionEvents：读宿主 snapshotEvents()', () => {
    const adapter = createHostAdapter(makeCtx());
    const events = [{ type: 'a', seq: 0 }];
    expect(adapter.sessionEvents({ snapshotEvents: () => events })).toBe(events);
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
      'sessionQuery',
      'sessionTitle.rename',
    ]));
    expect(adapter.capabilities).not.toContain('workspaceRegistry');
  });

  it('listSessions：合并 sessionController.list 的 updatedAt 与 blank（Web 侧栏同一份摘要）', async () => {
    const adapter = createHostAdapter(makeCtx({
      sessionQuery: {
        listSessions: async () => [
          { header: { id: 'a', cwd: '/w', createdAt: 100 }, live: false },
          { header: { id: 'b', cwd: '/w', createdAt: 200 }, live: false },
        ],
      },
      sessionController: {
        list: async () => ({
          items: [
            { sessionId: 'a', updatedAt: 900, blank: true },
            { sessionId: 'b', updatedAt: 200, blank: false },
          ],
        }),
      },
    }));

    const sessions = await adapter.listSessions();

    expect(sessions.map((session) => [session.id, session.createdAt, session.updatedAt, session.blank])).toEqual([
      ['a', 100, 900, true],
      ['b', 200, 200, false],
    ]);
  });

  it('listSessions：sessionController 缺失或抛错时 updatedAt 回退成 createdAt，blank 为 false', async () => {
    const query = {
      listSessions: async () => [{ header: { id: 'a', cwd: '/w', createdAt: 100 }, live: false }],
    };
    const withoutController = createHostAdapter(makeCtx({ sessionQuery: query }));
    expect((await withoutController.listSessions())[0]).toMatchObject({ updatedAt: 100, blank: false });

    const failing = createHostAdapter(makeCtx({
      sessionQuery: query,
      sessionController: { list: async () => { throw new Error('EIO'); } },
    }));
    expect((await failing.listSessions())[0]).toMatchObject({ updatedAt: 100, blank: false });
  });

  it('listSessions：sessionController 未注入（属性访问即抛）时同样回退', async () => {
    const ctx = makeCtx({
      sessionQuery: { listSessions: async () => [{ header: { id: 'a', cwd: '/w', createdAt: 100 }, live: false }] },
    }) as unknown as Record<string, unknown>;
    Object.defineProperty(ctx, 'sessionController', {
      get() { throw new Error('service not injected'); },
      configurable: true,
    });

    const adapter = createHostAdapter(ctx as never);
    expect((await adapter.listSessions())[0]).toMatchObject({ updatedAt: 100, blank: false });
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

describe('workspaceRegistry 可选', () => {
  it('服务缺失：无分组能力、列表为空、归档回 unavailable、集合为空', async () => {
    const adapter = createHostAdapter(makeCtx({
      workingDirectory: { defaultDirectory: '/ws' },
    }));

    expect(adapter.supportsWorkspaceRegistry()).toBe(false);
    expect(adapter.capabilities).not.toContain('workspaceRegistry');
    expect(adapter.workspaceList()).toEqual([]);
    expect(adapter.defaultWorkspacePath()).toBe('/ws');
    expect(adapter.archivedSessionIds().size).toBe(0);
    expect(adapter.pinnedSessionIds().size).toBe(0);
    expect(await adapter.archiveSession('s1')).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await adapter.unarchiveSession('s1')).toMatchObject({ ok: false, reason: 'unavailable' });
    await expect(adapter.attachSessionToWorkspace('s1', '/proj')).resolves.toBeUndefined();
  });

  it('属性访问即抛（Cordis 未注入）时同样按缺失处理', async () => {
    const ctx = makeCtx() as unknown as Record<string, unknown>;
    Object.defineProperty(ctx, 'workspaceRegistry', {
      get() { throw new Error('service not injected'); },
      configurable: true,
    });

    const adapter = createHostAdapter(ctx as never);
    expect(adapter.supportsWorkspaceRegistry()).toBe(false);
    expect(adapter.workspaceList()).toEqual([]);
    expect(await adapter.archiveSession('s1')).toMatchObject({ reason: 'unavailable' });
  });

  it('服务只能经 ctx.get 拿到（属性访问抛错）时仍按已提供处理', async () => {
    const registry = { archivedSessionIds: ['s1'], pinnedSessionIds: ['s2'] };
    const ctx = makeCtx() as unknown as Record<string, unknown>;
    ctx.get = (name: string) => (name === 'workspaceRegistry' ? registry : undefined);
    Object.defineProperty(ctx, 'workspaceRegistry', {
      get() { throw new Error('cannot get property "workspaceRegistry" without inject'); },
      configurable: true,
    });

    const adapter = createHostAdapter(ctx as never);
    expect(adapter.supportsWorkspaceRegistry()).toBe(true);
    expect(adapter.capabilities).toContain('workspaceRegistry');
    expect([...adapter.archivedSessionIds()]).toEqual(['s1']);
  });

  it('服务在插件 apply 之后才注册：构造期缺失，之后每次现读应生效', async () => {
    const services: Record<string, unknown> = {};
    const adapter = createHostAdapter(makeCtx(services));
    expect(adapter.supportsWorkspaceRegistry()).toBe(false);
    expect(await adapter.archiveSession('s1')).toMatchObject({ ok: false, reason: 'unavailable' });

    // 组合包可能晚于插件 apply 才提供 workspaceRegistry
    const registry = {
      archivedSessionIds: ['s1'],
      pinnedSessionIds: [],
      list: () => [],
      archiveSession: vi.fn(async () => {}),
      unarchiveSession: vi.fn(async () => {}),
      create: vi.fn(async () => ({ path: '/proj', attachSession: async () => {} })),
    };
    services.workspaceRegistry = registry;

    expect(adapter.supportsWorkspaceRegistry()).toBe(true);
    expect(adapter.capabilities).toContain('workspaceRegistry');
    expect(await adapter.archiveSession('s1')).toEqual({ ok: true });
    expect(registry.archiveSession).toHaveBeenCalledWith('s1', { stopActivity: true });
  });

  it('sessionController 经 ctx.get 提供时用它的活跃时间', async () => {
    const ctx = makeCtx({
      sessionQuery: { listSessions: async () => [{ header: { id: 'a', cwd: '/w', createdAt: 100 }, live: false }] },
      get: (name: string) =>
        name === 'sessionController'
          ? { list: async () => ({ items: [{ sessionId: 'a', updatedAt: 500, blank: true }] }) }
          : undefined,
    }) as unknown as Record<string, unknown>;
    Object.defineProperty(ctx, 'sessionController', {
      get() { throw new Error('cannot get property "sessionController" without inject'); },
      configurable: true,
    });

    const adapter = createHostAdapter(ctx as never);
    expect((await adapter.listSessions())[0]).toMatchObject({ updatedAt: 500, blank: true });
  });
});

describe('排队消息改成插话（sessionController.updateQueue）', () => {
  it('没有 sessionController / updateQueue 时不可用', () => {
    expect(createHostAdapter(makeCtx()).supportsQueueSteer()).toBe(false);
    expect(createHostAdapter(makeCtx({
      sessionController: { list: async () => ({}) },
    })).supportsQueueSteer()).toBe(false);
  });

  it('有 updateQueue 时可用，并原样传会话、消息与 steer 动作', async () => {
    const updateQueue = vi.fn(async () => ({ accepted: true }));
    const adapter = createHostAdapter(makeCtx({ sessionController: { updateQueue } }));

    expect(adapter.supportsQueueSteer()).toBe(true);
    expect(await adapter.steerQueuedMessage('session-a', 'm-1')).toEqual({ ok: true });
    expect(updateQueue).toHaveBeenCalledWith({
      sessionId: 'session-a',
      itemId: 'm-1',
      action: { kind: 'steer' },
    });
  });

  it('宿主拒绝 accepted=false：按失败处理，不冒充成功', async () => {
    const adapter = createHostAdapter(makeCtx({
      sessionController: { updateQueue: async () => ({ accepted: false }) },
    }));

    expect(await adapter.steerQueuedMessage('s', 'm')).toEqual({ ok: false, reason: 'failed' });
  });

  it('宿主错误码归一成 not-found / steer-unavailable，其它保留原因', async () => {
    const withCode = (code: string) => createHostAdapter(makeCtx({
      sessionController: {
        updateQueue: async () => { throw Object.assign(new Error('nope'), { code }); },
      },
    }));

    expect(await withCode('session/queue-item-not-found').steerQueuedMessage('s', 'm'))
      .toEqual({ ok: false, reason: 'not-found' });
    expect(await withCode('session/steer-unavailable').steerQueuedMessage('s', 'm'))
      .toEqual({ ok: false, reason: 'steer-unavailable' });
    expect(await withCode('EIO').steerQueuedMessage('s', 'm'))
      .toMatchObject({ ok: false, reason: 'failed' });
  });
});

describe('读当前分支（headOf）', () => {
  function fakeSubprocess(reply: (argv: readonly string[]) => { code: number; text: string }) {
    const calls: Array<{ argv: readonly string[]; cwd: string; env?: Readonly<Record<string, string>> }> = [];
    const service = {
      resolveExecutable: async () => 'git',
      spawn(spec: {
        argv: readonly string[];
        cwd: string;
        env?: Readonly<Record<string, string>>;
      }) {
        calls.push({ argv: spec.argv, cwd: spec.cwd, env: spec.env });
        const { code, text } = reply(spec.argv);
        return {
          collected: { stdout: { readFrom: () => ({ text }) } },
          done: Promise.resolve({ exitCode: code }),
          terminate: () => {},
          waitForExit: async () => {},
        };
      },
    };
    return { service, calls };
  }

  it('读 HEAD 提交与分支，命令带 -C 目录与只读环境', async () => {
    const { service, calls } = fakeSubprocess((argv) =>
      (argv.includes('--verify') ? { code: 0, text: '6b1f02c0ffee\n' } : { code: 0, text: 'main\n' }));
    const adapter = createHostAdapter(makeCtx({ subprocess: service }));

    expect(await adapter.headOf('D:\\repo')).toEqual({ commit: '6b1f02c0ffee', branch: 'main' });
    expect(calls[0]?.argv).toEqual(['git', '-C', 'D:\\repo', 'rev-parse', '--verify', 'HEAD^{commit}']);
    expect(calls[0]?.env).toEqual({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
  });

  it('detached HEAD：symbolic-ref 失败时只给提交', async () => {
    const { service } = fakeSubprocess((argv) =>
      (argv.includes('--verify') ? { code: 0, text: 'abc123\n' } : { code: 1, text: '' }));
    const adapter = createHostAdapter(makeCtx({ subprocess: service }));

    expect(await adapter.headOf('D:\\repo')).toEqual({ commit: 'abc123' });
  });

  it('不是仓库 / 没有 subprocess 服务 / 执行失败：一律 undefined，不抛', async () => {
    const notRepo = fakeSubprocess(() => ({ code: 128, text: '' }));
    expect(await createHostAdapter(makeCtx({ subprocess: notRepo.service })).headOf('D:\\x')).toBeUndefined();
    expect(await createHostAdapter(makeCtx()).headOf('D:\\x')).toBeUndefined();

    const broken = {
      resolveExecutable: async () => { throw new Error('spawn EPERM'); },
      spawn: () => { throw new Error('unreachable'); },
    };
    expect(await createHostAdapter(makeCtx({ subprocess: broken })).headOf('D:\\x')).toBeUndefined();
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

describe('workingDirectory（已写进 inject）', () => {
  /** ctx 的最小形态：只挂 adapter 会读的服务，其余保持 undefined */
  function ctxWith(working: unknown) {
    return makeCtx({ workingDirectory: working });
  }

  it('defaultWorkspacePath 回退到 workingDirectory.defaultDirectory', () => {
    const adapter = createHostAdapter(ctxWith({ defaultDirectory: 'D:\\ws' }));
    expect(adapter.defaultWorkspacePath()).toBe('D:\\ws');
  });

  it('sessionDirectory 优先用 workingDirectory.get(session)', () => {
    const adapter = createHostAdapter(ctxWith({ get: () => 'D:\\live' }));
    expect(adapter.sessionDirectory({ header: { cwd: 'D:\\header' } })).toBe('D:\\live');
  });

  it('会话目录取不到时退回 header.cwd', () => {
    const adapter = createHostAdapter(ctxWith({ get: () => undefined }));
    expect(adapter.sessionDirectory({ header: { cwd: 'D:\\header' } })).toBe('D:\\header');
    expect(adapter.defaultWorkspacePath()).toBeUndefined();
  });
});
