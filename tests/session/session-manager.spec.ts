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
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { compactCommand } from '../../src/commands/session.ts';
import type { CommandDeps } from '../../src/commands/types.ts';
import { ConfigSchema, type QQTermConfig } from '../../src/config.ts';
import type { Logger, ReplyTarget } from '../../src/types.ts';
import type { DshAgent, DshAgentHandle, DshAgentRegistry, SessionEventLike } from '../../src/session/types.ts';
import { WorktreeError } from '../../src/session/worktree.ts';

const env = vi.hoisted(() => ({ home: '' }));

vi.mock('../../src/shared/dirs.ts', () => ({
  get PLUGIN_HOME() { return env.home; },
  resolveAgentCwd: (cwd: string | undefined) => cwd || `${env.home}/workspace`,
}));

const { SessionManager } = await import('../../src/session/session-manager.ts');
const { PrefsStore } = await import('../../src/model/prefs-store.ts');

const APP_ID = 'app1';
const PEER = 'user1';
const PEER_B = 'user2';
/** 聊天会话只有一个：固定 key */
const KEY = `qqterm:${APP_ID}:chat`;
const MINTED = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPLY: ReplyTarget = { scope: 'c2c', targetId: PEER };
const REPLY_B: ReplyTarget = { scope: 'c2c', targetId: PEER_B };

