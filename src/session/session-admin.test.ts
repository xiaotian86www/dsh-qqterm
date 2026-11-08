/**
 * SessionManager 的会话管理能力：列表 / 恢复 / 归档 / 取消归档
 *
 * 宿主侧只提供「列举、stat、归档集」三类事实；切换与归档的编排（释放 agent、
 * 映射回滚、悬空映射重指向、归档前先停工作）都在 manager 里，这里逐条钉住。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { ConfigSchema, type QQTermConfig } from '../config.ts';
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
/** 聊天会话只有一个 */
const KEY = `qqterm:${APP_ID}:chat`;
const REPLY: ReplyTarget = { scope: 'c2c', targetId: PEER };
const PEER_B = 'user2';
const REPLY_B: ReplyTarget = { scope: 'c2c', targetId: PEER_B };

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

/** inject 保证存在的宿主服务 */
function hostServices() {
  return {
    llm: { listProviders: () => [{ id: 'p', name: 'p' }], listModels: async () => [], resolveModelInfo: async () => ({}) },
    sessionProjections: { stateOf: () => undefined },
    sessionController: {
      selectModel: async (request: { provider: string; model: string; reasoningEffort?: string }) => ({
        selected: {
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}),
        },
      }),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
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
  /** registry 里的工作区（`/new <工作区>` 按标题匹配、`/sessions all` 分组用） */
  workspaces?: Array<{ id: string; path: string; title: string; sessionIds?: string[] }>;
  resume?: (sessionId: string) => Promise<DshAgentHandle>;
  /** 模拟宿主 sessionTitle 服务（/rename 用） */
  sessionTitle?: { rename: (session: unknown, title: string) => { title: string } };
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
    list: vi.fn(() => (options.workspaces ?? []).map((workspace) => ({
      ...workspace,
      sessionIds: workspace.sessionIds ?? [],
    }))),
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
    ...hostServices(),
    sessionPersistence: persistence,
    sessionQuery: query ?? {
      listSessions: async () => sessions.map((session) => ({ header: session, live: false })),
      readTitleSnapshots: async () => [],
    },
    workingDirectory: options.workingDirectory,
    workspaceRegistry: registryStub ?? {
      list: () => [],
      create: async (path: string) => ({ path, title: basename(path), attachSession: async () => {} }),
    },
    sessionTitle: options.sessionTitle ?? { rename: () => ({ title: '' }) },
    agentPresets: { serviceFor: () => undefined },
    permissionPresets: { names: [], optionOf: () => undefined },
    get: (name: string) => {
      if (name === 'sessionPersistence') return persistence;
      if (name === 'sessionQuery') return query;
      if (name === 'workspaceRegistry') return registryStub;
      if (name === 'workingDirectory') return options.workingDirectory;
      if (name === 'sessionTitle') return options.sessionTitle;
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
  } as QQTermConfig);
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
  env.home = mkdtempSync(join(tmpdir(), 'qqterm-admin-'));
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

  it('条目带工作区字段：归档候选按它分组，缺了会全落进「未分组」', async () => {
    const ctx = createCtx({
      withQuery: true,
      sessions: [{ id: 'session-a', cwd: WORKSPACE(), createdAt: 1 }],
      workspaces: [{ id: 'ws-1', path: WORKSPACE(), title: 'repo' }],
    });
    const { manager } = createManager(ctx);

    const entries = await manager.listWorkspaceSessions('c2c', PEER);

    const slashed = (value: string): string => value.replace(/\\/g, '/').toLowerCase();
    expect(entries[0]?.workspace).toBe('repo');
    expect(slashed(entries[0]?.workspacePath ?? '')).toBe(slashed(WORKSPACE()));
    expect(entries[0]?.workspaceMissing).toBe(false);
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

  it('获取过的会话带 held / running 标记，未获取的为 false', async () => {
    const held = 'session-held';
    const ctx = createCtx({
      withQuery: true,
      sessions: [
        { id: held, cwd: WORKSPACE(), createdAt: 2 },
        { id: 'session-cold', cwd: WORKSPACE(), createdAt: 1 },
      ],
    });
    const { manager } = createManager(ctx);

    await manager.switchSession('c2c', PEER, held, PEER, REPLY);
    const runningRecord = manager.findBySessionId(held);
    runningRecord!.agent.status = 'running';

    const entries = await manager.listWorkspaceSessions('c2c', PEER);
    expect(entries.map((entry) => [entry.id, entry.held, entry.running])).toEqual([
      [held, true, true],
      ['session-cold', false, false],
    ]);
  });
});

