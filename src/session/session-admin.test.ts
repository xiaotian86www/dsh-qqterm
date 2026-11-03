/**
 * SessionManager 的会话管理能力：列表 / 恢复 / 归档 / 取消归档
 *
 * 宿主侧只提供「列举、stat、归档集」三类事实；切换与归档的编排（释放 agent、
 * 映射回滚、悬空映射重指向、归档前先停工作）都在 manager 里，这里逐条钉住。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
const PEER2 = 'user2';
const KEY = `qqbot:${APP_ID}:c2c:${PEER}`;
const KEY2 = `qqbot:${APP_ID}:c2c:${PEER2}`;
const MINTED = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPLY: ReplyTarget = { scope: 'c2c', targetId: PEER, msgId: 'm1' };

const WORKSPACE = () => join(env.home, 'workspace');

/** 最近一次 createCtx 造的归档集（断言用；每个用例都会被重建） */
let archivedIds = new Set<string>();

/** 最近一次 createCtx 造的 registry 替身（断言宿主调用 / 注入失败用） */
let registryStub: Record<string, unknown> | undefined;

interface StoredSession {
  id: string;
  cwd?: string;
  parentSession?: string;
  origin?: 'subagent';
  createdAt?: number;
}

function fakeAgent(id: string, cwd?: string): DshAgent {
  return {
    id,
    ctx: {} as Context,
    status: 'idle',
    session: {
      id,
      snapshotEvents: () => [],
      ...(cwd === undefined ? {} : { header: { id, cwd } }),
    },
    cancel: vi.fn(),
    followup: vi.fn(),
    whenIdle: vi.fn(async () => {}),
    runMaintenance: vi.fn(async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal)),
  } as unknown as DshAgent;
}

function fakeHandle(id: string, cwd?: string): DshAgentHandle {
  return { agent: fakeAgent(id, cwd), dispose: vi.fn(async () => {}) };
}

function createRegistry() {
  const handles: DshAgentHandle[] = [];
  const registry = {
    get: vi.fn(() => undefined),
    resume: vi.fn(async ({ resumeSessionId }: { resumeSessionId: string }) => {
      const handle = fakeHandle(resumeSessionId);
      handles.push(handle);
      return handle;
    }),
    create: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      const handle = fakeHandle(sessionId);
      handles.push(handle);
      return handle;
    }),
  };
  return { registry, handles };
}

function createLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function createCtx(options: {
  sessions?: StoredSession[];
  withQuery?: boolean;
  /** 初始归档集 */
  archived?: string[];
  /** false = 模拟旧宿主没有 workspaceRegistry */
  withRegistry?: boolean;
  /** 让宿主的归档调用抛指定错误（按 name 识别） */
  archiveThrows?: 'WorkspaceUnknownSessionError' | 'WorkspaceActiveSessionError';
  /** 模拟宿主 workingDirectory 服务（默认工作目录 / 会话生效目录） */
  workingDirectory?: { defaultDirectory?: string; get?: (session: unknown) => string };
  resume?: (sessionId: string) => Promise<DshAgentHandle>;
}): Context {
  const sessions = options.sessions ?? [];
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const persistence = {
    stat: async (id: string) => (byId.has(id) ? { header: { id, cwd: byId.get(id)?.cwd ?? WORKSPACE() } } : undefined),
    list: async () => sessions.map((session) => ({ header: session })),
  };
  const query = options.withQuery
    ? {
      listSessions: async () => sessions.map((session) => ({ header: session, live: false })),
      readTitleSnapshots: async (ids: readonly string[]) => ids.map((id) => ({
        sessionId: id,
        status: 'fulfilled' as const,
        value: { session: { id }, title: { title: `标题-${id.slice(-4)}` } },
      })),
    }
    : undefined;

  archivedIds = new Set(options.archived ?? []);
  const throwArchive = (): never => {
    const error = new Error(`mock ${options.archiveThrows}`);
    error.name = options.archiveThrows ?? 'Error';
    throw error;
  };
  const registry = {
    create: vi.fn(async (path: string) => ({
      path,
      title: basename(path),
      attachSession: async () => {},
    })),
    list: vi.fn(() => [] as Array<{ id: string; path: string; title: string; sessionIds: string[] }>),
    get archivedSessionIds(): readonly string[] {
      return [...archivedIds];
    },
    archiveSession: vi.fn(async (id: string): Promise<void> => {
      if (options.archiveThrows !== undefined) throwArchive();
      archivedIds.add(id);
    }),
    unarchiveSession: vi.fn(async (id: string): Promise<void> => {
      archivedIds.delete(id);
    }),
  };
  registryStub = options.withRegistry === false ? undefined : registry;

  return {
    get: (name: string) => {
      if (name === 'sessionPersistence') return persistence;
      if (name === 'sessionQuery') return query;
      if (name === 'workspaceRegistry') return registryStub;
      if (name === 'workingDirectory') return options.workingDirectory;
      return undefined;
    },
    on: vi.fn(),
  } as unknown as Context;
}

