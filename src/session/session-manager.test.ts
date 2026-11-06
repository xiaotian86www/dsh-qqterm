/**
 * SessionManager.getOrCreate 会话 id 恢复/铸造路径的回归用例
 *
 * - E1：resume 失败只在确认「会话不存在」时才首次创建，其余故障 warn 后向上抛
 * - E2：resume 期间 /new 并发改写映射时不丢新 id；同 key 并发 getOrCreate 合并为一次
 * - E3 连带：prefs 损坏导致映射丢失时必须留下可见日志
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { ConfigSchema, type ImQQBotConfig } from '../config.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import type { DshAgent, DshAgentHandle, DshAgentRegistry } from './types.ts';

const env = vi.hoisted(() => ({ home: '' }));

vi.mock('../shared/dirs.ts', () => ({
  get PLUGIN_HOME() { return env.home; },
  resolveAgentCwd: (cwd: string | undefined) => cwd || `${env.home}/workspace`,
}));

const { SessionManager } = await import('./session-manager.ts');
const { PrefsStore } = await import('../model/prefs-store.ts');

const APP_ID = 'app1';
const PEER = 'user1';
const PEER_B = 'user2';
/** 聊天会话只有一个：固定 key */
const KEY = `qqbot:${APP_ID}:chat`;
const MINTED = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPLY: ReplyTarget = { scope: 'c2c', targetId: PEER, msgId: 'm1' };
const REPLY_B: ReplyTarget = { scope: 'c2c', targetId: PEER_B, msgId: 'm2' };

/** agents.resume 对不存在会话的报错 */
const notFound = (id: string): Error =>
  Object.assign(new Error(`session "${id}" not found`), { name: 'SessionPersistenceNotFoundError' });
/** 非「不存在」类失败：日志损坏 / 后端 IO / 同 id 未释放等 */
const corrupt = (id: string): Error => new Error(`EIO: corrupt session log for "${id}"`);

/**
 * 宿主 persistence 替身。
 *
 * 签名对齐宿主 `SessionPersistence.stat`：会话不存在返回 `undefined`（不抛），
 * 存在则返回快照。替身必须跟真实契约一致——此前替身带了宿主根本没有的
 * `load()`，用例全绿但线上直接 TypeError。
 */
/** inject 保证存在的宿主服务：测试底座一并提供 */
function hostCtxServices() {
  // 宿主把模型选择记进会话（model/selection projection）：测试替身同样记住，
  // 否则 /model 切换后 getEffectiveModel 读不到新值。
  const selections = new Map<string, { provider: string; model: string; reasoningEffort?: string }>();
  return {
    llm: {
      listProviders: () => [{ id: 'p', name: 'p' }],
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
    },
    sessionProjections: {
      stateOf: (session: { id?: string } | undefined) => {
        const selected = session?.id === undefined ? undefined : selections.get(session.id);
        return selected === undefined ? undefined : { lastUsed: selected };
      },
    },
    sessionController: {
      selectModel: async (request: {
        sessionId: string;
        provider: string;
        model: string;
        reasoningEffort?: string;
      }) => {
        const selected = {
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}),
        };
        selections.set(request.sessionId, selected);
        return { selected };
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    sessionPersistence: { stat: async () => undefined },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    sessionTitle: { rename: () => ({}) },
    workspaceRegistry: {
      list: () => [],
      create: async () => ({ path: '/', attachSession: async () => {} }),
    },
    agentPresets: { serviceFor: () => undefined },
    permissionPresets: { names: [], optionOf: () => undefined },
  };
}