describe('listWorkspaceGroups', () => {
  it('持有会话在分组视图里带 held 标记', async () => {
    const held = 'session-held';
    const ctx = createCtx({
      withQuery: true,
      sessions: [{ id: held, cwd: WORKSPACE(), createdAt: 1 }],
      workspaces: [{ id: 'w1', path: WORKSPACE(), title: 'repo', sessionIds: [held] }],
    });
    const { manager } = createManager(ctx);
    await manager.switchSession('c2c', PEER, held, PEER, REPLY);
    manager.findBySessionId(held)!.agent.status = 'running';

    const groups = await manager.listWorkspaceGroups('c2c', PEER);
    const entry = groups.flatMap((group) => group.sessions).find((session) => session.id === held);

    expect(entry).toMatchObject({ held: true, running: true, workspace: 'repo' });
  });
});

describe('listHeldSessions', () => {
  it('跨工作区列出持有会话，当前项优先并带标题 / 工作区', async () => {
    const current = 'session-current';
    const other = join(env.home, 'other-ws');
    mkdirSync(other, { recursive: true });
    const ctx = createCtx({
      withQuery: true,
      sessions: [
        { id: current, cwd: WORKSPACE(), createdAt: 2 },
        { id: 'session-other', cwd: other, createdAt: 1 },
      ],
      workspaces: [
        { id: 'w1', path: WORKSPACE(), title: 'repo', sessionIds: [current] },
        { id: 'w2', path: other, title: 'docs', sessionIds: ['session-other'] },
      ],
    });
    const { manager } = createManager(ctx);

    await manager.switchSession('c2c', PEER, 'session-other', PEER, REPLY);
    await manager.switchSession('c2c', PEER, current, PEER, REPLY);

    const entries = await manager.listHeldSessions('c2c', PEER);
    expect(entries.map((entry) => [
      entry.id,
      entry.current,
      entry.held,
      entry.workspace,
      entry.workspacePath,
      entry.workspaceMissing,
    ])).toEqual([
      [current, true, true, 'repo', WORKSPACE(), false],
      ['session-other', false, true, 'docs', other, false],
    ]);
    expect(entries[0]?.title).toContain('标题-');
  });

  it('工作区目录已不存在时标记 missing，并用目录名兜底标题', async () => {
    const gone = join(env.home, 'gone-ws');
    const ctx = createCtx({
      withQuery: true,
      sessions: [{ id: 'session-gone', cwd: gone, createdAt: 1 }],
    });
    const { manager } = createManager(ctx);

    await manager.switchSession('c2c', PEER, 'session-gone', PEER, REPLY);
    const entries = await manager.listHeldSessions('c2c', PEER);

    expect(entries[0]).toMatchObject({
      id: 'session-gone',
      workspace: 'gone-ws',
      workspacePath: gone,
      workspaceMissing: true,
    });
  });

  it('宿主列表暂时没有返回的持有会话也保留（用获取时间兜底）', async () => {
    const ctx = createCtx({ sessions: [] });
    const { manager } = createManager(ctx);

    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const entries = await manager.listHeldSessions('c2c', PEER);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: record.sessionId,
      current: true,
      held: true,
      live: true,
    });
  });
});

