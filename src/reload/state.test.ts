/**
 * 热重载状态文件单测：读写、profile 隔离、描述文案、损坏兜底
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describeReloadState,
  errorText,
  readReloadState,
  reloadStatePath,
  writeReloadState,
} from './state.ts';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qqbot-reload-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('reloadStatePath', () => {
  it('按 profile 目录隔离', () => {
    expect(reloadStatePath('/profiles/web')).not.toBe(reloadStatePath('/profiles/qqdev'));
  });

  it('缺省 profile（dev checkout）也有稳定路径', () => {
    expect(reloadStatePath(undefined)).toBe(reloadStatePath(null));
  });
});

describe('readReloadState / writeReloadState', () => {
  it('写进去再读回来是同一份状态', () => {
    const path = join(tempDir(), 'nested', 'state.json');
    const state = {
      phase: 'done' as const,
      startedAt: 1_700_000_000_000,
      notify: { targetId: 'u1' },
      restartReason: 'package-moved',
    };

    writeReloadState(path, state);

    expect(readReloadState(path)).toEqual(state);
  });

  it('文件不存在时返回 undefined，不抛错', () => {
    expect(readReloadState(join(tempDir(), 'missing.json'))).toBeUndefined();
  });

  it('内容损坏时返回 undefined', () => {
    const path = join(tempDir(), 'state.json');
    writeFileSync(path, '{not json', 'utf8');
    expect(readReloadState(path)).toBeUndefined();
  });

  it('phase 非法时当作没有记录', () => {
    const path = join(tempDir(), 'state.json');
    writeFileSync(path, JSON.stringify({ phase: 'weird', startedAt: 1 }), 'utf8');
    expect(readReloadState(path)).toBeUndefined();
  });

  it('notify 清空后不落进文件', () => {
    const path = join(tempDir(), 'state.json');
    writeReloadState(path, { phase: 'done', startedAt: 1, notify: { targetId: 'u1' } });
    writeReloadState(path, { phase: 'done', startedAt: 1, notify: undefined });
    expect(readReloadState(path)?.notify).toBeUndefined();
  });
});

describe('describeReloadState', () => {
  const startedAt = Date.now() - 60_000;

  it('无记录返回 undefined', () => {
    expect(describeReloadState(undefined)).toBeUndefined();
  });

  it('成功且无需重启', () => {
    expect(describeReloadState({ phase: 'done', startedAt })).toContain('✅');
  });

  it('成功但需要重启', () => {
    expect(describeReloadState({ phase: 'done', startedAt, restartReason: 'package-moved' })).toContain('⚠️');
  });

  it('失败', () => {
    expect(describeReloadState({ phase: 'failed', startedAt, error: 'boom' })).toContain('❌');
  });

  it('进行中', () => {
    expect(describeReloadState({ phase: 'running', startedAt })).toContain('🔄');
  });
});

describe('errorText', () => {
  it('截断超长错误消息', () => {
    const text = errorText(new Error('x'.repeat(400)), 10);
    expect(text).toBe(`${'x'.repeat(10)}…`);
  });

  it('非 Error 值转成字符串', () => {
    expect(errorText('plain')).toBe('plain');
  });
});