type AgentSelection = { provider: string; model: string; reasoningEffort?: string };
/** 宿主 agent.model.select 的落点：sessionId → 最近一次选择 */
const agentSelections = new Map<string, AgentSelection>();
/** 测试挂的监听：模拟 model/selection 投影，断言写入顺序 */
let onAgentSelect: ((sessionId: string, selection: AgentSelection) => void) | undefined;

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
  // 宿主把模型选择记进会话（model/selection projection）：agent.model.select 的
  // 替身写 agentSelections，视图与 /model 断言都读这一份。
  const services = {
    llm: {
      listProviders: () => [{ id: 'p', name: 'p' }],
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
    },
    sessionProjections: {
      stateOf: (session: { id?: string } | undefined) => {
        const selected = session?.id === undefined ? undefined : agentSelections.get(session.id);
        return selected === undefined ? undefined : { lastUsed: selected };
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'p', model: 'm' }),
      saveSelection: async () => {},
    },
    sessionPersistence: { stat: async () => undefined },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    sessionTitle: { rename: () => ({}) },
    workspaceRegistry: {
      list: () => [],
      create: async () => ({ path: '/', attachSession: async () => {} }),
    },
    agentPresets: { serviceFor: () => undefined },
    commands: { find: () => undefined, execute: async () => undefined },
    permissionPresets: { names: [], optionOf: () => undefined },
  };
  // 测试替身补上 ctx.get：插件读可选服务只走这个入口
  return { ...services, get: (name: string) => (services as Record<string, unknown>)[name] };
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
    // 宿主 dsh-agent 的 agent.model.select：append model/selection 事件
    model: {
      select: (selection: AgentSelection) => {
        agentSelections.set(id, { ...selection });
        onAgentSelect?.(id, selection);
      },
    },
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
  } as QQTermConfig);
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
  agentSelections.clear();
  onAgentSelect = undefined;
  env.home = mkdtempSync(join(tmpdir(), 'qqterm-session-'));
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

  it('session 当初的 preset 锁定：优先 header.agentPreset，而非部署默认 preset', async () => {
    const prefs = new PrefsStore();
    prefs.setSessionId(KEY, 'session-current');
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const presets = {
      defaultId: 'current-preset', // 部署默认后来被 /preset 换过
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'current-preset' })),
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
  it('E2-1 resume 期间 /new 清空指针 → 不写占位 id，resume 失败后按候选 id 创建', async () => {
    const pending = deferred<DshAgentHandle>();
    const { registry } = createRegistry(() => pending.promise);
    const manager = createManager(registry);

    const creating = manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await vi.waitFor(() => expect(registry.resume).toHaveBeenCalled());
    const candidate = registry.resume.mock.calls[0]![0].resumeSessionId;
    await manager.remove(); // /new：清指针，不铸 id
    expect(persistedId()).toBeUndefined();
    pending.reject(notFound(candidate));
    const record = await creating;

    expect(record.sessionId).toBe(candidate);
    expect(createdIds(registry)).toEqual([candidate]);
    expect(persistedId()).toBe(candidate); // 只落真实存在的会话
  });

  it('登记簿查不到命令 → unsupported，不执行', async () => {
    const execute = vi.fn();
    const ctx = {
      ...absentCtx(),
      commands: { find: () => undefined, execute },
    } as unknown as Context;
    const { registry } = createRegistry(async () => fakeHandle('s1'));
    const manager = createManagerWithCtx(registry, ctx);
    const agent = fakeAgent('s1');

    expect(await manager.runHostCommand(agent, 'compact')).toEqual({ kind: 'unsupported' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('参数拼成一行交给宿主，kind 与文本原样带回', async () => {
    const execute = vi.fn(async () => ({
      result: { kind: 'success' as const, text: 'Compacted 2 history items (~300 tokens).' },
    }));
    const ctx = {
      ...absentCtx(),
      commands: { find: () => ({ definitionId: '@deepseek-ai/dsh-command-compact' }), execute },
    } as unknown as Context;
    const { registry } = createRegistry(async () => fakeHandle('s1'));
    const manager = createManagerWithCtx(registry, ctx);
    const agent = fakeAgent('s1');

    expect(await manager.runHostCommand(agent, 'compact')).toEqual({
      kind: 'success',
      text: 'Compacted 2 history items (~300 tokens).',
    });
    expect(execute).toHaveBeenCalledWith(agent, '/compact', [], expect.anything());

    await manager.runHostCommand(agent, 'goal', ['ship it', 'now']);
    expect(execute).toHaveBeenLastCalledWith(agent, '/goal ship it now', [], expect.anything());
  });

  it('error kind 原样带回，插件不翻成败', async () => {
    const execute = vi.fn(async () => ({
      result: { kind: 'error' as const, text: 'Compaction cancelled.' },
    }));
    const ctx = {
      ...absentCtx(),
      commands: { find: () => ({ definitionId: 'x' }), execute },
    } as unknown as Context;
    const { registry } = createRegistry(async () => fakeHandle('s1'));
    const manager = createManagerWithCtx(registry, ctx);

    expect(await manager.runHostCommand(fakeAgent('s1'), 'compact')).toEqual({
      kind: 'error',
      text: 'Compaction cancelled.',
    });
  });

  it('宿主没给结果（execute 返回 undefined）算 unsupported', async () => {
    const execute = vi.fn(async () => undefined);
    const ctx = {
      ...absentCtx(),
      commands: { find: () => ({ definitionId: 'x' }), execute },
    } as unknown as Context;
    const { registry } = createRegistry(async () => fakeHandle('s1'));
    const manager = createManagerWithCtx(registry, ctx);

    expect(await manager.runHostCommand(fakeAgent('s1'), 'compact')).toEqual({ kind: 'unsupported' });
  });

  it('宿主抛错 → threw 带 message，并记 warn', async () => {
    const execute = vi.fn(async () => {
      throw new Error('boom');
    });
    const ctx = {
      ...absentCtx(),
      commands: { find: () => ({ definitionId: 'x' }), execute },
    } as unknown as Context;
    const { registry } = createRegistry(async () => fakeHandle('s1'));
    const logger = createLogger();
    const manager = createManagerWithCtx(registry, ctx, logger);

    expect(await manager.runHostCommand(fakeAgent('s1'), 'compact')).toEqual({
      kind: 'threw',
      message: 'boom',
    });
    expect(allLogText(logger)).toContain('host command failed: name=compact err=boom');
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
    const compacting = compactCommand({ manager } as unknown as CommandDeps).handler({
      message: { senderId: PEER, kind: 'c2c', messageId: 'm1' },
      command: { raw: '' },
    } as unknown as SlashCommandHandlerContext);
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
    // 目录来自内存 chatDir 的初值（mock 的 resolveAgentCwd 用正斜杠拼接）
    expect(workspaceRegistry.create).toHaveBeenCalledWith(`${env.home}/workspace`);
  });
});

describe('agentPresets 可选 — 部署里没有注册表', () => {
  /**
   * 真实 Cordis 里服务未注入时属性访问会抛错，不是返回 undefined；
   * 两种形态都要能建会话。
   */
  function noRegistryCtx(shape: 'undefined' | 'throw'): Context {
    const ctx = {
      ...hostCtxServices(),
      get: () => undefined,
      on: vi.fn(),
    } as unknown as Context;
    Object.defineProperty(ctx, 'agentPresets', {
      configurable: true,
      get() {
        if (shape === 'throw') throw new Error('service "agentPresets" is not available');
        return undefined;
      },
    });
    return ctx;
  }

  it.each(['undefined', 'throw'] as const)('缺失形态 %s：建会话照常，/preset 报无可用', async (shape) => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const manager = createManagerWithCtx(registry, noRegistryCtx(shape));

    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(record.sessionId).toMatch(MINTED);
    expect(record.agentPreset).toBeUndefined();
    expect(registry.create.mock.calls[0]![0]).not.toHaveProperty('setup');
    expect(await manager.listPresets()).toEqual([]);
    expect(manager.getEffectivePreset('c2c', PEER)).toBeUndefined();
    await expect(manager.setPresetOverride('c2c', PEER, 'standard')).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('真实 Cordis 形态：服务只能经 ctx.get 拿到（属性访问抛错）时照常可用', async () => {
    const presets = {
      defaultId: 'standard',
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'standard' })),
      mount: vi.fn(async () => {}),
      list: vi.fn(async () => [{ id: 'standard' }, { id: 'ptc' }]),
    };
    const ctx = {
      ...hostCtxServices(),
      get: (name: string) => (name === 'agentPresets' ? presets : undefined),
      on: vi.fn(),
    } as unknown as Context;
    // 不在 inject 里时，Cordis 代理的属性访问会直接抛
    Object.defineProperty(ctx, 'agentPresets', {
      configurable: true,
      get() { throw new Error('cannot get property "agentPresets" without inject'); },
    });

    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const manager = createManagerWithCtx(registry, ctx);

    expect(manager.presetsAvailable()).toBe(true);
    expect((await manager.listPresets()).map((entry) => entry.id)).toEqual(['standard', 'ptc']);
  });
});