describe('switchSession', () => {
  it('恢复成功：只切 current，旧 agent 保留并继续接收', async () => {
    const target = 'session-target';
    const ctx = createCtx({ sessions: [{ id: target, cwd: WORKSPACE() }] });
    const { manager } = createManager(ctx);

    const before = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(before.sessionId).not.toBe(target);

    const outcome = await manager.switchSession('c2c', PEER, target, PEER, REPLY);

    expect(outcome).toEqual({ ok: true });
    // 设计 v8：切走不 dispose、不 cancel，旧会话仍在已获取集合里继续回 QQ
    expect(before.handle?.dispose).not.toHaveBeenCalled();
    expect(manager.findBySessionId(before.sessionId)).toBe(before);
    expect(manager.getSessionRecord('c2c', PEER)?.sessionId).toBe(target);
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

  it('恢复失败：映射保持原样，也不留下半成品记录', async () => {
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
    expect(outcome.reason).toBe('locked');
    expect(persistedId()).toBe('session-original');
    expect(manager.getSessionRecord('c2c', PEER)).toBeUndefined();
  });

  it('归档不是当前的会话：不动当前映射', async () => {
    new PrefsStore().setSessionId(KEY, 'session-current');
    const ctx = createCtx({ sessions: [{ id: 'session-other', cwd: WORKSPACE() }] });
    const { manager } = createManager(ctx);

    const outcome = await manager.archiveSession('session-other');

    expect(outcome.ok).toBe(true);
    expect(new PrefsStore().getSessionId(KEY)).toBe('session-current');
  });
});

describe('archiveSession', () => {
  it('归档当前会话：释放记录、写归档集、清空映射', async () => {
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
    expect(persistedId()).toBeUndefined();
    expect(manager.currentSessionId()).toBeUndefined();
  });

  it('归档别的会话：映射不指向它就保持不变', async () => {
    const id = 'session-shared';
    new PrefsStore().setSessionId(KEY, 'session-current');
    const ctx = createCtx({ sessions: [{ id, cwd: WORKSPACE() }] });
    const { manager } = createManager(ctx);

    const outcome = await manager.archiveSession(id);

    expect(outcome.ok).toBe(true);
    expect(new PrefsStore().getSessionId(KEY)).toBe('session-current');
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
    await manager.remove();
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(new PrefsStore().getDirectory(KEY)).toBe(defaultWs);
    // 两次创建都落在同一个目录
    const calls = (registryStub?.['create'] as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((args) => args[0] === defaultWs)).toBe(true);
  });
});

describe('changeChatWorkspace（换工作区）', () => {
  const OTHER = () => join(env.home, 'other-ws');

  it('还没有会话时按标题切换，记录落到 prefs', async () => {
    mkdirSync(OTHER(), { recursive: true });
    const ctx = createCtx({ workspaces: [{ id: 'w2', path: OTHER(), title: 'other-ws' }] });
    const { manager } = createManager(ctx);

    const outcome = await manager.changeChatWorkspace('c2c', PEER, 'other-ws');

    expect(outcome).toMatchObject({ ok: true, title: 'other-ws', path: OTHER(), isNew: false });
    expect(new PrefsStore().getDirectory(KEY)).toBe(OTHER());
  });

  it('大小写不敏感，也认目录名和唯一前缀', async () => {
    mkdirSync(OTHER(), { recursive: true });
    const renamed = join(env.home, 'renamed');
    mkdirSync(renamed, { recursive: true });
    const ctx = createCtx({
      workspaces: [
        { id: 'w2', path: OTHER(), title: 'other-ws' },
        { id: 'w3', path: renamed, title: '用户改过的标题' },
      ],
    });
    const { manager } = createManager(ctx);

    expect(await manager.changeChatWorkspace('c2c', PEER, 'OTHER-WS')).toMatchObject({ ok: true });
    // 标题被改过时，目录名仍然能选中它
    expect(await manager.changeChatWorkspace('c2c', PEER, 'renamed')).toMatchObject({
      ok: true,
      title: '用户改过的标题',
    });
    // 前缀只要唯一就认
    expect(await manager.changeChatWorkspace('c2c', PEER, 'other')).toMatchObject({ ok: true });
  });

  it('标题有歧义时返回候选，不写记录', async () => {
    // 目录名不能参与匹配（否则 basename 会把前缀歧义解掉），所以用 a1 / b1
    const a = join(env.home, 'a1');
    const b = join(env.home, 'b1');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const ctx = createCtx({
      workspaces: [
        { id: 'w1', path: a, title: 'repo-x' },
        { id: 'w2', path: b, title: 'repo-y' },
      ],
    });
    const { manager } = createManager(ctx);

    const outcome = await manager.changeChatWorkspace('c2c', PEER, 'repo');

    expect(outcome).toMatchObject({ ok: false, reason: 'ambiguous', matches: ['repo-x', 'repo-y'] });
    expect(new PrefsStore().getDirectory(KEY)).toBeUndefined();
  });

  it('全等优先于前缀：repo 不会命中 repo-old', async () => {
    const a = join(env.home, 'repo');
    const b = join(env.home, 'repo-old');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const ctx = createCtx({
      workspaces: [
        { id: 'w1', path: a, title: 'repo' },
        { id: 'w2', path: b, title: 'repo-old' },
      ],
    });
    const { manager } = createManager(ctx);

    expect(await manager.changeChatWorkspace('c2c', PEER, 'repo')).toMatchObject({ ok: true, title: 'repo' });
    expect(await manager.changeChatWorkspace('c2c', PEER, 'repo-')).toMatchObject({ ok: true, title: 'repo-old' });
  });

  it('绝对路径可以指向宿主还不认识的新目录', async () => {
    const fresh = join(env.home, 'brand-new');
    mkdirSync(fresh, { recursive: true });
    const ctx = createCtx({ workspaces: [] });
    const { manager } = createManager(ctx);

    const outcome = await manager.changeChatWorkspace('c2c', PEER, fresh);

    expect(outcome).toMatchObject({ ok: true, isNew: true, path: fresh, title: 'brand-new' });
  });

  it('目录不存在 / 不是目录时拒绝，且不写记录', async () => {
    const file = join(env.home, 'a-file.txt');
    writeFileSync(file, 'x');
    const ctx = createCtx({ workspaces: [] });
    const { manager } = createManager(ctx);

    expect(await manager.changeChatWorkspace('c2c', PEER, join(env.home, 'nope'))).toMatchObject({
      ok: false,
      reason: 'missing',
    });
    expect(await manager.changeChatWorkspace('c2c', PEER, file)).toMatchObject({
      ok: false,
      reason: 'missing',
    });
    expect(new PrefsStore().getDirectory(KEY)).toBeUndefined();
  });

  it('已经有落盘的会话时拒绝，并给出挡路的会话 id', async () => {
    const other = OTHER();
    mkdirSync(other, { recursive: true });
    new PrefsStore().setSessionId(KEY, 'session-a');
    const ctx = createCtx({
      withQuery: true,
      sessions: [{ id: 'session-a', cwd: WORKSPACE() }],
    });
    const { manager } = createManager(ctx);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    const outcome = await manager.changeChatWorkspace('c2c', PEER, other);

    expect(outcome).toMatchObject({ ok: false, reason: 'has-session', sessionId: 'session-a' });
    expect(new PrefsStore().getDirectory(KEY)).toBe(WORKSPACE());
  });

  it('/new 之后又能改，且下一个会话真的落在新目录', async () => {
    const other = OTHER();
    mkdirSync(other, { recursive: true });
    new PrefsStore().setSessionId(KEY, 'session-a');
    const ctx = createCtx({
      withQuery: true,
      sessions: [{ id: 'session-a', cwd: WORKSPACE() }],
    });
    const { registry } = createRegistry();
    registry.resume.mockImplementation(async ({ resumeSessionId }: { resumeSessionId: string }) => {
      // 老会话能 resume；/new 清掉指针后没有会话，直接走创建分支
      if (resumeSessionId === 'session-a') return fakeHandle('session-a', WORKSPACE());
      throw new Error('session not found');
    });
    const { manager } = createManager(ctx, registry);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(await manager.changeChatWorkspace('c2c', PEER, other)).toMatchObject({
      ok: false,
      reason: 'has-session',
    });

    await manager.remove(); // = /new

    expect(await manager.changeChatWorkspace('c2c', PEER, other)).toMatchObject({ ok: true });

    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    // 新会话的 meta.cwd 与工作区归属都用新目录
    const createCall = registry.create.mock.calls.at(-1)?.[0] as { meta?: { cwd?: string } } | undefined;
    expect(createCall?.meta?.cwd).toBe(other);
    expect(registryStub?.['create']).toHaveBeenCalledWith(other);
  });
});

describe('多会话：已获取集合 / /to / 切走不释放', () => {
  const TARGET = 'session-live-target';

  /** 造一个 live agent，并让 registry.get 只命中指定 id */
  function liveRegistry(id = TARGET) {
    const agent = fakeAgent(id);
    const { registry, handles } = createRegistry();
    registry.get.mockImplementation((sessionId: string) => (sessionId === id ? agent : undefined));
    return { agent, registry, handles };
  }

  it('/to 获取 live 会话：加入已获取集合、不改 current、没有 handle', async () => {
    const { agent, registry } = liveRegistry();
    const ctx = createCtx({ sessions: [{ id: 'session-current', cwd: WORKSPACE() }] });
    const { manager } = createManager(ctx, registry);

    const current = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const outcome = await manager.sendTo('c2c', PEER, PEER, TARGET, '继续', REPLY);

    expect(outcome).toEqual({ ok: true, kind: 'sent', sessionId: TARGET });
    expect(agent.followup).toHaveBeenCalledTimes(1);
    const acquired = manager.findBySessionId(TARGET);
    expect(acquired).toBeDefined();
    expect(acquired?.handle).toBeUndefined();
    expect(manager.getSessionRecord('c2c', PEER)?.sessionId).toBe(current.sessionId);
  });

  it('/to 目标不 live 时拒绝，不创建记录', async () => {
    const ctx = createCtx({ sessions: [] });
    const { manager } = createManager(ctx);

    const outcome = await manager.sendTo('c2c', PEER, PEER, 'session-cold', 'hi', REPLY);

    expect(outcome).toMatchObject({ ok: false, reason: 'not-running' });
    expect(manager.findBySessionId('session-cold')).toBeUndefined();
    expect(manager.size).toBe(0);
  });

  it('/to 目标在等答案时走答案通道，不再 followup', async () => {
    const { agent, registry } = liveRegistry();
    const ctx = createCtx({ sessions: [] });
    const { manager } = createManager(ctx, registry);
    const answer = vi.fn(() => true);
    const beginAnswerMode = vi.fn();
    manager.questionChannel = {
      hasPending: () => true,
      answer,
      beginAnswerMode,
      cancelPending: vi.fn(),
    } as unknown as NonNullable<typeof manager.questionChannel>;

    const outcome = await manager.sendTo('c2c', PEER, PEER, TARGET, 'B', REPLY);

    expect(outcome).toEqual({ ok: true, kind: 'answered', sessionId: TARGET });
    expect(answer).toHaveBeenCalledWith(TARGET, 'B');
    expect(agent.followup).not.toHaveBeenCalled();
  });

  it('/to 空文本 + 待答问题 → 进入回答模式', async () => {
    const { registry } = liveRegistry();
    const ctx = createCtx({ sessions: [] });
    const { manager } = createManager(ctx, registry);
    const beginAnswerMode = vi.fn();
    manager.questionChannel = {
      hasPending: () => true,
      answer: vi.fn(() => false),
      beginAnswerMode,
      cancelPending: vi.fn(),
    } as unknown as NonNullable<typeof manager.questionChannel>;

    const outcome = await manager.sendTo('c2c', PEER, PEER, TARGET, '', REPLY);

    expect(outcome).toEqual({ ok: true, kind: 'answer-mode', sessionId: TARGET });
    expect(beginAnswerMode).toHaveBeenCalledWith(PEER, TARGET);
  });

  it('/sessions resume 到已获取会话：只改指针，不再 resume/dispose', async () => {
    const { registry, handles } = liveRegistry();
    const ctx = createCtx({ sessions: [{ id: TARGET, cwd: WORKSPACE() }] });
    const { manager } = createManager(ctx, registry);

    const first = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await manager.sendTo('c2c', PEER, PEER, TARGET, 'hi', REPLY);
    registry.resume.mockClear();

    const outcome = await manager.switchSession('c2c', PEER, TARGET, PEER, REPLY);

    expect(outcome).toEqual({ ok: true });
    expect(registry.resume).not.toHaveBeenCalled();
    expect(first.handle?.dispose).not.toHaveBeenCalled();
    expect(manager.findBySessionId(first.sessionId)).toBe(first);
    expect(manager.getSessionRecord('c2c', PEER)?.sessionId).toBe(TARGET);
    expect(handles).toHaveLength(1); // 首次 getOrCreate 创建的那个，仍在
  });

  it('/to 别人的会话拒绝，不转发', async () => {
    const { agent, registry } = liveRegistry();
    const ctx = createCtx({ sessions: [] });
    const { manager } = createManager(ctx, registry);
    await manager.sendTo('c2c', PEER, PEER, TARGET, 'hi', REPLY);

    const outcome = await manager.sendTo('c2c', PEER_B, PEER_B, TARGET, '越权', REPLY_B);

    expect(outcome).toMatchObject({ ok: false, reason: 'forbidden' });
    expect(agent.followup).toHaveBeenCalledTimes(1); // 只有第一次
  });

  it('卸载：只 dispose 自己创建的 agent，借来的只丢引用', async () => {
    const { agent, registry, handles } = liveRegistry();
    const ctx = createCtx({ sessions: [] });
    const { manager } = createManager(ctx, registry);

    await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await manager.sendTo('c2c', PEER, PEER, TARGET, 'hi', REPLY);
    await manager.disposeAll();

    expect(handles[0]?.dispose).toHaveBeenCalled();
    expect(agent.cancel).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });

  it('外部把同一 id 换成另一个 agent：旧记录被摘掉，不再转发', async () => {
    const { registry } = liveRegistry();
    const ctx = createCtx({ sessions: [] });
    const { manager } = createManager(ctx, registry);
    await manager.sendTo('c2c', PEER, PEER, TARGET, 'hi', REPLY);
    expect(manager.findBySessionId(TARGET)).toBeDefined();

    // 宿主用同一个 sessionId 重开了另一个 agent
    const replacement = fakeAgent(TARGET);
    registry.get.mockImplementation(() => replacement);

    expect(manager.findBySessionId(TARGET)).toBeUndefined();
    expect(manager.size).toBe(0);
  });

  it('cancelAllRunning 中止所有 running 会话，清掉待答状态', async () => {
    const { agent, registry } = liveRegistry();
    const ctx = createCtx({ sessions: [{ id: 'session-current', cwd: WORKSPACE() }] });
    const { manager } = createManager(ctx, registry);
    const current = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await manager.sendTo('c2c', PEER, PEER, TARGET, 'hi', REPLY);
    Object.assign(agent, { status: 'running' });
    Object.assign(current.agent, { status: 'running' });
    const cancelPending = vi.fn();
    manager.questionChannel = { cancelPending } as unknown as NonNullable<typeof manager.questionChannel>;

    const cancelled = manager.cancelAllRunning();

    expect([...cancelled].sort()).toEqual([TARGET, current.sessionId].sort());
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' });
    expect(current.agent.cancel).toHaveBeenCalledWith({ kind: 'user' });
    expect(cancelPending).toHaveBeenCalledWith(TARGET);
    expect(cancelPending).toHaveBeenCalledWith(current.sessionId);
  });

  it('cancelAllRunning 不碰 idle 会话', async () => {
    const { agent, registry } = liveRegistry();
    const ctx = createCtx({ sessions: [] });
    const { manager } = createManager(ctx, registry);
    await manager.sendTo('c2c', PEER, PEER, TARGET, 'hi', REPLY);
    Object.assign(agent, { status: 'idle' });

    expect(manager.cancelAllRunning()).toEqual([]);
    expect(agent.cancel).not.toHaveBeenCalled();
  });

  it('resetCurrentSession 停掉当前 owned 会话并清空指针，其它已获取会话不动', async () => {
    const { registry } = liveRegistry();
    const ctx = createCtx({ sessions: [{ id: 'session-current', cwd: WORKSPACE() }] });
    const { manager } = createManager(ctx, registry);
    const current = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await manager.sendTo('c2c', PEER, PEER, TARGET, 'hi', REPLY);
    const cancelPending = vi.fn();
    manager.questionChannel = { cancelPending } as unknown as NonNullable<typeof manager.questionChannel>;

    const stopped = await manager.resetCurrentSession();

    expect(stopped).toBe(true);
    expect(current.agent.cancel).toHaveBeenCalledWith({ kind: 'user' });
    expect(current.handle?.dispose).toHaveBeenCalled();
    expect(manager.findBySessionId(current.sessionId)).toBeUndefined();
    expect(manager.findBySessionId(TARGET)).toBeDefined();
    expect(manager.currentSessionId()).toBeUndefined();
    expect(manager.getSessionRecord('c2c', PEER)).toBeUndefined();
    expect(cancelPending).toHaveBeenCalledWith(current.sessionId);
  });

  it('resetCurrentSession 对借来的当前会话只 cancel，不 dispose', async () => {
    new PrefsStore().setSessionId(KEY, TARGET);
    const { agent, registry } = liveRegistry();
    const ctx = createCtx({ sessions: [] });
    const { manager } = createManager(ctx, registry);
    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(record.handle).toBeUndefined();

    const stopped = await manager.resetCurrentSession();

    expect(stopped).toBe(true);
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' });
    expect(manager.findBySessionId(TARGET)).toBeUndefined();
  });

  it('resetCurrentSession 没有当前会话时保持空指针', async () => {
    const ctx = createCtx({ sessions: [] });
    const { manager } = createManager(ctx);
    expect(manager.currentSessionId()).toBeUndefined();

    expect(await manager.resetCurrentSession()).toBe(false);
    expect(manager.currentSessionId()).toBeUndefined();
  });

  it('resetAllSessions 停掉 owned 与借来的全部会话，并清空指针', async () => {
    const { agent, registry } = liveRegistry();
    const ctx = createCtx({ sessions: [{ id: 'session-current', cwd: WORKSPACE() }] });
    const { manager } = createManager(ctx, registry);
    const current = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await manager.sendTo('c2c', PEER, PEER, TARGET, 'hi', REPLY);

    const stopped = await manager.resetAllSessions();

    expect(stopped).toBe(2);
    expect(current.agent.cancel).toHaveBeenCalledWith({ kind: 'user' });
    expect(current.handle?.dispose).toHaveBeenCalled();
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' });
    expect(manager.size).toBe(0);
    expect(manager.currentSessionId()).toBeUndefined();
    expect(manager.getSessionRecord('c2c', PEER)).toBeUndefined();
  });

  it('resetAllSessions 没有已获取会话时返回 0', async () => {
    const ctx = createCtx({ sessions: [] });
    const { manager } = createManager(ctx);

    expect(await manager.resetAllSessions()).toBe(0);
    expect(manager.size).toBe(0);
  });
});

describe('会话改名', () => {
  const TARGET = 'session-rename-target';

  it('renameCurrentSession 把标题交给宿主 sessionTitle.rename', async () => {
    const rename = vi.fn(() => ({ title: '修登录' }));
    const ctx = createCtx({ sessionTitle: { rename } });
    const { manager } = createManager(ctx);
    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(manager.hasCurrentSession()).toBe(true);

    expect(manager.renameCurrentSession(' 修登录 ')).toEqual({ ok: true, title: '修登录' });
    expect(rename).toHaveBeenCalledWith(record.agent.session, '修登录');
  });

  it('没有当前会话时返回 no-session，不碰宿主', async () => {
    const rename = vi.fn(() => ({ title: 'x' }));
    const ctx = createCtx({ sessionTitle: { rename } });
    const { manager } = createManager(ctx);

    expect(manager.renameCurrentSession('新名字')).toEqual({ ok: false, reason: 'no-session' });
    expect(manager.hasCurrentSession()).toBe(false);
    expect(rename).not.toHaveBeenCalled();
  });

  it('空白标题直接 invalid，不写日志', async () => {
    const rename = vi.fn(() => ({ title: 'x' }));
    const ctx = createCtx({ sessionTitle: { rename } });
    const { manager } = createManager(ctx);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(manager.renameCurrentSession('   ')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(rename).not.toHaveBeenCalled();
  });

  it('renameSession 按 id 改已获取会话；不在集合里时 no-session', async () => {
    const rename = vi.fn(() => ({ title: '背景会话' }));
    const targetAgent = fakeAgent(TARGET);
    const { registry } = createRegistry();
    registry.get.mockImplementation((sessionId: string) => (sessionId === TARGET ? targetAgent : undefined));
    const ctx = createCtx({ sessionTitle: { rename } });
    const { manager } = createManager(ctx, registry);
    const sent = await manager.sendTo('c2c', PEER, PEER, TARGET, 'hi', REPLY);
    expect(sent.ok).toBe(true);

    expect(manager.renameSession(TARGET, '背景会话')).toEqual({ ok: true, title: '背景会话' });
    expect(rename).toHaveBeenCalledWith(targetAgent.session, '背景会话');
    expect(manager.renameSession('session-absent', 'x')).toEqual({ ok: false, reason: 'no-session' });
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

});