function createManager(ctx: Context, registry = createRegistry().registry, logger = createLogger()) {
  const config = ConfigSchema({
    appId: APP_ID,
    appSecret: 'secret',
    provider: 'p',
    model: 'm',
    sessionIdleTimeout: 0,
  } as ImQQBotConfig);
  const manager = new SessionManager(ctx, registry as DshAgentRegistry, config, logger);
  managers.push(manager);
  return { manager, registry, logger };
}

const managers: Array<InstanceType<typeof SessionManager>> = [];

/** 造一个磁盘上的会话目录 */
function persistedId(key = KEY): string | undefined {
  return new PrefsStore().getSessionId(key);
}

beforeEach(() => {
  env.home = mkdtempSync(join(tmpdir(), 'im-qqbot-admin-'));
  mkdirSync(WORKSPACE(), { recursive: true });
  archivedIds = new Set();
  registryStub = undefined;
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
  rmSync(env.home, { recursive: true, force: true });
});

describe('listWorkspaceSessions', () => {
  it('只列本工作区、非 subagent 的会话，按创建时间倒序并标记 current', async () => {
    const current = 'session-current';
    new PrefsStore().setSessionId(KEY, current);
    const ctx = createCtx({
      withQuery: true,
      sessions: [
        { id: 'session-old', cwd: WORKSPACE(), createdAt: 100 },
        { id: current, cwd: WORKSPACE(), createdAt: 300 },
        { id: 'session-other', cwd: join(env.home, 'other'), createdAt: 500 },
        { id: 'session-child', cwd: WORKSPACE(), createdAt: 400, origin: 'subagent', parentSession: 'session-old' },
      ],
    });

    const { manager } = createManager(ctx);
    const entries = await manager.listWorkspaceSessions('c2c', PEER);

    expect(entries.map((entry) => entry.id)).toEqual([current, 'session-old']);
    expect(entries[0]?.current).toBe(true);
    expect(entries[1]?.current).toBe(false);
    expect(entries[0]?.title).toContain('标题-');
  });

  it('Windows 路径大小写差异不影响过滤', async () => {
    const ctx = createCtx({
      sessions: [{ id: 'session-a', cwd: WORKSPACE().toUpperCase(), createdAt: 1 }],
    });
    const { manager } = createManager(ctx);
    const entries = await manager.listWorkspaceSessions('c2c', PEER);
    expect(entries.map((entry) => entry.id)).toEqual(['session-a']);
  });

  it('归档的会话仍然列出，但带 archived 标记（过滤交给展示层）', async () => {
    const ctx = createCtx({
      sessions: [
        { id: 'session-open', cwd: WORKSPACE(), createdAt: 2 },
        { id: 'session-archived', cwd: WORKSPACE(), createdAt: 1 },
      ],
      archived: ['session-archived'],
    });
    const { manager } = createManager(ctx);

    const entries = await manager.listWorkspaceSessions('c2c', PEER);

    expect(entries.map((entry) => [entry.id, entry.archived])).toEqual([
      ['session-open', false],
      ['session-archived', true],
    ]);
  });

  it('没有 sessionQuery 时回退 persistence.list（无标题）', async () => {
    const ctx = createCtx({ sessions: [{ id: 'session-a', cwd: WORKSPACE(), createdAt: 1 }] });
    const { manager } = createManager(ctx);
    const entries = await manager.listWorkspaceSessions('c2c', PEER);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBeUndefined();
  });
});