function persistenceCtx(stat: (id: string) => Promise<{ header?: { agentPreset?: string } } | undefined>): Context {
  return {
    ...hostCtxServices(),
    sessionPersistence: { stat },
    get: (name: string) => (name === 'sessionPersistence' ? { stat } : undefined),
    on: vi.fn(),
  } as unknown as Context;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeAgent(id: string): DshAgent {
  return {
    id,
    ctx: {} as Context,
    status: 'idle',
    session: { id, snapshotEvents: () => [] },
    cancel: vi.fn(),
    followup: vi.fn(),
    whenIdle: vi.fn(async () => {}),
    runMaintenance: vi.fn(async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal)),
  } as unknown as DshAgent;
}

function fakeHandle(id: string): DshAgentHandle {
  return { agent: fakeAgent(id), dispose: vi.fn(async () => {}) };
}

type ResumeImpl = (options: { resumeSessionId: string }) => Promise<DshAgentHandle>;

function createRegistry(resumeImpl: ResumeImpl) {
  const handles: DshAgentHandle[] = [];
  const registry = {
    get: vi.fn(() => undefined),
    resume: vi.fn(resumeImpl),
    create: vi.fn(async (options: { sessionId: string }) => {
      const handle = fakeHandle(options.sessionId);
      handles.push(handle);
      return handle;
    }),
  };
  return { registry, handles };
}

function createLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

/** 所有日志调用参数拼接（断言某错误是否被记录） */
function allLogText(logger: Logger): string {
  return (['info', 'warn', 'error', 'debug'] as const)
    .flatMap((level) => vi.mocked(logger[level]).mock.calls.flat())
    .map(String)
    .join('\n');
}

const managers: Array<InstanceType<typeof SessionManager>> = [];

/** 无任何宿主服务的 ctx（无 sessionPersistence，存在性无法求证） */
function emptyCtx(): Context {
  return { ...hostCtxServices(), get: () => undefined, on: vi.fn() } as unknown as Context;
}

/** 默认替身：磁盘上没有任何会话（stat 一律 undefined） */
function absentCtx(): Context {
  return persistenceCtx(async () => undefined);
}

/** 替身：指定 id 的会话在盘上 */
function onDiskCtx(...ids: string[]): Context {
  return persistenceCtx(async (id) => (ids.includes(id) ? { header: {} } : undefined));
}

function createManagerWithCtx(
  registry: Pick<DshAgentRegistry, 'get' | 'resume' | 'create'>,
  ctx: Context,
  logger: Logger = createLogger(),
) {
  const config = ConfigSchema({
    appId: APP_ID,
    appSecret: 'secret',
    provider: 'p',
    model: 'm',
  } as ImQQBotConfig);
  const manager = new SessionManager(ctx, registry as DshAgentRegistry, config, logger);
  managers.push(manager);
  return manager;
}

function createManager(registry: Pick<DshAgentRegistry, 'get' | 'resume' | 'create'>, logger: Logger = createLogger()) {
  return createManagerWithCtx(registry, absentCtx(), logger);
}

/** 模拟重启后读盘：prefs 中记录的 sessionId */
function persistedId(): string | undefined {
  return new PrefsStore().getSessionId(KEY);
}

function createdIds(registry: { create: { mock: { calls: Array<[{ sessionId: string }]> } } }): string[] {
  return registry.create.mock.calls.map(([options]) => String(options.sessionId));
}

beforeEach(() => {
  env.home = mkdtempSync(join(tmpdir(), 'im-qqbot-session-'));
  mkdirSync(join(env.home, 'workspace'), { recursive: true });
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.disposeAll()));
  rmSync(env.home, { recursive: true, force: true });
});

