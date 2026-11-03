/**
 * SessionManager 的会话管理能力：列表 / 恢复 / 删除
 *
 * 宿主侧只提供「列举、stat、存储根」三类事实；切换与删除的编排（释放 agent、
 * 映射回滚、悬空映射重指向、连盘子会话）都在 manager 里，这里逐条钉住。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const PEER2 = 'user2';
const KEY = `qqbot:${APP_ID}:c2c:${PEER}`;
const KEY2 = `qqbot:${APP_ID}:c2c:${PEER2}`;
const MINTED = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPLY: ReplyTarget = { scope: 'c2c', targetId: PEER, msgId: 'm1' };

const WORKSPACE = () => join(env.home, 'workspace');
const STORE_ROOT = () => join(env.home, 'sessions');

interface StoredSession {
  id: string;
  cwd?: string;
  parentSession?: string;
  origin?: 'subagent';
  createdAt?: number;
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
  root?: string | undefined;
  withQuery?: boolean;
  resume?: (sessionId: string) => Promise<DshAgentHandle>;
}): Context {
  const sessions = options.sessions ?? [];
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const persistence = {
    stat: async (id: string) => (byId.has(id) ? { header: { id, cwd: WORKSPACE() } } : undefined),
    list: async () => sessions.map((session) => ({ header: session })),
    ...(options.root === undefined ? {} : { root: options.root }),
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

  return {
    get: (name: string) => {
      if (name === 'sessionPersistence') return persistence;
      if (name === 'sessionQuery') return query;
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
    cwd: WORKSPACE(),
    sessionIdleTimeout: 0,
  } as ImQQBotConfig);
  const manager = new SessionManager(ctx, registry as DshAgentRegistry, config, logger);
  managers.push(manager);
  return { manager, registry, logger };
}

const managers: Array<InstanceType<typeof SessionManager>> = [];

/** 造一个磁盘上的会话目录 */
function makeStoredSession(id: string, project = '--cwd--'): string {
  const dir = join(STORE_ROOT(), project, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v3.jsonl'), 'x'.repeat(16), 'utf8');
  return dir;
}

function persistedId(key = KEY): string | undefined {
  return new PrefsStore().getSessionId(key);
}

beforeEach(() => {
  env.home = mkdtempSync(join(tmpdir(), 'im-qqbot-admin-'));
  mkdirSync(WORKSPACE(), { recursive: true });
  mkdirSync(STORE_ROOT(), { recursive: true });
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

describe('deleteSessions', () => {
  it('删除当前会话：释放记录、删盘、把映射换成新会话', async () => {
    const id = 'session-doomed';
    const dir = makeStoredSession(id);
    new PrefsStore().setSessionId(KEY, id);
    const ctx = createCtx({ sessions: [{ id, cwd: WORKSPACE() }], root: STORE_ROOT() });
    const { manager } = createManager(ctx);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    const outcome = await manager.deleteSessions([id]);

    expect(outcome.ok).toBe(true);
    expect(outcome.removed.map((item) => item.id)).toEqual([id]);
    expect(existsSync(dir)).toBe(false);
    expect(persistedId()).toMatch(MINTED);
    expect(persistedId()).not.toBe(id);
    expect(manager.getSessionRecord('c2c', PEER)).toBeUndefined();
  });

  it('连带删除 subagent 子会话，并统计 cascaded', async () => {
    const parent = 'session-parent';
    const child = 'session-child';
    const parentDir = makeStoredSession(parent);
    const childDir = makeStoredSession(child);
    const ctx = createCtx({
      root: STORE_ROOT(),
      sessions: [
        { id: parent, cwd: WORKSPACE() },
        { id: child, cwd: WORKSPACE(), origin: 'subagent', parentSession: parent },
      ],
    });
    const { manager } = createManager(ctx);

    const outcome = await manager.deleteSessions([parent]);

    expect(outcome.cascaded).toBe(1);
    expect(outcome.removed.map((item) => item.id).sort()).toEqual([child, parent].sort());
    expect(existsSync(parentDir)).toBe(false);
    expect(existsSync(childDir)).toBe(false);
  });

  it('宿主未暴露存储根目录时拒绝删除磁盘', async () => {
    const ctx = createCtx({ sessions: [{ id: 'session-x', cwd: WORKSPACE() }] });
    const { manager } = createManager(ctx);

    const outcome = await manager.deleteSessions(['session-x']);

    expect(outcome.reason).toBe('no-root');
    expect(outcome.removed).toEqual([]);
  });

  it('磁盘上没有目录时报告 not-found', async () => {
    const ctx = createCtx({ root: STORE_ROOT(), sessions: [{ id: 'session-x', cwd: WORKSPACE() }] });
    const { manager } = createManager(ctx);

    const outcome = await manager.deleteSessions(['session-x']);

    expect(outcome.reason).toBe('not-found');
    expect(outcome.missing).toEqual(['session-x']);
  });
});