describe('switchSession', () => {
  it('恢复成功：旧 agent 被释放、映射落到目标会话', async () => {
    const target = 'session-target';
    const ctx = createCtx({ sessions: [{ id: target, cwd: WORKSPACE() }] });
    const { manager } = createManager(ctx);

    const before = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(before.sessionId).not.toBe(target);

    const outcome = await manager.switchSession('c2c', PEER, target, PEER, REPLY);

    expect(outcome).toEqual({ ok: true });
    expect(before.handle.dispose).toHaveBeenCalled();
    expect(persistedId()).toBe(target);
  });

  it('恢复归档会话：先取消归档，成功结果带 unarchived 标记', async () => {
    const target = 'session-archived';
    const ctx = createCtx({ sessions: [{ id: target, cwd: WORKSPACE() }], archived: [target] });
    const { manager } = createManager(ctx);

    const outcome = await manager.switchSession('c2c', PEER, target, PEER, REPLY);

    expect(outcome.ok).toBe(true);
    expect(outcome.unarchived).toBe(true);
    expect(archivedIds.has(target)).toBe(false);
    expect(persistedId()).toBe(target);
  });

  it('取消归档失败时拒绝恢复，映射保持原样', async () => {
    const target = 'session-archived';
    new PrefsStore().setSessionId(KEY, 'session-original');
    const ctx = createCtx({ sessions: [{ id: target, cwd: WORKSPACE() }], archived: [target] });
    (registryStub?.['unarchiveSession'] as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('EIO'));
    const { manager } = createManager(ctx);

    const outcome = await manager.switchSession('c2c', PEER, target, PEER, REPLY);

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('取消归档失败');
    expect(persistedId()).toBe('session-original');
  });

  it('目标会话不存在：不改映射，也不触发 resume', async () => {
    const ctx = createCtx({ sessions: [] });
    const { manager, registry } = createManager(ctx);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const original = persistedId();

    const outcome = await manager.switchSession('c2c', PEER, 'session-missing', PEER, REPLY);

    expect(outcome.reason).toBe('not-found');
    expect(persistedId()).toBe(original);
    expect(registry.resume).toHaveBeenCalledTimes(1); // 只有首次 getOrCreate 那次
  });

  it('恢复失败：映射回滚到原会话，并把半成品记录清掉', async () => {
    const target = 'session-target';
    new PrefsStore().setSessionId(KEY, 'session-original');
    // 目标会话在盘上（存在性求证为 true），但 resume 被别的进程占用
    const ctx = createCtx({ sessions: [{ id: 'session-original', cwd: WORKSPACE() }, { id: target, cwd: WORKSPACE() }] });
    const { manager, registry } = createManager(ctx);
    registry.resume.mockImplementation(async ({ resumeSessionId }: { resumeSessionId: string }) => {
      if (resumeSessionId === target) throw new Error('ownership taken by web');
      return fakeHandle(resumeSessionId);
    });

    const outcome = await manager.switchSession('c2c', PEER, target, PEER, REPLY);

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('ownership taken');
    expect(persistedId()).toBe('session-original');
    expect(manager.getSessionRecord('c2c', PEER)).toBeUndefined();
  });

  it('会话正被另一个聊天持有时拒绝切换', async () => {
    const shared = 'session-shared';
    new PrefsStore().setSessionId(KEY2, shared);
    const ctx = createCtx({ sessions: [{ id: shared, cwd: WORKSPACE() }] });
    const { manager } = createManager(ctx);
    await manager.getOrCreate('c2c', PEER2, PEER2, REPLY);

    const outcome = await manager.switchSession('c2c', PEER, shared, PEER, REPLY);

    expect(outcome.reason).toBe('in-use');
  });
});

describe('archiveSession', () => {
  it('归档当前会话：释放记录、写归档集、把映射换成新会话', async () => {
    const id = 'session-doomed';
    new PrefsStore().setSessionId(KEY, id);
    const ctx = createCtx({ sessions: [{ id, cwd: WORKSPACE() }] });
    const { registry, handles } = createRegistry();
    const { manager } = createManager(ctx, registry);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    const outcome = await manager.archiveSession(id);

    expect(outcome.ok).toBe(true);
    expect(outcome.remapped).toBe(1);
    expect(archivedIds.has(id)).toBe(true);
    // 进程内 agent 必须先停掉，否则宿主会把会话判成「仍在运行」
    expect(handles[0]?.dispose).toHaveBeenCalled();
    expect(manager.getSessionRecord('c2c', PEER)).toBeUndefined();
    // 映射不能还指着归档会话，否则下一条消息会被宿主的 pre-step 闸门拒掉
    expect(persistedId()).toMatch(MINTED);
    expect(persistedId()).not.toBe(id);
  });

  it('归档别的聊天正在用的会话：映射也被改写成新会话', async () => {
    const id = 'session-shared';
    new PrefsStore().setSessionId(KEY2, id);
    const ctx = createCtx({ sessions: [{ id, cwd: WORKSPACE() }] });
    const { manager } = createManager(ctx);

    const outcome = await manager.archiveSession(id);

    expect(outcome.ok).toBe(true);
    expect(new PrefsStore().getSessionId(KEY2)).toMatch(MINTED);
    expect(new PrefsStore().getSessionId(KEY2)).not.toBe(id);
  });

  it('重复归档是幂等的：仍返回成功并标记 alreadyArchived', async () => {
    const id = 'session-already';
    const ctx = createCtx({ sessions: [{ id, cwd: WORKSPACE() }], archived: [id] });
    const { manager } = createManager(ctx);

    const outcome = await manager.archiveSession(id);

    expect(outcome.ok).toBe(true);
    expect(outcome.alreadyArchived).toBe(true);
  });

  it('宿主报会话不存在时归一成 not-found', async () => {
    const id = 'session-gone';
    const ctx = createCtx({
      sessions: [{ id, cwd: WORKSPACE() }],
      archiveThrows: 'WorkspaceUnknownSessionError',
    });
    const { manager } = createManager(ctx);

    const outcome = await manager.archiveSession(id);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('not-found');
  });

  it('宿主报会话仍活跃时归一成 busy，且不动映射', async () => {
    const id = 'session-busy';
    new PrefsStore().setSessionId(KEY, id);
    const ctx = createCtx({
      sessions: [{ id, cwd: WORKSPACE() }],
      archiveThrows: 'WorkspaceActiveSessionError',
    });
    const { manager } = createManager(ctx);

    const outcome = await manager.archiveSession(id);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('busy');
    expect(persistedId()).toBe(id);
  });

  it('宿主没有 workspaceRegistry 时降级为 unavailable', async () => {
    const ctx = createCtx({ sessions: [{ id: 'session-x', cwd: WORKSPACE() }], withRegistry: false });
    const { manager } = createManager(ctx);

    const outcome = await manager.archiveSession('session-x');

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('unavailable');
  });
});