describe('getOrCreate — 对照组（主路径行为正确）', () => {
  it('全新用户：无映射 → 铸造 session- 前缀 id，resume miss 后创建并落盘', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });

    const record = await createManager(registry).getOrCreate('c2c', PEER, PEER, REPLY);

    expect(registry.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: record.sessionId }));
    expect(record.sessionId).toMatch(MINTED);
    expect(createdIds(registry)).toEqual([record.sessionId]);
    expect(persistedId()).toBe(record.sessionId);
  });

  it('prefs 已记录：resume 该 id 成功 → 不创建，映射不变', async () => {
    new PrefsStore().setSessionId(KEY, 'session-current');
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));

    const record = await createManager(registry).getOrCreate('c2c', PEER, PEER, REPLY);

    expect(record.sessionId).toBe('session-current');
    expect(registry.resume).toHaveBeenCalledTimes(1);
    expect(registry.create).not.toHaveBeenCalled();
  });

  it('session 当初的 preset 锁定：优先 header.agentPreset，而非当前 effective preset', async () => {
    const prefs = new PrefsStore();
    prefs.setSessionId(KEY, 'session-current');
    prefs.setPreset(KEY, 'current-preset'); // 当前 effective 已被 /preset 换过
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const presets = {
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'default' })),
      mount: vi.fn(async () => {}),
      serviceFor: () => undefined,
      list: vi.fn(async () => []),
    };
    const ctx = {
      ...hostCtxServices(),
      agentPresets: presets,
      sessionPersistence: {
        stat: async (id: string) => (id === 'session-current' ? { header: { agentPreset: 'locked-preset' } } : undefined),
      },
      get: (name: string) => {
        if (name === 'sessionPersistence') {
          return { stat: async (id: string) => (id === 'session-current' ? { header: { agentPreset: 'locked-preset' } } : undefined) };
        }
        return name === 'agentPresets' ? presets : undefined;
      },
      on: vi.fn(),
    } as unknown as Context;

    const record = await createManagerWithCtx(registry, ctx).getOrCreate('c2c', PEER, PEER, REPLY);

    // 此前 header 读取一直失败（调用了宿主没有的 load），preset 锁定语义实际失效
    expect(presets.resolve).toHaveBeenCalledWith('locked-preset');
    expect(record.agentPreset).toBe('locked-preset');
  });
});

describe('getOrCreate — E1 resume 失败按会话是否存在分流', () => {
  it('E1-1 会话在盘上但 resume 失败 → 不创建，错误记录后向上抛', async () => {
    new PrefsStore().setSessionId(KEY, 'session-current');
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw corrupt(resumeSessionId); });
    const logger = createLogger();
    // 宿主自身（agent-loop restoreOrCreateConfigured）只在确认磁盘不存在时才 create
    const manager = createManagerWithCtx(registry, onDiskCtx('session-current'), logger);

    await expect(manager.getOrCreate('c2c', PEER, PEER, REPLY)).rejects.toThrow(/EIO/);

    expect(registry.create).not.toHaveBeenCalled();
    expect(persistedId()).toBe('session-current'); // 映射不被改写，故障恢复后仍指向原会话
    expect(allLogText(logger)).toContain('EIO');
  });

  it('E1-3 存在性求证本身失败（持久化后端故障）→ 按存在处理，不重建', async () => {
    new PrefsStore().setSessionId(KEY, 'session-current');
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const logger = createLogger();
    const flaky = persistenceCtx(async () => { throw new Error('EIO: persistence backend unavailable'); });

    await expect(
      createManagerWithCtx(registry, flaky, logger).getOrCreate('c2c', PEER, PEER, REPLY),
    ).rejects.toThrow(/not found/); // 向上抛原 resume 错误，而非求证错误
    expect(registry.create).not.toHaveBeenCalled();
    expect(allLogText(logger)).toContain('existence unknown');
  });

  it('E1-4 确认磁盘无此会话 → 即使 resume 报的是 IO 错误也允许首次创建', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw corrupt(resumeSessionId); });

    const record = await createManager(registry).getOrCreate('c2c', PEER, PEER, REPLY);

    expect(record.sessionId).toMatch(MINTED);
    expect(createdIds(registry)).toEqual([record.sessionId]);
  });
});

