/**
 * 插件安装器单测：回执后调度、结果落盘、被替换时不自投、ready 补发、并发保护
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import type { Logger } from '../../src/types.ts';
import { createPluginInstaller } from '../../src/plugins/index.ts';
import {
  readPluginOpState,
  readPluginUpdateCache,
  writePluginOpState,
  writePluginUpdateCache,
} from '../../src/plugins/state.ts';
import type { ChangeResultLike, PluginManagerLike } from '../../src/plugins/types.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** loader 桩：entry uid 可以被测试改动，模拟 reconcile 换掉 fiber */
function fakeLoader(): { loader: { entries(): unknown[] }; uid: { value: number } } {
  const uid = { value: 1 };
  return {
    uid,
    loader: {
      entries: () => [
        { options: { id: 'qqterm' }, fiber: { uid: uid.value } },
        { options: { id: 'dsh-other' }, fiber: { uid: 9 } },
      ],
    },
  };
}

function fakeCtx(manager: PluginManagerLike, loader: unknown): Context {
  return {
    get: (name: string) => (name === 'pluginManager' ? manager : name === 'loader' ? loader : undefined),
  } as unknown as Context;
}

/** 只关心调用参数的 fake bot */
function fakeBot(): { bot: QQBot; sent: Array<{ target: unknown; text: string }> } {
  const sent: Array<{ target: unknown; text: string }> = [];
  const bot = {
    sendMarkdown: vi.fn(async (target: unknown, text: string) => {
      sent.push({ target, text });
      return {};
    }),
  } as unknown as QQBot;
  return { bot, sent };
}

function change(over: Partial<ChangeResultLike>): ChangeResultLike {
  return { changed: true, application: 'applied', stage: 'install', target: 'dsh-x', ...over };
}

