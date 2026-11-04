/**
 * SessionManager 的权限预设读写（/permission 的服务端部分）
 *
 * 宿主 permission-presets 服务用替身：只验证「读当前值 / 列目录 / 写切换」这条
 * 链路，以及没有服务、未知预设、写入抛错时的降级文案。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { ConfigSchema, type ImQQBotConfig } from '../config.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import type { DshAgent, DshAgentRegistry, PermissionPresetsLike } from './types.ts';

const env = vi.hoisted(() => ({ home: '' }));

vi.mock('../shared/dirs.ts', () => ({
  get PLUGIN_HOME() { return env.home; },
  resolveAgentCwd: (cwd: string | undefined) => cwd || `${env.home}/workspace`,
}));

const { SessionManager } = await import('./session-manager.ts');

const APP_ID = 'app1';
const PEER = 'user1';
const REPLY: ReplyTarget = { scope: 'c2c', targetId: PEER, msgId: 'm1' };

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

function createRegistry() {
  const registry = {
    get: vi.fn(() => undefined),
    // 盘上没有这个会话：resume 失败 → 首次创建
    resume: vi.fn(async ({ resumeSessionId }: { resumeSessionId: string }) => {
      throw Object.assign(new Error(`session "${resumeSessionId}" not found`), { name: 'SessionPersistenceNotFoundError' });
    }),
    create: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      agent: fakeAgent(sessionId),
      dispose: vi.fn(async () => {}),
    })),
  };
  return registry;
}

function fakePermissions(overrides: Partial<Record<keyof PermissionPresetsLike, unknown>> = {}) {
  const set = vi.fn();
  const service = {
    names: ['read-only', 'workspace-write', 'auto'],
    defaultPreset: 'workspace-write',
    current: vi.fn(() => 'workspace-write'),
    optionOf: vi.fn((name: string) => ({ value: name, name: `name-${name}` })),
    set,
    ...overrides,
  } as unknown as PermissionPresetsLike;
  return { service, set };
}

function createLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function createCtx(permissions?: PermissionPresetsLike): Context {
  return {
    get: (name: string) => (name === 'permissionPresets' ? permissions : undefined),
    on: vi.fn(),
  } as unknown as Context;
}

const managers: Array<InstanceType<typeof SessionManager>> = [];

function createManager(
  permissions?: PermissionPresetsLike,
  logger: Logger = createLogger(),
  registry = createRegistry(),
) {
  const config = ConfigSchema({
    appId: APP_ID,
    appSecret: 'secret',
    provider: 'p',
    model: 'm',
    sessionIdleTimeout: 0,
  } as ImQQBotConfig);
  const manager = new SessionManager(createCtx(permissions), registry as unknown as DshAgentRegistry, config, logger);
  managers.push(manager);
  return manager;
}

beforeEach(() => {
  env.home = mkdtempSync(join(tmpdir(), 'im-qqbot-permission-'));
  mkdirSync(join(env.home, 'workspace'), { recursive: true });
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
  rmSync(env.home, { recursive: true, force: true });
});

describe('权限预设目录', () => {
  it('按宿主 names 顺序列出，名称取自 optionOf', () => {
    const { service } = fakePermissions();
    const manager = createManager(service);
    expect(manager.listPermissionPresets()).toEqual([
      { id: 'read-only', name: 'name-read-only' },
      { id: 'workspace-write', name: 'name-workspace-write' },
      { id: 'auto', name: 'name-auto' },
    ]);
  });

  it('宿主没有 optionOf 时只给 id', () => {
    const { service } = fakePermissions({ optionOf: undefined });
    const manager = createManager(service);
    expect(manager.listPermissionPresets().map((entry) => entry.id)).toEqual(['read-only', 'workspace-write', 'auto']);
    expect(manager.listPermissionPresets()[0]?.name).toBeUndefined();
  });

  it('服务未注入时目录为空、当前值不可用', () => {
    const manager = createManager(undefined);
    expect(manager.listPermissionPresets()).toEqual([]);
    expect(manager.getPermissionPreset('c2c', PEER)).toBeUndefined();
  });
});

describe('读取当前权限', () => {
  it('没有活跃会话时退回宿主默认预设（下一条消息就按它建会话）', () => {
    const { service } = fakePermissions();
    const manager = createManager(service);
    expect(manager.getPermissionPreset('c2c', PEER)).toBe('workspace-write');
    expect(service.current).not.toHaveBeenCalled();
  });

  it('有活跃会话时读宿主的 current', async () => {
    const { service } = fakePermissions({ current: vi.fn(() => 'auto') });
    const manager = createManager(service);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(manager.getPermissionPreset('c2c', PEER)).toBe('auto');
    expect(service.current).toHaveBeenCalledOnce();
  });

  it('current() 抛错（投影缺失）时也不空着，退回默认', async () => {
    const { service } = fakePermissions({ current: vi.fn(() => { throw new Error('missing projection'); }) });
    const manager = createManager(service);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(manager.getPermissionPreset('c2c', PEER)).toBe('workspace-write');
  });
});

describe('切换权限', () => {
  it('目标就是当前预设时可重入：不写会话', async () => {
    const { service, set } = fakePermissions({ current: vi.fn(() => 'auto') });
    const manager = createManager(service);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    const outcome = await manager.setPermissionPreset('c2c', PEER, 'auto');

    expect(outcome).toEqual({ ok: true, preset: 'auto', unchanged: true });
    expect(set).not.toHaveBeenCalled();
  });

  it('无活跃会话且已是默认预设：不为了切换拉起会话', async () => {
    const { service, set } = fakePermissions(); // defaultPreset = workspace-write
    const manager = createManager(service);

    const outcome = await manager.setPermissionPreset('c2c', PEER, 'workspace-write', {
      senderId: PEER,
      replyTarget: REPLY,
    });

    expect(outcome).toEqual({ ok: true, preset: 'workspace-write', unchanged: true });
    expect(set).not.toHaveBeenCalled();
    expect(manager.getSessionRecord('c2c', PEER)).toBeUndefined();
  });

  it('有活跃会话：直接写该会话，不新建', async () => {
    const { service, set } = fakePermissions();
    const manager = createManager(service);
    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    const outcome = await manager.setPermissionPreset('c2c', PEER, 'auto');

    expect(outcome).toEqual({ ok: true, preset: 'auto' });
    expect(set).toHaveBeenCalledWith(record.agent.session, 'auto');
  });

  it('无活跃会话：按 revive 拉起会话再写（与 /compact 一致）', async () => {
    const { service, set } = fakePermissions();
    const manager = createManager(service);

    const outcome = await manager.setPermissionPreset('c2c', PEER, 'auto', { senderId: PEER, replyTarget: REPLY });

    expect(outcome.ok).toBe(true);
    expect(set).toHaveBeenCalledOnce();
    // 拉起的是真实会话（getOrCreate 记录进内存）
    expect(manager.getSessionRecord('c2c', PEER)).toBeDefined();
  });

  it('未知预设：拒绝且不写会话、不建会话', async () => {
    const { service, set } = fakePermissions();
    const manager = createManager(service);

    const outcome = await manager.setPermissionPreset('c2c', PEER, 'nope', { senderId: PEER, replyTarget: REPLY });

    expect(outcome).toEqual({ ok: false, reason: 'unknown-preset' });
    expect(set).not.toHaveBeenCalled();
    expect(manager.getSessionRecord('c2c', PEER)).toBeUndefined();
  });

  it('auto 准入失败（集成下线）时原样报错', async () => {
    const { service } = fakePermissions({
      set: vi.fn(() => { throw new Error('auto-review: integration is closing'); }),
    });
    const manager = createManager(service);

    const outcome = await manager.setPermissionPreset('c2c', PEER, 'auto', { senderId: PEER, replyTarget: REPLY });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('failed');
    expect(outcome.message).toContain('integration is closing');
  });

  it('服务未注入：unavailable', async () => {
    const manager = createManager(undefined);
    const outcome = await manager.setPermissionPreset('c2c', PEER, 'auto', { senderId: PEER, replyTarget: REPLY });
    expect(outcome).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('会话拉不起来时返回 failed，不把异常抛给命令层', async () => {
    const { service, set } = fakePermissions();
    const registry = createRegistry();
    registry.create.mockRejectedValueOnce(new Error('EIO: session log is locked'));
    const manager = createManager(service, createLogger(), registry);

    const outcome = await manager.setPermissionPreset('c2c', PEER, 'auto', { senderId: PEER, replyTarget: REPLY });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('failed');
    expect(outcome.message).toContain('session log is locked');
    expect(set).not.toHaveBeenCalled();
  });
});