describe('切换类操作 — 可重入', () => {
  /**
   * 带 agentPresets / settings 替身的 ctx：/preset 写核心默认值
   *
   * `settings.update` 与 `presets.defaultId` 联动，等价于核心「写入后默认值立即变化」。
   */
  function presetsCtx(): Context & {
    presets: { defaultId: string };
    settings: { update: ReturnType<typeof vi.fn> };
  } {
    const state = { defaultId: 'default' };
    const presets = {
      get defaultId(): string {
        return state.defaultId;
      },
      resolve: vi.fn(async (id?: string) => ({ id: id ?? state.defaultId })),
      mount: vi.fn(async () => {}),
      serviceFor: () => undefined,
      list: vi.fn(async () => []),
    };
    const settings = {
      update: vi.fn(async (_ns: string, patch: { selectedDefault?: string }) => {
        if (patch.selectedDefault !== undefined) state.defaultId = patch.selectedDefault;
      }),
    };
    const ctx = {
      ...hostCtxServices(),
      agentPresets: presets,
      settings,
      get: (name: string) => {
        if (name === 'sessionPersistence') return { stat: async () => undefined };
        if (name === 'agentPresets') return presets;
        if (name === 'settings') return settings;
        return undefined;
      },
      on: vi.fn(),
    } as unknown as Context;
    return Object.assign(ctx, { presets, settings });
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

  it('preset：已开始的会话也能改默认值，但只对之后新建的会话生效', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const ctx = presetsCtx();
    const manager = createManagerWithCtx(registry, ctx);
    const started = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(started.agentPreset).toBe('default');

    // 写核心 agent-preset-registry 的 selectedDefault，而不是按会话存待定值
    const outcome = await manager.setPresetOverride('c2c', PEER, 'beta');

    expect(outcome).toEqual({ ok: true, presetId: 'beta' });
    expect(ctx.settings.update).toHaveBeenCalledWith('agent-preset-registry', { selectedDefault: 'beta' });
    // 已开始的会话保持自己的 preset，/new 之后的新会话才用它
    expect(started.agentPreset).toBe('default');
    expect(manager.getEffectivePreset('c2c', PEER)).toBe('default');

    await manager.remove();
    const fresh = await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(fresh.agentPreset).toBe('beta');
  });

  it('新会话不继承旧会话的模型选择', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const ctx = {
      ...absentCtx(),
      llm: {
        listProviders: () => [{ id: 'p', name: 'p' }],
        listModels: async () => [{ id: 'other' }],
        resolveModelInfo: async () => ({}),
      },
    } as unknown as Context;
    const manager = createManagerWithCtx(registry, ctx);
    const created = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await manager.setModelOverride('c2c', PEER, { provider: 'p', model: 'other' });
    expect(manager.getEffectiveModel('c2c', PEER)).toEqual({ provider: 'p', model: 'other' });

    // 再 /new：新会话没有自己的选择，回核心默认
    await manager.remove();
    const fresh = await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(fresh.sessionId).not.toBe(created.sessionId);
    expect(manager.getEffectiveModel('c2c', PEER)).toEqual({ provider: 'p', model: 'm' });
  });

  it('模型：没有活跃会话时写部署默认值，不新开会话', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const saveSelection = vi.fn(async () => {});
    const ctx = {
      ...hostCtxServices(),
      llm: {
        listProviders: () => [{ id: 'p', name: 'p' }],
        listModels: async () => [{ id: 'other' }],
        resolveModelInfo: async () => ({}),
      },
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'p', model: 'm' }),
        saveSelection,
      },
      on: vi.fn(),
    } as unknown as Context;
    const manager = createManagerWithCtx(registry, ctx);

    const outcome = await manager.setModelOverride('c2c', PEER, { provider: 'p', model: 'other' });

    expect(outcome).toEqual({ provider: 'p', model: 'other' });
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'p', model: 'other' });
    expect(registry.create).not.toHaveBeenCalled();
    expect(new PrefsStore().getSessionId(KEY)).toBeUndefined();
  });

  it('模型：没有活跃会话且路由不在模型目录时拒绝，不写默认值', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const saveSelection = vi.fn(async () => {});
    const ctx = {
      ...hostCtxServices(),
      llm: {
        listProviders: () => [{ id: 'p', name: 'p' }],
        listModels: async () => [{ id: 'm' }],
        resolveModelInfo: async () => ({}),
      },
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'p', model: 'm' }),
        saveSelection,
      },
      on: vi.fn(),
    } as unknown as Context;
    const manager = createManagerWithCtx(registry, ctx);

    const outcome = await manager.setModelOverride('c2c', PEER, { provider: 'p', model: 'nope' });

    expect(outcome.reason).toBe('unknown-model');
    expect(saveSelection).not.toHaveBeenCalled();
  });

  it('权限：没有会话时写部署默认预设，不新开会话', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const settings = { update: vi.fn(async () => {}) };
    const ctx = {
      ...hostCtxServices(),
      settings,
      on: vi.fn(),
      permissionPresets: {
        names: ['read-only', 'workspace-write'],
        optionOf: () => undefined,
        defaultPreset: 'read-only',
      },
    } as unknown as Context;
    const manager = createManagerWithCtx(registry, ctx);

    const outcome = await manager.setPermissionPreset('c2c', PEER, 'workspace-write');

    expect(outcome).toEqual({ ok: true, preset: 'workspace-write' });
    expect(settings.update).toHaveBeenCalledWith('permission', { defaultPreset: 'workspace-write' });
    expect(registry.create).not.toHaveBeenCalled();
  });

  it('权限：没有会话时目标等于部署默认值 → 已是当前，不重复写 settings', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const settings = { update: vi.fn(async () => {}) };
    const ctx = {
      ...hostCtxServices(),
      settings,
      on: vi.fn(),
      permissionPresets: {
        names: ['read-only'],
        optionOf: () => undefined,
        defaultPreset: 'read-only',
      },
    } as unknown as Context;
    const manager = createManagerWithCtx(registry, ctx);

    const outcome = await manager.setPermissionPreset('c2c', PEER, 'read-only');

    expect(outcome).toEqual({ ok: true, preset: 'read-only', unchanged: true });
    expect(settings.update).not.toHaveBeenCalled();
  });

  it('preset：目标就是当前默认值时不重复写 settings', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const ctx = presetsCtx();
    const manager = createManagerWithCtx(registry, ctx);

    const first = await manager.setPresetOverride('c2c', PEER, 'alpha');
    const second = await manager.setPresetOverride('c2c', PEER, 'alpha');

    expect(first).toEqual({ ok: true, presetId: 'alpha' });
    expect(second).toEqual({ ok: true, presetId: 'alpha', unchanged: true });
    expect(ctx.settings.update).toHaveBeenCalledTimes(1);
    expect(ctx.settings.update).toHaveBeenCalledWith('agent-preset-registry', { selectedDefault: 'alpha' });
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
 * - fakeAgent 的 `agent.model.select` 把会话选择记进 `state.pending`（下一轮生效）
 * - `sessionProjections.stateOf` 给出 modelSelection 的 pending / lastUsed
 * - `agentDefaultModel.currentSelection` 给出部署默认选择
 */
function effortCtx(
  reasoning: Record<string, { efforts: typeof EFFORTS; defaultEffort?: string }>,
  extraModels: string[] = [],
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
    return { selected };
  });
  // 宿主 agent.model.select 的替身：会话下一轮生效，部署默认值由插件自己写
  onAgentSelect = (sessionId, selection) => { void selectModel({ sessionId, ...selection }); };
  const services: Record<string, unknown> = {
    ...hostCtxServices(),
    llm: {
      listProviders: () => [{ id: 'p', name: 'p' }],
      listModels: async (providerId: string) => [
        ...Object.keys(reasoning)
          .filter((key) => key.startsWith(`${providerId}/`))
          .map((key) => ({ id: key.slice(providerId.length + 1) })),
        ...extraModels.map((id) => ({ id })),
      ],
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

    // 写会话选择后插件同步写部署默认值：新会话跟着变，旧默认不恢复
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
    const host = effortCtx(REASONING, ['plain']);
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
    const host = effortCtx(REASONING, ['plain']);
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

  it('没有会话时写部署默认思考强度，不新开会话', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const host = effortCtx(REASONING);
    const manager = createManagerWithCtx(registry, host.ctx);

    expect(await manager.selectEffort('c2c', PEER, 'max')).toEqual({ ok: true, effort: 'max' });
    expect(host.selectModel).not.toHaveBeenCalled();
    expect(host.state.saved).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'max' });
    expect(registry.create).not.toHaveBeenCalled();
    // 视图读的是同一份部署默认值
    expect(await manager.getEffortView('c2c', PEER)).toMatchObject({
      current: { id: 'max' },
      defaulted: false,
    });
  });

  it('模型与档位写进会话选择，不经过 sessionController', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const host = effortCtx({ ...REASONING, 'p/m2': { efforts: EFFORTS, defaultEffort: 'high' } });
    const manager = createManagerWithCtx(registry, host.ctx);
    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(await manager.setModelOverride('c2c', PEER, { provider: 'p', model: 'm2' }))
      .toMatchObject({ provider: 'p', model: 'm2' });
    expect(agentSelections.get(record.sessionId)).toEqual({ provider: 'p', model: 'm2' });

    // low 不是 m2 的默认档位（high），会真正写一条会话选择
    expect(await manager.selectEffort('c2c', PEER, 'low')).toEqual({ ok: true, effort: 'low' });
    expect(agentSelections.get(record.sessionId)).toEqual({ provider: 'p', model: 'm2', reasoningEffort: 'low' });
    // 会话选择之后插件顺手把部署默认值写成同一份（新会话沿用）
    expect(host.state.saved).toEqual({ provider: 'p', model: 'm2', reasoningEffort: 'low' });
  });

  it('同一会话并发的模型切换串行执行（后一次不会拿着旧选择校验）', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const host = effortCtx({ ...REASONING, 'p/m2': { efforts: EFFORTS }, 'p/narrow': { efforts: EFFORTS } });
    const manager = createManagerWithCtx(registry, host.ctx);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    // 第一次切换卡在模型目录校验上，第二次必须等它写完才能开始
    const gate = deferred<void>();
    const llm = (host.ctx as unknown as { llm: { listModels: (providerId: string) => Promise<unknown[]> } }).llm;
    const catalog = llm.listModels;
    let active = 0;
    let peak = 0;
    llm.listModels = async (providerId: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return catalog(providerId);
    };

    const first = manager.setModelOverride('c2c', PEER, { provider: 'p', model: 'm2' });
    const second = manager.setModelOverride('c2c', PEER, { provider: 'p', model: 'narrow' });
    gate.resolve(undefined);
    await Promise.all([first, second]);

    expect(peak).toBe(1);
    expect(host.state.pending).toEqual({ provider: 'p', model: 'narrow' });
  });
});