describe('createPluginInstaller', () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'dsh-qqterm-plugin-op-'));
    statePath = join(dir, 'state.json');
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(result: ChangeResultLike, options?: { updatesPath?: string }) {
    const installBundle = vi.fn(async () => result);
    const setBundleEnabled = vi.fn(async () => result);
    const manager = {
      listBundles: vi.fn(async () => []),
      installBundle,
      updateBundle: vi.fn(),
      setBundleEnabled,
      listVersions: vi.fn(),
    } as unknown as PluginManagerLike;
    const { loader, uid } = fakeLoader();
    const installer = createPluginInstaller(fakeCtx(manager, loader), logger, {
      statePath,
      ...(options?.updatesPath === undefined ? {} : { updatesPath: options.updatesPath }),
    });
    return { manager, installBundle, setBundleEnabled, installer, uid };
  }

  it('先落 running 状态，回执之后再执行，成功后立即回结果', async () => {
    const { installer, installBundle, uid } = setup(change({ bundle: 'dsh-x', version: '1.2.0' }));
    const { bot, sent } = fakeBot();

    installer.run({ action: 'install', target: 'dsh-x', spec: 'dsh-x', notify: { targetId: 'u1' } }, bot);

    // 还没到调度时间：只有 running 记录，不能先把结果发出去
    expect(readPluginOpState(statePath)?.phase).toBeUndefined();
    expect(installBundle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);

    // fiber 没被换掉：当前实例自己投递
    expect(uid.value).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe('✅ 已安装 dsh-x@1.2.0');
    expect(sent[0]?.target).toEqual({ scope: 'c2c', targetId: 'u1' });
    expect(readPluginOpState(statePath)?.notify).toBeUndefined();
  });

  it('自己被 reconcile 换掉时不投递，结果留给新 fiber 的 ready', async () => {
    const { installer, uid } = setup(change({ bundle: 'dsh-x', version: '1.2.0' }));
    const { bot, sent } = fakeBot();

    installer.run({ action: 'install', target: 'dsh-x', spec: 'dsh-x', notify: { targetId: 'u1' } }, bot);
    uid.value = 2; // 执行期间 entry 被替换
    await vi.advanceTimersByTimeAsync(200);

    expect(sent).toHaveLength(0);
    const state = readPluginOpState(statePath);
    expect(state?.phase).toBe('done');
    expect(state?.notify).toEqual({ targetId: 'u1' });
  });

  it('registry 没有更新的版本时说明已是最新，不调 updateBundle', async () => {
    const { installer, manager } = setup(change({}));
    (manager.listVersions as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'listed',
      installed: '1.0.0',
      versions: [],
    });
    const { bot, sent } = fakeBot();

    installer.run({ action: 'update', target: 'dsh-x', notify: { targetId: 'u1' } }, bot);
    await vi.advanceTimersByTimeAsync(200);

    expect(sent[0]?.text).toBe('✅ 已是最新版本: dsh-x@1.0.0');
    expect(manager.updateBundle).not.toHaveBeenCalled();
  });

  it('更新成功时带上 from → to', async () => {
    const { installer, manager } = setup(change({}));
    (manager.updateBundle as ReturnType<typeof vi.fn>).mockResolvedValue({
      from: '1.0.0',
      to: '1.1.0',
      step: 'install',
      result: change({ target: 'dsh-x' }),
    });
    const { bot, sent } = fakeBot();

    installer.run({ action: 'update', target: 'dsh-x', version: '1.1.0', notify: { targetId: 'u1' } }, bot);
    await vi.advanceTimersByTimeAsync(200);

    expect(manager.updateBundle).toHaveBeenCalledWith('dsh-x', '1.1.0');
    expect(sent[0]?.text).toBe('✅ 已更新 dsh-x: 1.0.0 → 1.1.0');
  });

  it('approveBuilds 原样交给宿主，未批准时不带该参数', async () => {
    const { installer, installBundle } = setup(change({}));
    const { bot } = fakeBot();

    installer.run({ action: 'install', target: 'dsh-x', spec: 'dsh-x', notify: { targetId: 'u1' } }, bot);
    await vi.advanceTimersByTimeAsync(200);
    expect(installBundle).toHaveBeenCalledWith('dsh-x', {});

    installer.run({ action: 'install', target: 'dsh-x', spec: 'dsh-x', approvedBuilds: ['esbuild'], notify: { targetId: 'u1' } }, bot);
    await vi.advanceTimersByTimeAsync(200);
    expect(installBundle).toHaveBeenLastCalledWith('dsh-x', { approvedBuilds: ['esbuild'] });
  });

  it('ready 补发：有结果和通知时发一条并清掉通知', async () => {
    const { installer } = setup(change({}));
    const { bot, sent } = fakeBot();

    writePluginOpState(statePath, {
      startedAt: Date.now() - 1_000,
      phase: 'done',
      action: 'install',
      target: 'dsh-x',
      name: 'dsh-x',
      version: '1.2.0',
      notify: { targetId: 'u1' },
    });

    await installer.announce(bot);

    expect(sent).toHaveLength(1);
    expect(readPluginOpState(statePath)?.notify).toBeUndefined();

    // 再补发一次不重复投递
    await installer.announce(bot);
    expect(sent).toHaveLength(1);
  });

  it('pending：进行中才算占用，完成与超时的记录不挡下一次操作', () => {
    const { installer } = setup(change({}));

    writePluginOpState(statePath, { startedAt: Date.now(), action: 'install', target: 'dsh-x' });
    expect(installer.pending()?.target).toBe('dsh-x');

    writePluginOpState(statePath, { startedAt: Date.now(), phase: 'done', action: 'install', target: 'dsh-x' });
    expect(installer.pending()).toBeUndefined();

    writePluginOpState(statePath, { startedAt: Date.now() - 700_000, action: 'install', target: 'dsh-x' });
    expect(installer.pending()).toBeUndefined();
  });

  it('启用 / 停用直接调宿主 setBundleEnabled，文案按方向', async () => {
    const { installer, setBundleEnabled } = setup(change({ application: 'applied' }));
    const { bot, sent } = fakeBot();

    installer.run({ action: 'enable', target: 'dsh-x', notify: { targetId: 'u1' } }, bot);
    await vi.advanceTimersByTimeAsync(200);
    expect(setBundleEnabled).toHaveBeenCalledWith('dsh-x', true);
    expect(sent[0]?.text).toBe('✅ 已启用 dsh-x');

    installer.run({ action: 'disable', target: 'dsh-x', notify: { targetId: 'u1' } }, bot);
    await vi.advanceTimersByTimeAsync(200);
    expect(setBundleEnabled).toHaveBeenLastCalledWith('dsh-x', false);
    expect(sent[1]?.text).toBe('✅ 已停用 dsh-x');
  });

  it('重启生效与 profile 覆盖都如实回执', async () => {
    const a = setup(change({ application: 'restart-required' }));
    const { bot: botA, sent: sentA } = fakeBot();
    a.installer.run({ action: 'enable', target: 'dsh-x', notify: { targetId: 'u1' } }, botA);
    await vi.advanceTimersByTimeAsync(200);
    expect(sentA[0]?.text).toBe('✅ 已启用 dsh-x\n⚠️ 重启 dsh 后生效');

    const b = setup(change({ application: 'overridden' }));
    const { bot: botB, sent: sentB } = fakeBot();
    b.installer.run({ action: 'disable', target: 'dsh-x', notify: { targetId: 'u1' } }, botB);
    await vi.advanceTimersByTimeAsync(200);
    expect(sentB[0]?.text).toBe('⚠️ 已停用 dsh-x，profile 里的配置会覆盖它');
  });

  it('宿主拒绝启停时写原因码，不冒充成功', async () => {
    const { installer } = setup(change({
      application: 'failed',
      error: { code: 'not-bundle', diagnostic: 'no dsh.bundle' },
    }));
    const { bot, sent } = fakeBot();

    installer.run({ action: 'enable', target: 'dsh-x', notify: { targetId: 'u1' } }, bot);
    await vi.advanceTimersByTimeAsync(200);

    expect(sent[0]?.text).toBe('❌ 启用失败: 这个包不是 dsh 插件');
    expect(readPluginOpState(statePath)?.code).toBe('not-bundle');
  });

  it('启停不清掉更新缓存，列表还能显示新版本箭头', async () => {
    const updatesPath = join(dir, 'updates.json');
    const { installer } = setup(change({}), { updatesPath });
    writePluginUpdateCache(updatesPath, { checkedAt: 1, versions: { 'dsh-x': '2.0.0' } });
    const { bot } = fakeBot();

    installer.run({ action: 'enable', target: 'dsh-x', notify: { targetId: 'u1' } }, bot);
    await vi.advanceTimersByTimeAsync(200);

    expect(readPluginUpdateCache(updatesPath)?.versions).toEqual({ 'dsh-x': '2.0.0' });
  });

  it('宿主拒绝时把原因码与诊断写进状态', async () => {
    const { installer } = setup(change({
      application: 'failed',
      error: { code: 'not-bundle', diagnostic: 'no dsh.bundle' },
    }));
    const { bot, sent } = fakeBot();

    installer.run({ action: 'install', target: 'left-pad', spec: 'left-pad', notify: { targetId: 'u1' } }, bot);
    await vi.advanceTimersByTimeAsync(200);

    expect(sent[0]?.text).toBe('❌ 安装失败: 这个包不是 dsh 插件');
    expect(readPluginOpState(statePath)?.code).toBe('not-bundle');
  });
});

