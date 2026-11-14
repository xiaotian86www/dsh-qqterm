/**
 * 插件操作状态文件单测：读写、profile 隔离、描述文案、损坏兜底
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describePluginOpState,
  pluginOpStatePath,
  pluginUpdateCachePath,
  readPluginOpState,
  readPluginUpdateCache,
  writePluginOpState,
  writePluginUpdateCache,
} from '../../src/plugins/state.ts';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qqterm-plugins-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('pluginOpStatePath', () => {
  it('按 profile 目录隔离', () => {
    expect(pluginOpStatePath('/profiles/web')).not.toBe(pluginOpStatePath('/profiles/qqdev'));
  });

  it('缺省 profile 也有稳定路径', () => {
    expect(pluginOpStatePath(undefined)).toBe(pluginOpStatePath(null));
  });
});

describe('readPluginOpState / writePluginOpState', () => {
  it('写进去再读回来是同一份状态', () => {
    const path = join(tempDir(), 'nested', 'state.json');
    const state = {
      startedAt: 1_700_000_000_000,
      phase: 'done' as const,
      action: 'install' as const,
      target: 'dsh-foo@1.2.0',
      name: 'dsh-foo',
      version: '1.2.0',
      notify: { targetId: 'u1' },
    };

    writePluginOpState(path, state);

    expect(readPluginOpState(path)).toEqual(state);
  });

  it('文件不存在时返回 undefined，不抛错', () => {
    expect(readPluginOpState(join(tempDir(), 'missing.json'))).toBeUndefined();
  });

  it('内容损坏时返回 undefined', () => {
    const path = join(tempDir(), 'state.json');
    writeFileSync(path, '{not json', 'utf8');
    expect(readPluginOpState(path)).toBeUndefined();
  });

  it('action 非法时当作没有记录', () => {
    const path = join(tempDir(), 'state.json');
    writeFileSync(path, JSON.stringify({ action: 'remove', startedAt: 1, target: 'x' }), 'utf8');
    expect(readPluginOpState(path)).toBeUndefined();
  });

  it('notify 清空后不落进文件', () => {
    const path = join(tempDir(), 'state.json');
    writePluginOpState(path, { startedAt: 1, phase: 'done', action: 'update', target: 'x', notify: { targetId: 'u1' } });
    writePluginOpState(path, { startedAt: 1, phase: 'done', action: 'update', target: 'x', notify: undefined });
    expect(readPluginOpState(path)?.notify).toBeUndefined();
  });
});

describe('readPluginUpdateCache / writePluginUpdateCache', () => {
  it('按 profile 隔离，和操作状态文件不撞名', () => {
    const path = pluginUpdateCachePath('/profiles/web');
    expect(path).not.toBe(pluginOpStatePath('/profiles/web'));
    expect(pluginUpdateCachePath('/profiles/web')).not.toBe(pluginUpdateCachePath('/profiles/qqdev'));
  });

  it('写进去再读回来是同一份结果', () => {
    const path = join(tempDir(), 'updates.json');
    const cache = { checkedAt: 1_700_000_000_000, versions: { 'dsh-a': '2.0.0' } };
    writePluginUpdateCache(path, cache);
    expect(readPluginUpdateCache(path)).toEqual(cache);
  });

  it('没有记录或内容损坏时返回 undefined', () => {
    expect(readPluginUpdateCache(join(tempDir(), 'missing.json'))).toBeUndefined();
    const broken = join(tempDir(), 'updates.json');
    writeFileSync(broken, '{not json', 'utf8');
    expect(readPluginUpdateCache(broken)).toBeUndefined();
  });

  it('versions 里的非字符串值丢掉，不污染列表', () => {
    const path = join(tempDir(), 'updates.json');
    writeFileSync(path, JSON.stringify({ checkedAt: 1, versions: { ok: '1.2.0', bad: 3 } }), 'utf8');
    expect(readPluginUpdateCache(path)?.versions).toEqual({ ok: '1.2.0' });
  });
});

describe('describePluginOpState', () => {
  const startedAt = Date.now() - 60_000;

  it('无记录返回 undefined', () => {
    expect(describePluginOpState(undefined)).toBeUndefined();
  });

  it('进行中', () => {
    expect(describePluginOpState({ startedAt, action: 'install', target: 'x' })).toContain('🔄');
  });

  it('安装成功', () => {
    const text = describePluginOpState({ startedAt, phase: 'done', action: 'install', target: 'x' });
    expect(text).toContain('✅');
    expect(text).toContain('已安装');
  });

  it('更新失败', () => {
    const text = describePluginOpState({ startedAt, phase: 'failed', action: 'update', target: 'x' });
    expect(text).toContain('❌');
    expect(text).toContain('更新失败');
  });
});