describe('restoreCurrentSession — 启动恢复上次会话', () => {
  it('没有指针：不动宿主，返回 none', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const manager = createManager(registry);

    expect(await manager.restoreCurrentSession()).toEqual({ kind: 'none' });
    expect(registry.resume).not.toHaveBeenCalled();
    expect(registry.create).not.toHaveBeenCalled();
  });

  it('盘上还在：接回会话，回复目标用上次交互的用户', async () => {
    const prefs = new PrefsStore();
    prefs.setSessionId(KEY, 'session-current');
    prefs.setTarget(KEY, PEER_B);
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const manager = createManagerWithCtx(registry, onDiskCtx('session-current'));

    const outcome = await manager.restoreCurrentSession();

    expect(outcome).toEqual({ kind: 'ok', sessionId: 'session-current' });
    expect(registry.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: 'session-current' }));
    expect(manager.getStatus('c2c', PEER)).toMatchObject({ active: true, sessionId: 'session-current' });
    // touch 是后续消息的事；启动恢复本身不该改写记录里的回复目标
    expect(new PrefsStore().getTarget(KEY)).toBe(PEER_B);
  });

  it('盘上已不存在：不 resume、不创建，清除死指针并返回 none', async () => {
    new PrefsStore().setSessionId(KEY, 'session-gone');
    new PrefsStore().setTarget(KEY, PEER);
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const manager = createManagerWithCtx(registry, absentCtx());

    expect(await manager.restoreCurrentSession()).toEqual({ kind: 'none' });
    expect(registry.resume).not.toHaveBeenCalled();
    expect(registry.create).not.toHaveBeenCalled();
    // 不清掉的话 /sessions 会显示「待恢复」，恢复链接却永远失败
    expect(new PrefsStore().getSessionId(KEY)).toBeUndefined();
    expect(new PrefsStore().getTarget(KEY)).toBe(PEER);
  });

  it('另一个客户端占着写句柄：返回 failed/locked 且带上通知目标', async () => {
    new PrefsStore().setSessionId(KEY, 'session-current');
    new PrefsStore().setTarget(KEY, PEER_B);
    const { registry } = createRegistry(async () => {
      throw Object.assign(new Error('session is already owned by another writer'), { name: 'SessionAlreadyOwnedError' });
    });
    const manager = createManagerWithCtx(registry, onDiskCtx('session-current'));

    const outcome = await manager.restoreCurrentSession();

    expect(outcome).toMatchObject({ kind: 'failed', sessionId: 'session-current', targetId: PEER_B, locked: true });
    // 不重建：同 id 重建会把会话写进两个 project 目录
    expect(registry.create).not.toHaveBeenCalled();
    expect(manager.getStatus('c2c', PEER)).toMatchObject({ active: false });
  });

  it('没有记录过通知目标时失败不推送（返回 none）', async () => {
    new PrefsStore().setSessionId(KEY, 'session-current');
    const { registry } = createRegistry(async () => { throw corrupt('session-current'); });
    const manager = createManagerWithCtx(registry, onDiskCtx('session-current'));

    expect(await manager.restoreCurrentSession()).toEqual({ kind: 'none' });
  });
});