describe('checkUpdates', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-qqterm-plugin-check-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(
    bundles: unknown[],
    versions: (name: string) => Promise<unknown>,
  ) {
    const listVersions = vi.fn(versions);
    const manager = {
      listBundles: vi.fn(async () => bundles),
      installBundle: vi.fn(),
      updateBundle: vi.fn(),
      listVersions,
    } as unknown as PluginManagerLike;
    const installer = createPluginInstaller(fakeCtx(manager, fakeLoader().loader), logger, {
      statePath: join(dir, 'state.json'),
      updatesPath: join(dir, 'updates.json'),
    });
    return { installer, listVersions };
  }

  const bundle = (name: string, over: Record<string, unknown> = {}) => ({
    name, official: false, installed: true, enabled: true, update: 'registry', removable: true, ...over,
  });
  const listed = (installed: string, version?: string) => ({
    status: 'listed',
    installed,
    versions: version === undefined ? [] : [{ version, tags: ['latest'], prerelease: false, bundle: true }],
  });

  it('只查 registry 安装的包，把新版本写进缓存', async () => {
    const { installer, listVersions } = setup(
      [
        bundle('dsh-a'),
        bundle('dsh-local', { update: undefined }),
        bundle('dsh-git', { update: 'git' }),
        bundle('dsh-official', { official: true }),
      ],
      async (name) => (name === 'dsh-a' ? listed('1.0.0', '1.1.0') : listed('1.0.0')),
    );

    const result = await installer.checkUpdates();

    expect(listVersions.mock.calls.map((call) => call[0])).toEqual(['dsh-a']);
    expect(result).toEqual({ checked: 1, versions: { 'dsh-a': '1.1.0' }, failed: [] });
    expect(installer.updates()?.versions).toEqual({ 'dsh-a': '1.1.0' });
    expect((installer.updates()?.checkedAt ?? 0) > 0).toBe(true);
  });

  it('单个包查询失败时保留上一次的结果，其余照常刷新', async () => {
    let fail = false;
    let latestB = '2.0.0';
    const { installer } = setup([bundle('dsh-a'), bundle('dsh-b')], async (name) => {
      if (fail && name === 'dsh-a') throw new Error('network down');
      return name === 'dsh-a' ? listed('1.0.0', '1.1.0') : listed('1.0.0', latestB);
    });

    await installer.checkUpdates();
    expect(installer.updates()?.versions).toEqual({ 'dsh-a': '1.1.0', 'dsh-b': '2.0.0' });

    // dsh-a 这一轮查不通：沿用上一轮的 1.1.0，dsh-b 仍刷新到 2.1.0
    fail = true;
    latestB = '2.1.0';
    const second = await installer.checkUpdates();
    expect(second).toEqual({ checked: 2, versions: { 'dsh-a': '1.1.0', 'dsh-b': '2.1.0' }, failed: ['dsh-a'] });
    expect(installer.updates()?.versions).toEqual({ 'dsh-a': '1.1.0', 'dsh-b': '2.1.0' });
  });

  it('registry 拒绝回答时把包记成查询失败，并沿用上一轮已知版本', async () => {
    let refuse = false;
    const { installer } = setup([bundle('dsh-a')], async () => {
      if (refuse) return { status: 'refused', problem: 'network', reason: 'offline' };
      return listed('1.0.0', '1.1.0');
    });

    await installer.checkUpdates();
    refuse = true;
    const result = await installer.checkUpdates();

    expect(result).toEqual({ checked: 1, versions: { 'dsh-a': '1.1.0' }, failed: ['dsh-a'] });
    expect(installer.updates()?.versions).toEqual({ 'dsh-a': '1.1.0' });
  });
});