describe('getOrCreate — E2 并发改写映射', () => {
  it('E2-1 resume 期间 /new 写入新 id → 采用 prefs 最新 id 新建，内存与 prefs 一致', async () => {
    const pending = deferred<DshAgentHandle>();
    const { registry } = createRegistry(() => pending.promise);
    const manager = createManager(registry);

    const creating = manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await vi.waitFor(() => expect(registry.resume).toHaveBeenCalled());
    const candidate = registry.resume.mock.calls[0]![0].resumeSessionId;
    await manager.remove(); // /new：同步把 prefs 写为新铸 id
    pending.reject(notFound(candidate));
    const record = await creating;

    expect(record.sessionId).toMatch(MINTED);
    expect(record.sessionId).not.toBe(candidate);
    expect(createdIds(registry)).toEqual([record.sessionId]);
    expect(persistedId()).toBe(record.sessionId); // 重启后仍是同一会话
  });

  it('preset 没有压缩能力时返回 no-compaction', async () => {
    const { registry } = createRegistry(async () => {
      throw notFound('missing');
    });
    const manager = createManager(registry);

    expect(
      await manager.compact('c2c', PEER, { senderId: PEER, replyTarget: REPLY }),
    ).toEqual({ ok: false, reason: 'no-compaction' });
  });

  it('E2-2 /compact 拉起与普通消息并发 getOrCreate → singleflight 合并为一次 resume/create，无 agent 泄漏', async () => {
    const resumes: Array<Deferred<DshAgentHandle>> = [];
    const { registry, handles } = createRegistry(() => {
      const d = deferred<DshAgentHandle>();
      resumes.push(d);
      return d.promise;
    });
    const manager = createManager(registry);

    // /compact 走 slashCommand（在 concurrencyGuard 之前），与普通消息不串行
    const compacting = manager.compact('c2c', PEER, { senderId: PEER, replyTarget: REPLY });
    const messaging = manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await vi.waitFor(() => expect(resumes).toHaveLength(1));
    const candidate = registry.resume.mock.calls[0]![0].resumeSessionId;
    for (const d of resumes) d.reject(notFound(candidate));
    const [, record] = await Promise.all([compacting, messaging]);

    expect(resumes).toHaveLength(1);
    expect(createdIds(registry)).toEqual([record.sessionId]);
    expect(record.sessionId).toMatch(MINTED);
    expect(handles).toHaveLength(1); // 不再产生无人回收的多余 agent
    expect(manager.getSessionRecord('c2c', PEER)?.handle).toBe(handles[0]);
  });

  it('E2-3 singleflight 失败时两个调用方都收到同一错误，且不残留在途记录', async () => {
    new PrefsStore().setSessionId(KEY, 'session-current');
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw corrupt(resumeSessionId); });
    // 会话在盘上 → resume 失败不重建，整次调用以失败告终
    const manager = createManagerWithCtx(registry, onDiskCtx('session-current'));

    const first = manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const second = manager.getOrCreate('c2c', PEER, PEER, REPLY);

    await expect(first).rejects.toThrow(/EIO/);
    await expect(second).rejects.toThrow(/EIO/);
    expect(registry.resume).toHaveBeenCalledTimes(1);

    // 在途记录已清理：下一次调用重新发起 resume
    await expect(manager.getOrCreate('c2c', PEER, PEER, REPLY)).rejects.toThrow(/EIO/);
    expect(registry.resume).toHaveBeenCalledTimes(2);
  });
});

describe('getOrCreate — E3 连带（prefs 损坏导致映射丢失）', () => {
  it('E3-4 prefs 文件损坏 → 按全新会话铸造 id，且映射丢失留下可见日志', async () => {
    writeFileSync(join(env.home, 'model-prefs.json'), `{"overrides":{},"sessionIds":{"${KEY}":"session-cur`, 'utf8');
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const logger = createLogger();

    const record = await createManager(registry, logger).getOrCreate('c2c', PEER, PEER, REPLY);

    expect(record.sessionId).toMatch(MINTED);
    expect(registry.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: record.sessionId }));
    expect(allLogText(logger)).toMatch(/model-prefs\.json/); // 不再静默
  });
});

