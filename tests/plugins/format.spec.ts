/**
 * 插件命令渲染单测：列表分页 / 更新入口 / 结果文案 / 版本挑选
 */
import { describe, expect, it } from 'vitest';
import { pickLatestVersion, renderPluginList, renderPluginResult } from '../../src/plugins/format.ts';
import type { BundleInfoLike, PluginVersionLike } from '../../src/plugins/types.ts';

function bundle(over: Partial<BundleInfoLike> & { name: string }): BundleInfoLike {
  return {
    official: false,
    installed: true,
    enabled: true,
    update: 'registry',
    removable: true,
    ...over,
  };
}

const version = (over: Partial<PluginVersionLike> & { version: string }): PluginVersionLike => ({
  tags: [],
  prerelease: false,
  bundle: true,
  ...over,
});

describe('renderPluginList', () => {
  it('只列已安装的第三方插件，按名字排序', () => {
    const text = renderPluginList([
      bundle({ name: 'dsh-b' }),
      bundle({ name: 'dsh-a', version: '1.0.0' }),
      bundle({ name: 'dsh-official', official: true }),
      bundle({ name: 'dsh-absent', installed: false }),
    ], 1);

    expect(text).toContain('已安装插件（2 个）');
    expect(text.indexOf('dsh-a')).toBeLessThan(text.indexOf('dsh-b'));
    expect(text).not.toContain('dsh-official');
    expect(text).not.toContain('dsh-absent');
  });

  it('只有查到新版本的行才给更新链接，本地安装的不给', () => {
    const text = renderPluginList([
      bundle({ name: 'dsh-reg', version: '2.0.0' }),
      bundle({ name: 'dsh-local', version: '1.0.0', update: undefined, enabled: false }),
      bundle({ name: 'dsh-git', version: '3.0.0', update: 'git' }),
    ], 1, { 'dsh-reg': '2.1.0', 'dsh-local': '2.0.0', 'dsh-git': '3.1.0' });

    expect(text).toContain(
      '**dsh-reg** · `2.0.0` → `2.1.0` · <qqbot-cmd-input text="/plugins update dsh-reg" show="更新"/>',
    );
    expect(text).toContain('**dsh-local** · `1.0.0` · 已停用');
    expect(text).not.toContain('/plugins update dsh-local');
    expect(text).not.toContain('/plugins update dsh-git');
  });

  it('没有查到新版本时不给更新链接', () => {
    const text = renderPluginList([bundle({ name: 'dsh-reg', version: '2.0.0' })], 1);
    expect(text).toContain('**dsh-reg** · `2.0.0`');
    expect(text).not.toContain('/plugins update dsh-reg');
  });

  it('没有插件时给出安装入口', () => {
    const text = renderPluginList([], 1);
    expect(text).toContain('（0 个）');
    expect(text).toContain('/plugins install');
  });

  it('后台检查到新版本时标出箭头，与已装版本相同时不标', () => {
    const text = renderPluginList(
      [bundle({ name: 'dsh-a', version: '1.0.0' }), bundle({ name: 'dsh-b', version: '2.0.0' })],
      1,
      { 'dsh-a': '1.2.0', 'dsh-b': '2.0.0' },
    );
    expect(text).toContain('**dsh-a** · `1.0.0` → `1.2.0`');
    expect(text).toContain('**dsh-b** · `2.0.0`');
    expect(text).not.toContain('→ `2.0.0`');
  });

  it('页脚统一给安装 / 更新 / 热重载三个链接', () => {
    const text = renderPluginList([bundle({ name: 'dsh-a' })], 1);
    expect(text).toContain('text="/plugins install" show="安装插件"');
    expect(text).toContain('text="/plugins update" show="更新插件"');
    expect(text).toContain('text="/plugins reload" show="热重载"');
  });

  it('按 10 条一页切分，多页保留分页与命令链接', () => {
    const bundles = Array.from({ length: 12 }, (_, i) => bundle({ name: `dsh-${String(i).padStart(2, '0')}` }));
    const page2 = renderPluginList(bundles, 2);

    expect(page2).toContain('第 2/2 页');
    expect(page2).toContain('dsh-10');
    expect(page2).not.toContain('dsh-00');
    expect(page2).toContain('/plugins update');
  });

  it('页码越界时夹到有效范围', () => {
    const bundles = [bundle({ name: 'dsh-a' })];
    expect(renderPluginList(bundles, 9)).toContain('dsh-a');
  });
});

