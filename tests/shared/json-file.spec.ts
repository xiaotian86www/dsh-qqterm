/**
 * JSON 状态文件读写单测：缺失 / 损坏兜底、原子写、失败处理
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJsonFile, writeJsonAtomic, writeJsonFile } from '../../src/shared/json-file.ts';
import type { Logger } from '../../src/types.ts';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qqterm-json-'));
  dirs.push(dir);
  return dir;
}

function fakeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readJsonFile', () => {
  it('文件不存在当没有记录，不告警', () => {
    const logger = fakeLogger();
    expect(readJsonFile(join(tempDir(), 'missing.json'), '测试状态', logger)).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('解析失败返回 undefined 并告警', () => {
    const logger = fakeLogger();
    const path = join(tempDir(), 'broken.json');
    // 手动写坏
    writeFileSync(path, '{oops', 'utf8');
    expect(readJsonFile(path, '测试状态', logger)).toBeUndefined();
    expect(String(logger.warn.mock.calls[0][0])).toContain('解析测试状态失败');
  });

  it('读失败的其它原因也告警（路径是目录）', () => {
    const logger = fakeLogger();
    const dir = tempDir();
    expect(readJsonFile(dir, '测试状态', logger)).toBeUndefined();
    expect(String(logger.warn.mock.calls[0][0])).toContain('读取测试状态失败');
  });

  it('正常 JSON 原样返回', () => {
    const path = join(tempDir(), 'ok.json');
    writeJsonAtomic(path, { a: 1, b: ['x'] });
    expect(readJsonFile(path, '测试状态')).toEqual({ a: 1, b: ['x'] });
  });
});

describe('writeJsonAtomic', () => {
  it('自动建目录并只留正式文件', () => {
    const dir = tempDir();
    const path = join(dir, 'nested', 'deep', 'state.json');
    writeJsonAtomic(path, { ok: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ok: true });
    // 临时文件已 rename 走，目录里只剩正式文件
    expect(readdirSync(join(dir, 'nested', 'deep'))).toEqual(['state.json']);
  });

  it('pretty 走两空格缩进，紧凑仍然一行', () => {
    const dir = tempDir();
    const pretty = join(dir, 'pretty.json');
    const compact = join(dir, 'compact.json');
    writeJsonAtomic(pretty, { a: 1 }, true);
    writeJsonAtomic(compact, { a: 1 });
    expect(readFileSync(pretty, 'utf8')).toContain('\n  "a"');
    expect(readFileSync(compact, 'utf8')).toBe('{"a":1}');
  });

  it('写失败抛出并清掉临时文件', () => {
    const dir = tempDir();
    expect(() => writeJsonAtomic(dir, { a: 1 })).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('writeJsonFile', () => {
  it('写成功不告警', () => {
    const logger = fakeLogger();
    const path = join(tempDir(), 'state.json');
    writeJsonFile(path, { a: 1 }, { label: '测试状态', logger });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('写失败只告警不抛', () => {
    const logger = fakeLogger();
    const dir = tempDir();
    expect(() => writeJsonFile(dir, { a: 1 }, { label: '测试状态', logger })).not.toThrow();
    expect(String(logger.warn.mock.calls[0][0])).toContain('写入测试状态失败');
  });
});