describe('getOrCreate — 会话创建/恢复后挂载到对应工作区', () => {
  /** 带 workspaceRegistry 的 ctx（sessionPersistence 缺省为「磁盘无会话」） */
  function workspaceCtx(workspaceRegistry: unknown): Context {
    return {
      ...hostCtxServices(),
      workspaceRegistry,
      get: (name: string) => {
        if (name === 'sessionPersistence') return { stat: async () => undefined };
        if (name === 'workspaceRegistry') return workspaceRegistry;
        return undefined;
      },
      on: vi.fn(),
    } as unknown as Context;
  }

  it('创建会话后挂载到该会话的工作目录（cwd 与 meta.cwd 同源，避免 attachSession 校验失败）', async () => {
    const ws = { path: join(env.home, 'workspace'), attachSession: vi.fn().mockResolvedValue(undefined) };
    const workspaceRegistry = { create: vi.fn().mockResolvedValue(ws) };
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const manager = createManagerWithCtx(registry, workspaceCtx(workspaceRegistry));

    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    // attach 是 fire-and-forget，等待其落到工作区
    await vi.waitFor(() => expect(ws.attachSession).toHaveBeenCalledWith(record.sessionId));
    // 关键回归：cwd 必须等于 meta.cwd（会话自己的工作目录），而非 process.cwd()
    // 且不再传自定义标题：宿主按目录名生成显示名
    expect(workspaceRegistry.create).toHaveBeenCalledWith(`${env.home}/workspace`);
  });

  it('恢复会话时同样挂载（升级后老会话在下一次创建记录时补挂）', async () => {
    new PrefsStore().setSessionId(KEY, 'session-current');
    const ws = { path: join(env.home, 'workspace'), attachSession: vi.fn().mockResolvedValue(undefined) };
    const workspaceRegistry = { create: vi.fn().mockResolvedValue(ws) };
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const manager = createManagerWithCtx(registry, workspaceCtx(workspaceRegistry));

    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(record.sessionId).toBe('session-current');
    await vi.waitFor(() => expect(ws.attachSession).toHaveBeenCalledWith('session-current'));
    // 目录来自 chatDirectory 的兜底（mock 的 resolveAgentCwd 用正斜杠拼接）
    expect(workspaceRegistry.create).toHaveBeenCalledWith(`${env.home}/workspace`);
  });
});

