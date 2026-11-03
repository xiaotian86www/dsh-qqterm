/**
 * 会话存储定位与删除（宿主 JSONL 布局）
 *
 * 宿主没有删除 API，删盘必须自己定位：
 *   <root>/<project>/<sessionId>/session.vN.jsonl
 * 用例覆盖：只认有日志文件的目录、越界拒绝、缺失 id 报告。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findSessionDirs,
  isPathInside,
  isSessionLogName,
  removeSessionDirs,
} from './session-store.ts';

let root: string;

/** 造一个会话目录；logFile 传 null 表示没有日志（应被跳过） */
function makeSessionDir(project: string, id: string, logFile: string | null = 'session.v3.jsonl'): string {
  const dir = join(root, project, id);
  mkdirSync(dir, { recursive: true });
  if (logFile !== null) writeFileSync(join(dir, logFile), 'x'.repeat(10), 'utf8');
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qqbot-session-store-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('isSessionLogName', () => {
  it('识别当前与历史代际、压缩与未压缩', () => {
    for (const name of ['session.jsonl', 'session.v1.jsonl', 'session.v3.jsonl.zstd', 'session.v12.jsonl']) {
      expect(isSessionLogName(name)).toBe(true);
    }
  });

  it('不把锁文件/无关文件当会话日志', () => {
    for (const name of ['session.lock', 'session.jsonl.tmp', 'other.jsonl', 'session.v3.jsonl.bak']) {
      expect(isSessionLogName(name)).toBe(false);
    }
  });
});

describe('isPathInside', () => {
  it('root 之内的路径通过', () => {
    expect(isPathInside('C:\\sessions', 'C:\\sessions\\p\\s')).toBe(true);
  });

  it('root 本身、root 之外、前缀相同的兄弟目录都拒绝', () => {
    expect(isPathInside('C:\\sessions', 'C:\\sessions')).toBe(false);
    expect(isPathInside('C:\\sessions', 'C:\\other\\s')).toBe(false);
    expect(isPathInside('C:\\sessions', 'C:\\sessions-evil\\s')).toBe(false);
    expect(isPathInside('C:\\sessions', 'C:\\sessions\\..\\evil')).toBe(false);
  });
});

describe('findSessionDirs', () => {
  it('按目录名定位会话目录并统计字节数', () => {
    const dir = makeSessionDir('--cwd--', 'session-aaa');
    const found = findSessionDirs(root, ['session-aaa']);

    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe(dir);
    expect(found[0]?.bytes).toBe(10);
  });

  it('没有日志文件的同名目录不算会话（防止误删普通目录）', () => {
    makeSessionDir('--cwd--', 'session-bbb', null);
    expect(findSessionDirs(root, ['session-bbb'])).toEqual([]);
  });

  it('同一 id 在多个 project 目录下全部返回（重复 id 会拖垮宿主 list）', () => {
    const first = makeSessionDir('--cwd-a--', 'session-dup');
    const second = makeSessionDir('--cwd-b--', 'session-dup');
    const found = findSessionDirs(root, ['session-dup']).map((item) => item.path).sort();
    expect(found).toEqual([first, second].sort());
  });

  it('root 不存在时返回空数组而不是抛错', () => {
    expect(findSessionDirs(join(root, 'missing'), ['session-aaa'])).toEqual([]);
  });
});

describe('removeSessionDirs', () => {
  it('删除目录并返回释放字节数', () => {
    const dir = makeSessionDir('--cwd--', 'session-ccc');
    const result = removeSessionDirs(root, ['session-ccc']);

    expect(result.removed.map((item) => item.id)).toEqual(['session-ccc']);
    expect(result.failed).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(root, '--cwd--'))).toBe(true); // 只删会话目录，不删 project
  });

  it('磁盘上没有的 id 记入 missing', () => {
    makeSessionDir('--cwd--', 'session-ddd');
    const result = removeSessionDirs(root, ['session-ddd', 'session-absent']);

    expect(result.removed.map((item) => item.id)).toEqual(['session-ddd']);
    expect(result.missing).toEqual(['session-absent']);
  });

  it('其它会话与无关目录原样保留', () => {
    const keep = makeSessionDir('--cwd--', 'session-keep');
    const doomed = makeSessionDir('--cwd--', 'session-doomed');
    const unrelated = join(root, '--cwd--', 'random-folder');
    mkdirSync(unrelated, { recursive: true });

    removeSessionDirs(root, ['session-doomed']);

    expect(existsSync(keep)).toBe(true);
    expect(existsSync(doomed)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });
});