describe('pickLatestVersion', () => {
  it('优先 latest 标签', () => {
    const picked = pickLatestVersion([version({ version: '2.0.0' }), version({ version: '3.0.0', tags: ['latest'] })]);
    expect(picked?.version).toBe('3.0.0');
  });

  it('没有标签时跳过预发布，退到最新正式版', () => {
    const picked = pickLatestVersion([version({ version: '3.0.0-rc.1', prerelease: true }), version({ version: '2.1.0' })]);
    expect(picked?.version).toBe('2.1.0');
  });

  it('只考虑兼容且未废弃的版本', () => {
    const picked = pickLatestVersion([
      version({ version: '3.0.0', deprecated: 'broken' }),
      version({ version: '2.5.0', incompatible: { reason: 'dsh' } }),
      version({ version: '2.0.0', prerelease: true }),
    ]);
    expect(picked?.version).toBe('2.0.0');
  });

  it('全部不可用时返回 undefined', () => {
    expect(pickLatestVersion([version({ version: '2.0.0', bundle: false })])).toBeUndefined();
  });
});

describe('renderPluginResult', () => {
  const base = { startedAt: 1, action: 'install' as const, target: 'dsh-x' };

  it('还在跑时不产出文案', () => {
    expect(renderPluginResult(base)).toBeUndefined();
  });

  it('安装成功带上版本', () => {
    expect(renderPluginResult({ ...base, phase: 'done', name: 'dsh-x', version: '1.2.0' }))
      .toBe('✅ 已安装 dsh-x@1.2.0');
  });

  it('需要重启时补一行警告', () => {
    expect(renderPluginResult({ ...base, phase: 'done', version: '1.2.0', application: 'restart-required' }))
      .toBe('✅ 已安装 dsh-x@1.2.0\n⚠️ 重启 dsh 后生效');
  });

  it('失败按原因码翻译，不裸露 code', () => {
    expect(renderPluginResult({ ...base, phase: 'failed', code: 'already-installed' }))
      .toBe('❌ 安装失败: 已经安装，更新用 /plugins update');
  });

  it('构建脚本被拦下时给出批准后重试的按钮', () => {
    const text = renderPluginResult({ ...base, phase: 'failed', code: 'pending-builds', pendingBuilds: ['esbuild'] });
    expect(text).toContain('⚠️ 安装被构建脚本拦下: esbuild');
    expect(text).toContain('--allow-builds=esbuild');
  });

  it('更新成功显示版本变化', () => {
    expect(renderPluginResult({
      startedAt: 1,
      action: 'update',
      target: 'dsh-x',
      phase: 'done',
      from: '1.0.0',
      to: '1.1.0',
    })).toBe('✅ 已更新 dsh-x: 1.0.0 → 1.1.0');
  });

  it('没有更新时说明已是最新', () => {
    expect(renderPluginResult({
      startedAt: 1,
      action: 'update',
      target: 'dsh-x',
      phase: 'done',
      upToDate: true,
      version: '1.0.0',
    })).toBe('✅ 已是最新版本: dsh-x@1.0.0');
  });

  it('更新失败且已回滚时说明回到了哪个版本', () => {
    expect(renderPluginResult({
      startedAt: 1,
      action: 'update',
      target: 'dsh-x',
      phase: 'failed',
      code: 'operation-error',
      error: 'pnpm failed',
      from: '1.0.0',
      to: '1.1.0',
      rolledBack: true,
    })).toBe('❌ 更新失败: pnpm failed\n已回到 1.0.0');
  });
});