describe('切换类操作 — 可重入', () => {
  /** 带 agentPresets 替身的 ctx（preset 切换需要 resolve） */
  function presetsCtx(): Context {
    const presets = {
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'default' })),
      mount: vi.fn(async () => {}),
      serviceFor: () => undefined,
      list: vi.fn(async () => []),
    };
    return {
      ...hostCtxServices(),
      agentPresets: presets,
      get: (name: string) => {
        if (name === 'sessionPersistence') return { stat: async () => undefined };
        return name === 'agentPresets' ? presets : undefined;
      },
      on: vi.fn(),
    } as unknown as Context;
  }

  it('模型：目标就是当前模型时不写选择、不 fork', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const manager = createManager(registry);
    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const before = record.sessionId;
    registry.create.mockClear();

    const outcome = await manager.setModelOverride('c2c', PEER, { provider: 'p', model: 'm' });

    expect(outcome).toEqual({ provider: 'p', model: 'm', unchanged: true });
    expect(registry.create).not.toHaveBeenCalled();
    expect(manager.getSessionRecord('c2c', PEER)?.sessionId).toBe(before);
  });

  it('preset：会话已开始后拒绝修改（只有新会话可设）', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const manager = createManagerWithCtx(registry, presetsCtx());
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    const outcome = await manager.setPresetOverride('c2c', PEER, 'beta');

    expect(outcome).toEqual({ ok: false, reason: 'session-started' });
  });

  it('新会话不继承旧会话的模型与 preset', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const manager = createManagerWithCtx(registry, presetsCtx());

    // 新会话先设 preset，再发第一条消息让它创建
    expect(await manager.setPresetOverride('c2c', PEER, 'beta')).toEqual({ ok: true, presetId: 'beta' });
    const created = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(created.agentPreset).toBe('beta');
    await manager.setModelOverride('c2c', PEER, { provider: 'p', model: 'other' });
    expect(manager.getEffectiveModel('c2c', PEER)).toEqual({ provider: 'p', model: 'other' });

    // 再 /new：模型回核心默认，preset 回默认，都不继承上一个会话
    await manager.remove();
    const fresh = await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(fresh.sessionId).not.toBe(created.sessionId);
    expect(manager.getEffectiveModel('c2c', PEER)).toEqual({ provider: 'p', model: 'm' });
    expect(fresh.agentPreset).not.toBe('beta');
  });

  it('模型：没有活跃会话时拒绝切换，也不写任何状态', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const manager = createManager(registry);

    const outcome = await manager.setModelOverride('c2c', PEER, { provider: 'p', model: 'm' });

    expect(outcome.reason).toBe('no-session');
    expect(new PrefsStore().getSessionId(KEY)).toBeUndefined();
  });

  it('preset：目标就是当前待定值时不重复写覆盖', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const manager = createManagerWithCtx(registry, presetsCtx());

    const first = await manager.setPresetOverride('c2c', PEER, 'alpha');
    const second = await manager.setPresetOverride('c2c', PEER, 'alpha');

    expect(first).toEqual({ ok: true, presetId: 'alpha' });
    expect(second).toEqual({ ok: true, presetId: 'alpha', unchanged: true });
    // 待定 preset 按会话 id 存：/new 铸出来的那个
    const sessionId = new PrefsStore().getSessionId(KEY);
    expect(sessionId).toBeDefined();
    expect(new PrefsStore().getPreset(sessionId!)).toBe('alpha');
  });
});

describe('聊天会话（全 bot 一个）', () => {
  it('不同聊天窗口共用同一个聊天会话，只建一个 agent', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const manager = createManager(registry);

    const first = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const second = await manager.getOrCreate('c2c', PEER_B, PEER_B, REPLY_B);

    expect(second).toBe(first);
    expect(second.sessionId).toBe(first.sessionId);
    expect(createdIds(registry)).toHaveLength(1);
    expect(new PrefsStore().getSessionId(KEY)).toBe(first.sessionId);
  });

  it('/new 换后台会话后，所有窗口都跟着切到新会话', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const manager = createManager(registry);

    const before = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await manager.remove();
    const after = await manager.getOrCreate('c2c', PEER_B, PEER_B, REPLY_B);

    expect(after.sessionId).not.toBe(before.sessionId);
    expect(new PrefsStore().getSessionId(KEY)).toBe(after.sessionId);
  });

  it('/sessions 切到另一个后台会话后，所有窗口都续写它', async () => {
    new PrefsStore().setSessionId(KEY, 'session-a');
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const manager = createManagerWithCtx(registry, onDiskCtx('session-a', 'session-b'));

    const before = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(before.sessionId).toBe('session-a');

    const outcome = await manager.switchSession('c2c', PEER_B, 'session-b', PEER_B, REPLY_B);
    expect(outcome).toEqual({ ok: true });

    // 另一个窗口的下一条消息落在同一个（已切换的）聊天会话上
    const after = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(after.sessionId).toBe('session-b');
    expect(new PrefsStore().getSessionId(KEY)).toBe('session-b');
  });
});

const EFFORTS = [
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
];

type HostSelectionState = { provider: string; model: string; reasoningEffort?: string };

interface EffortHost {
  ctx: Context;
  state: { pending: HostSelectionState | null; lastUsed: HostSelectionState | null; saved: HostSelectionState };
  selectModel: ReturnType<typeof vi.fn>;
}