describe('getTurnProgress — 生成中的现场', () => {
  /** 已获取会话的事件流由用例提供；resume 成功即进入 records */
  function progressManager(events: SessionEventLike[]) {
    new PrefsStore().setSessionId(KEY, 'session-live');
    const { registry } = createRegistry(async ({ resumeSessionId }) => ({
      agent: {
        ...fakeAgent(resumeSessionId),
        status: 'running',
        session: { id: resumeSessionId, snapshotEvents: () => events },
      } as DshAgent,
      dispose: vi.fn(async () => {}),
    }));
    return createManager(registry);
  }

  it('工具还没返回：给出步骤、工具名与本轮耗时', async () => {
    const startedAt = Date.now() - 65_000;
    const events: SessionEventLike[] = [
      { type: 'turn/start', time: startedAt },
      { type: 'step/start', time: startedAt + 100, data: { turn: 1, step: 2 } },
      { type: 'tool/call', time: Date.now() - 12_000, data: { turn: 1, step: 2, callId: 'c1', name: 'read' } },
    ];
    const manager = progressManager(events);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    const progress = manager.getTurnProgress('c2c', PEER);
    expect(progress).toMatchObject({ step: 2, waiting: 'tool', toolName: 'read' });
    expect(progress?.elapsedMs).toBeGreaterThanOrEqual(65_000);
  });

  it('工具返回后等待模型，并把重试退避带出来', async () => {
    const startedAt = Date.now() - 30_000;
    const resultAt = Date.now() - 8_000;
    const events: SessionEventLike[] = [
      { type: 'turn/start', time: startedAt },
      { type: 'step/start', time: startedAt, data: { turn: 1, step: 1 } },
      { type: 'tool/call', time: startedAt + 1000, data: { callId: 'c1', name: 'grep' } },
      { type: 'tool/result', time: resultAt, data: { message: { callId: 'c1', isError: false } } },
      { type: 'llm/retry', time: Date.now() - 1000, data: { retry: 2, delayMs: 5000 } },
    ];
    const manager = progressManager(events);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    const progress = manager.getTurnProgress('c2c', PEER);
    expect(progress).toMatchObject({ step: 1, waiting: 'model', retry: { attempt: 2, delayMs: 5000 } });
    expect(progress?.waitingSince).toBe(resultAt);
    expect(progress?.toolName).toBeUndefined();
  });

  it('重试已开始后不再显示退避', async () => {
    const startedAt = Date.now() - 20_000;
    const events: SessionEventLike[] = [
      { type: 'turn/start', time: startedAt },
      { type: 'step/start', time: startedAt, data: { step: 1 } },
      { type: 'llm/retry', time: startedAt + 1000, data: { retry: 1, delayMs: 2000 } },
      { type: 'llm/retry-started', time: startedAt + 3000, data: { retry: 1 } },
    ];
    const manager = progressManager(events);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(manager.getTurnProgress('c2c', PEER)?.retry).toBeUndefined();
  });

  it('本轮已结束或日志缺时间时返回 undefined', async () => {
    const closed: SessionEventLike[] = [
      { type: 'turn/start', time: Date.now() - 1000 },
      { type: 'turn/end', time: Date.now(), data: { reason: 'completed' } },
    ];
    const manager = progressManager(closed);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(manager.getTurnProgress('c2c', PEER)).toBeUndefined();
  });
});