describe('工作区跟随会话', () => {
  it('新会话落在宿主的默认工作区目录（不再用插件固定目录）', async () => {
    const defaultWs = join(env.home, 'default-ws');
    mkdirSync(defaultWs, { recursive: true });
    const ctx = createCtx({ sessions: [], workingDirectory: { defaultDirectory: defaultWs } });
    const { manager } = createManager(ctx);

    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(registryStub?.['create']).toHaveBeenCalledWith(defaultWs);
    expect(new PrefsStore().getDirectory(KEY)).toBe(defaultWs);
  });

  it('切换到别的工作区的会话后，目录与 /sessions 范围一起跟着切', async () => {
    const other = join(env.home, 'other-ws');
    mkdirSync(other, { recursive: true });
    const ctx = createCtx({
      withQuery: true,
      sessions: [
        { id: 'session-a', cwd: WORKSPACE(), createdAt: 1 },
        { id: 'session-b', cwd: other, createdAt: 2 },
      ],
    });
    const { registry } = createRegistry();
    registry.resume.mockImplementation(async ({ resumeSessionId }: { resumeSessionId: string }) => (
      fakeHandle(resumeSessionId, resumeSessionId === 'session-b' ? other : WORKSPACE())
    ));
    const { manager } = createManager(ctx, registry);

    await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(await manager.listWorkspaceSessions('c2c', PEER)).toHaveLength(1);

    const outcome = await manager.switchSession('c2c', PEER, 'session-b', PEER, REPLY);

    expect(outcome.ok).toBe(true);
    // 目录记录跟着目标会话走，重启后也不会退回旧工作区
    expect(new PrefsStore().getDirectory(KEY)).toBe(other);
    const entries = await manager.listWorkspaceSessions('c2c', PEER);
    expect(entries.map((entry) => entry.id)).toEqual(['session-b']);
  });

  it('/new 之后仍然留在同一个工作区', async () => {
    const defaultWs = join(env.home, 'default-ws');
    mkdirSync(defaultWs, { recursive: true });
    const ctx = createCtx({ sessions: [], workingDirectory: { defaultDirectory: defaultWs } });
    const { manager } = createManager(ctx);

    await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await manager.remove('c2c', PEER);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(new PrefsStore().getDirectory(KEY)).toBe(defaultWs);
    // 两次创建都落在同一个目录
    const calls = (registryStub?.['create'] as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((args) => args[0] === defaultWs)).toBe(true);
  });
});

describe('unarchiveSession', () => {
  it('把 id 从归档集里去掉', async () => {
    const id = 'session-back';
    const ctx = createCtx({ sessions: [{ id, cwd: WORKSPACE() }], archived: [id] });
    const { manager } = createManager(ctx);

    const outcome = await manager.unarchiveSession(id);

    expect(outcome.ok).toBe(true);
    expect(archivedIds.has(id)).toBe(false);
  });

  it('宿主没有归档能力时返回 unavailable', async () => {
    const ctx = createCtx({ sessions: [], withRegistry: false });
    const { manager } = createManager(ctx);

    const outcome = await manager.unarchiveSession('session-x');

    expect(outcome.reason).toBe('unavailable');
  });
});