/**
 * ctx 替身：llm 元数据 + 宿主的会话选择 / 部署默认选择
 *
 * - `sessionController.selectModel` 模拟宿主：会话下一轮生效 + 保存默认
 * - `sessionProjections.stateOf` 给出 modelSelection 的 pending / lastUsed
 * - `agentDefaultModel.currentSelection` 给出部署默认选择
 */
function effortCtx(
  reasoning: Record<string, { efforts: typeof EFFORTS; defaultEffort?: string }>,
): EffortHost {
  const state = {
    pending: null as HostSelectionState | null,
    lastUsed: null as HostSelectionState | null,
    saved: { provider: 'p', model: 'm' } as HostSelectionState,
  };
  const selectModel = vi.fn(async (request: HostSelectionState & { sessionId: string }) => {
    const selected: HostSelectionState = {
      provider: request.provider,
      model: request.model,
      ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}),
    };
    state.pending = selected;
    state.saved = selected;
    return { selected };
  });
  const services: Record<string, unknown> = {
    ...hostCtxServices(),
    llm: {
      listProviders: async () => [{ id: 'p', name: 'p' }],
      listModels: async () => [],
      resolveModelInfo: async (providerId: string, model: string) => {
        const info = reasoning[`${providerId}/${model}`];
        return info ? { reasoning: info } : {};
      },
    },
    sessionProjections: { stateOf: () => state },
    agentDefaultModel: {
      currentSelection: () => state.saved,
      saveSelection: async (next: HostSelectionState) => { state.saved = next; },
    },
    sessionController: { selectModel },
  };
  const ctx = {
    ...services,
    get: (name: string) => services[name],
    on: vi.fn(),
  } as unknown as Context;
  return { ctx, state, selectModel };
}

/** registry.create 最近一次收到的 agentOptions */
function lastAgentOptions(registry: { create: { mock: { calls: unknown[][] } } }): Record<string, unknown> | undefined {
  const call = registry.create.mock.calls.at(-1)?.[0] as { agentOptions?: Record<string, unknown> } | undefined;
  return call?.agentOptions;
}