// ── 工作树：/new --worktree 显式开树（宿主 worktrees 服务，可选） ──

interface WorktreeTree {
  path: string;
  branch: string;
  baseCommit: string;
  repositoryRoot: string;
}

/** 造一个主仓库（.git 是目录） */
function makeRepo(): string {
  const repo = join(env.home, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  return repo;
}

interface WorktreeOptions {
  create?: (...args: unknown[]) => Promise<WorktreeTree>;
  restore?: (request: WorktreeTree) => Promise<{ path: string; branchRecreated: boolean }>;
  /** 部署默认沙箱模式（默认 workspace-write） */
  mode?: string;
  /** sessionProjections 替身：只处理 worktree 投影 */
  projection?: (key: string) => unknown;
  /** chatDir 的 HEAD（默认 main @ 6b1f02c…）；null = 读不到（非仓库 / 超时） */
  head?: { commit: string; branch?: string } | null;
}

function worktreeCtx(options: WorktreeOptions = {}) {
  const base = hostCtxServices() as Record<string, unknown>;
  const create = vi.fn(options.create ?? (async (): Promise<WorktreeTree> => {
    throw new Error('unexpected worktrees.create');
  }));
  const restore = vi.fn(options.restore ?? (async (request: WorktreeTree) => ({
    path: request.path,
    branchRecreated: false,
  })));
  const head = options.head === undefined ? { commit: '6b1f02c0ffee1234', branch: 'main' } : options.head;
  const subprocess = {
    resolveExecutable: async () => 'git',
    spawn: (spec: { argv: readonly string[] }) => {
      const isRef = spec.argv.includes('symbolic-ref');
      const text = head === null ? '' : (isRef ? (head.branch ?? '') : head.commit);
      return {
        collected: { stdout: { readFrom: () => ({ text }) } },
        done: Promise.resolve({ exitCode: head === null ? 1 : 0 }),
        terminate: () => {},
        waitForExit: async () => undefined,
      };
    },
  };
  const services = {
    ...base,
    subprocess,
    sessionProjections: {
      stateOf: (_session: unknown, key: string) => options.projection?.(key),
    },
    worktrees: { create, restore },
    sandboxPolicy: { resolve: () => ({ mode: options.mode ?? 'workspace-write' }) },
  };
  const ctx = {
    ...services,
    get: (name: string) => (services as Record<string, unknown>)[name],
    on: vi.fn(),
  } as unknown as Context;
  return { ctx, create, restore };
}

describe('getOrCreate — 新会话开在工作树里', () => {
  it('/new --worktree 之后新建会话：从当前分支拉出，落在树路径', async () => {
    const repo = makeRepo();
    const tree: WorktreeTree = {
      path: join(repo, '.agents', 'worktrees', 'dsh-1a2b3c4d-9f0e'),
      branch: 'dsh-1a2b3c4d-9f0e',
      baseCommit: '6b1f02c0ffee1234',
      repositoryRoot: repo,
    };
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const { ctx, create } = worktreeCtx({
      create: async () => tree,
      projection: (key) => (key === 'worktree' ? { created: [{ worktree: tree, owned: true }] } : undefined),
    });
    const manager = createManagerWithCtx(registry, ctx);
    await manager.changeChatWorkspace('c2c', PEER, repo);
    manager.armWorktree();

    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(create).toHaveBeenCalledTimes(1);
    // 基点是 chatDir 的 HEAD 全 sha：detached 也安全，宿主在仓库根也能解析
    expect(create.mock.calls[0]![1]).toEqual({ from: '6b1f02c0ffee1234' });
    // header.cwd 必须是仓库根：树的池与 .git/worktrees 登记都落在它下面
    const createdWith = registry.create.mock.calls[0]![0] as unknown as { meta?: { cwd?: string } };
    expect(createdWith.meta?.cwd).toBe(repo);
    expect(manager.chatDirectory()).toBe(tree.path);
    expect(record.worktreeNotice).toContain('✅ 已在新工作树 `dsh-1a2b3c4d-9f0e` 里开启会话 · 从 `main` 拉出');
    expect(record.worktreeNotice).toContain(`路径: \`${tree.path}\``);
    expect(manager.worktreeOf('c2c', PEER)).toEqual({
      branch: tree.branch,
      baseCommit: tree.baseCommit,
      path: tree.path,
    });
    expect(manager.hasWorktree(record.sessionId)).toBe(true);

    // 第二条消息复用同一个会话，不会二次建树
    const again = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(again).toBe(record);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('建树失败：会话不保留、指针不落盘，意图保留可重试', async () => {
    const repo = makeRepo();
    const tree: WorktreeTree = {
      path: join(repo, '.agents', 'worktrees', 'dsh-x'),
      branch: 'dsh-x',
      baseCommit: '6b1f02c0ffee1234',
      repositoryRoot: repo,
    };
    let attempts = 0;
    const { registry, handles } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const { ctx, create } = worktreeCtx({
      create: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error(
            'Could not finish worktree dsh-x at D:\\repo. Any created checkout and branch are retained. '
            + "fatal: cannot lock ref 'refs/heads/dsh-x'",
          );
        }
        return tree;
      },
    });
    const manager = createManagerWithCtx(registry, ctx);
    await manager.changeChatWorkspace('c2c', PEER, repo);
    manager.armWorktree();

    const first = await manager.getOrCreate('c2c', PEER, PEER, REPLY).then(() => undefined, (err: unknown) => err);
    expect(first).toBeInstanceOf(WorktreeError);
    expect((first as WorktreeError).message).toContain('cannot lock ref');
    // 失败文案要点明起点分支，用户才知道树是从哪儿拉的
    expect((first as WorktreeError).base).toBe('main');

    expect(handles).toHaveLength(1);
    expect(handles[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(handles[0]!.agent.cancel).toHaveBeenCalled();
    // 会话没进已获取集合，指针也没有落下：重发一次会重新尝试
    expect(manager.size).toBe(0);
    expect(persistedId()).toBeUndefined();
    expect(manager.chatDirectory()).toBe(repo);

    await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(create).toHaveBeenCalledTimes(2);
    expect(manager.chatDirectory()).toBe(tree.path);
  });

  it('部署默认只读：不尝试建树，就地开会话并说明原因', async () => {
    const repo = makeRepo();
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const { ctx, create } = worktreeCtx({ mode: 'read-only' });
    const manager = createManagerWithCtx(registry, ctx);
    await manager.changeChatWorkspace('c2c', PEER, repo);
    manager.armWorktree();

    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(create).not.toHaveBeenCalled();
    expect(manager.chatDirectory()).toBe(repo);
    expect(record.worktreeNotice).toBe('⚠️ 沙箱已是只读，本次就地开会话');
    expect(manager.hasWorktree(record.sessionId)).toBe(false);
  });

  it('没有 worktrees 服务：就地开会话，不留工作树痕迹', async () => {
    const repo = makeRepo();
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const manager = createManagerWithCtx(registry, absentCtx());
    await manager.changeChatWorkspace('c2c', PEER, repo);
    // 服务缺失时 /new 会把 --worktree 当未知参数；这里直接 arm，验证兜底不建、也不提部署差异
    manager.armWorktree();

    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(manager.chatDirectory()).toBe(repo);
    expect(record.worktreeNotice).toBeUndefined();
    expect(manager.worktreeOf('c2c', PEER)).toBeUndefined();
  });

  it('从工作树里开会话：基点回主仓库，不在树里再套树', async () => {
    const repo = makeRepo();
    const oldTree = join(repo, '.agents', 'worktrees', 'dsh-old');
    mkdirSync(oldTree, { recursive: true });
    writeFileSync(join(oldTree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'dsh-old')}\n`);
    const tree: WorktreeTree = {
      path: join(repo, '.agents', 'worktrees', 'dsh-new'),
      branch: 'dsh-new',
      baseCommit: 'abc1234',
      repositoryRoot: repo,
    };
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const { ctx, create } = worktreeCtx({ create: async () => tree });
    const manager = createManagerWithCtx(registry, ctx);
    await manager.changeChatWorkspace('c2c', PEER, oldTree);
    manager.armWorktree();

    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(create).toHaveBeenCalledTimes(1);
    // 新会话在主仓库里开新树，而不是在旧树目录里再建池
    const createdWith = registry.create.mock.calls[0]![0] as unknown as { meta?: { cwd?: string } };
    expect(createdWith.meta?.cwd).toBe(repo);
    expect(manager.chatDirectory()).toBe(tree.path);
  });

  it('目录不是 Git 仓库：就地开会话', async () => {
    const plain = join(env.home, 'plain');
    mkdirSync(plain, { recursive: true });
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const { ctx, create } = worktreeCtx();
    const manager = createManagerWithCtx(registry, ctx);
    await manager.changeChatWorkspace('c2c', PEER, plain);
    manager.armWorktree();

    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(create).not.toHaveBeenCalled();
    expect(manager.chatDirectory()).toBe(plain);
    expect(record.worktreeNotice).toBe('⚠️ 当前目录不是 Git 仓库，本次就地开会话');
  });

  it('没要求开树就不建：/new 的意图被 remove 清掉', async () => {
    const repo = makeRepo();
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const { ctx, create } = worktreeCtx();
    const manager = createManagerWithCtx(registry, ctx);
    manager.armWorktree();
    await manager.changeChatWorkspace('c2c', PEER, repo);
    await manager.remove();

    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(create).not.toHaveBeenCalled();
    expect(manager.chatDirectory()).toBe(repo);
  });

  it('建树后意图已消费：/clear 在同一棵树里就地开始', async () => {
    const repo = makeRepo();
    const tree: WorktreeTree = {
      path: join(repo, '.agents', 'worktrees', 'dsh-x'),
      branch: 'dsh-x',
      baseCommit: '6b1f02c0ffee1234',
      repositoryRoot: repo,
    };
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const { ctx, create } = worktreeCtx({ create: async () => tree });
    const manager = createManagerWithCtx(registry, ctx);
    await manager.changeChatWorkspace('c2c', PEER, repo);
    manager.armWorktree();
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    await manager.resetCurrentSession();
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(create).toHaveBeenCalledTimes(1);
    expect(manager.chatDirectory()).toBe(tree.path);
  });

  it('读不到 HEAD：建树失败，本次会话不创建（不降级到主检出）', async () => {
    const repo = makeRepo();
    const tree: WorktreeTree = {
      path: join(repo, '.agents', 'worktrees', 'dsh-x'),
      branch: 'dsh-x',
      baseCommit: '6b1f02c0ffee1234',
      repositoryRoot: repo,
    };
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const { ctx, create } = worktreeCtx({ create: async () => tree, head: null });
    const manager = createManagerWithCtx(registry, ctx);
    await manager.changeChatWorkspace('c2c', PEER, repo);
    manager.armWorktree();

    const failure = await manager.getOrCreate('c2c', PEER, PEER, REPLY).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(WorktreeError);
    expect((failure as WorktreeError).kind).toBe('base');
    expect(registry.create).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(persistedId()).toBeUndefined();
    expect(manager.chatDirectory()).toBe(repo);
  });
});

describe('getOrCreate — 恢复会话时重建被清理的工作树', () => {
  it('树目录不在了：resume 后 restore，目录回树路径', async () => {
    const treeDir = join(env.home, 'gone-tree');
    mkdirSync(treeDir, { recursive: true });
    new PrefsStore().setSessionId(KEY, 'session-current');
    const tree: WorktreeTree = { path: treeDir, branch: 'dsh-x', baseCommit: 'abc1234', repositoryRoot: env.home };
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const { ctx, restore } = worktreeCtx({
      projection: (key) => (key === 'worktree' ? { created: [{ worktree: tree, owned: true }] } : undefined),
    });
    const manager = createManagerWithCtx(registry, ctx);
    await manager.changeChatWorkspace('c2c', PEER, treeDir);
    rmSync(treeDir, { recursive: true, force: true });

    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(restore).toHaveBeenCalledTimes(1);
    expect(manager.chatDirectory()).toBe(treeDir);
  });

  it('重建失败：抛 restore 错误、释放句柄，指针保留', async () => {
    const treeDir = join(env.home, 'gone-tree');
    mkdirSync(treeDir, { recursive: true });
    new PrefsStore().setSessionId(KEY, 'session-current');
    const handle = fakeHandle('session-current');
    const tree: WorktreeTree = { path: treeDir, branch: 'dsh-x', baseCommit: 'abc1234', repositoryRoot: env.home };
    const { registry } = createRegistry(async () => handle);
    const { ctx } = worktreeCtx({
      restore: async () => { throw new Error('fatal: worktree path already exists'); },
      projection: (key) => (key === 'worktree' ? { created: [{ worktree: tree, owned: true }] } : undefined),
    });
    const manager = createManagerWithCtx(registry, ctx);
    await manager.changeChatWorkspace('c2c', PEER, treeDir);
    rmSync(treeDir, { recursive: true, force: true });

    await expect(manager.getOrCreate('c2c', PEER, PEER, REPLY))
      .rejects.toBeInstanceOf(WorktreeError);

    expect(handle.dispose).toHaveBeenCalledTimes(1);
    expect(persistedId()).toBe('session-current');
  });
});