describe('思考强度 — 宿主选择与重建', () => {
  const REASONING = { 'p/m': { efforts: EFFORTS, defaultEffort: 'high' } };

  it('未显式设置时档位跟随模型默认，create 只带路由', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const host = effortCtx(REASONING);
    const manager = createManagerWithCtx(registry, host.ctx);

    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(lastAgentOptions(registry)).toEqual({ provider: 'p', model: 'm' });
    expect(await manager.getEffortView('c2c', PEER)).toMatchObject({
      defaulted: true,
      current: { id: 'high', name: 'High' },
    });
  });

  it('显式选中模型默认档位视为未变化，不写宿主', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const host = effortCtx(REASONING);
    const manager = createManagerWithCtx(registry, host.ctx);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(await manager.selectEffort('c2c', PEER, 'high')).toEqual({
      ok: true,
      effort: 'high',
      unchanged: true,
    });
    expect(host.selectModel).not.toHaveBeenCalled();
  });

  it('切换档位走宿主 selectModel，当前会话下一轮生效、不重建', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const host = effortCtx(REASONING);
    const manager = createManagerWithCtx(registry, host.ctx);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    const outcome = await manager.selectEffort('c2c', PEER, 'max');

    expect(outcome).toEqual({ ok: true, effort: 'max' });
    expect(host.selectModel).toHaveBeenCalledWith({
      sessionId: expect.any(String),
      provider: 'p',
      model: 'm',
      reasoningEffort: 'max',
    });
    expect(await manager.getEffortView('c2c', PEER)).toMatchObject({
      defaulted: false,
      current: { id: 'max', name: 'Max' },
    });

    // 宿主下一轮请求嗅探的是 model/selection，不 fork：仍用同一个 agent
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(registry.create).toHaveBeenCalledTimes(1);
  });

  it('换模型时把当前档位带过去；目标模型不支持就交回它的默认', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const host = effortCtx({
      ...REASONING,
      'p/m2': { efforts: EFFORTS },
      'p/narrow': { efforts: [{ id: 'low', name: 'Low' }] },
    });
    const manager = createManagerWithCtx(registry, host.ctx);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await manager.selectEffort('c2c', PEER, 'max');
    host.selectModel.mockClear();

    // 新模型同样支持 max：连档位一起传，宿主不会把它当成「模型默认」
    await manager.setModelOverride('c2c', PEER, { provider: 'p', model: 'm2' });
    expect(host.selectModel).toHaveBeenLastCalledWith({
      sessionId: expect.any(String),
      provider: 'p',
      model: 'm2',
      reasoningEffort: 'max',
    });

    // 新模型只有 low：丢弃档位，不拿一个不存在的选项去撞宿主
    await manager.setModelOverride('c2c', PEER, { provider: 'p', model: 'narrow' });
    expect(host.selectModel).toHaveBeenLastCalledWith({
      sessionId: expect.any(String),
      provider: 'p',
      model: 'narrow',
    });
  });

  it('改思考强度按核心行为写入部署默认（不再写回旧值）', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const host = effortCtx(REASONING);
    const manager = createManagerWithCtx(registry, host.ctx);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    await manager.selectEffort('c2c', PEER, 'max');

    // 宿主 selectModel 自带 saveSelection：部署默认跟着变，插件不再恢复
    expect(host.state.saved).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'max' });
    expect(await manager.getEffortView('c2c', PEER)).toMatchObject({ current: { id: 'max' } });
  });

  it('恢复默认交回模型默认档位，宿主选择里不再带 reasoningEffort', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const host = effortCtx(REASONING);
    const manager = createManagerWithCtx(registry, host.ctx);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await manager.selectEffort('c2c', PEER, 'max');

    const outcome = await manager.selectEffort('c2c', PEER, undefined);

    expect(outcome).toMatchObject({ ok: true, effort: 'high' });
    expect(host.selectModel).toHaveBeenLastCalledWith({
      sessionId: expect.any(String),
      provider: 'p',
      model: 'm',
    });
    expect(await manager.getEffortView('c2c', PEER)).toMatchObject({
      defaulted: true,
      current: { id: 'high' },
    });
  });

  it('换成不支持思考强度的模型时不显示档位，重建只带路由', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const host = effortCtx(REASONING);
    const manager = createManagerWithCtx(registry, host.ctx);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await manager.selectEffort('c2c', PEER, 'max');

    await manager.setModelOverride('c2c', PEER, { provider: 'p', model: 'plain' });

    expect(await manager.getEffortView('c2c', PEER)).toEqual({ defaulted: true });

    await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(lastAgentOptions(registry)).toEqual({ provider: 'p', model: 'plain' });
  });

  it('未知档位与不支持思考强度的模型都拒绝写入', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const host = effortCtx(REASONING);
    const manager = createManagerWithCtx(registry, host.ctx);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(await manager.selectEffort('c2c', PEER, 'turbo')).toMatchObject({
      ok: false,
      reason: 'unknown-effort',
    });
    expect(host.selectModel).not.toHaveBeenCalled();

    await manager.setModelOverride('c2c', PEER, { provider: 'p', model: 'plain' });
    expect(await manager.selectEffort('c2c', PEER, 'high')).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('没有会话时拒绝切换，不写宿主', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const host = effortCtx(REASONING);
    const manager = createManagerWithCtx(registry, host.ctx);

    expect(await manager.selectEffort('c2c', PEER, 'max')).toEqual({ ok: false, reason: 'no' });
    expect(host.selectModel).not.toHaveBeenCalled();
    expect(registry.create).not.toHaveBeenCalled();
  });
});
