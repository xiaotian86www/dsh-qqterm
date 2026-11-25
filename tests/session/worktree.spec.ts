/**
 * 工作树判定与文案
 *
 * 这里只测纯函数：目录属于哪个主仓库、失败原因怎么压成一行、回执长什么样。
 * 与宿主 worktrees 服务的交互在 session-manager.spec.ts。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mainRepositoryRoot,
  shortCommit,
  worktreeFailureText,
  worktreeNotice,
  worktreeSourceRoot,
} from '../../src/session/worktree.ts';

let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'qqterm-worktree-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** 造一个普通检出：.git 是目录 */
function makeRepo(): string {
  const repo = join(home, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  return repo;
}

/** 造一个链接工作树：.git 是指向主仓库 .git/worktrees/<名字> 的文件 */
function makeLinkedWorktree(base: string, name = 'wt1'): string {
  const dir = join(base, '.agents', 'worktrees', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.git'), `gitdir: ${join(base, '.git', 'worktrees', name)}\n`);
  return dir;
}

describe('mainRepositoryRoot', () => {
  it('普通检出：返回含 .git 目录的那一层', () => {
    const repo = makeRepo();
    expect(mainRepositoryRoot(repo)).toBe(repo);
  });

  it('子目录：向上找到仓库根', () => {
    const repo = makeRepo();
    const nested = join(repo, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(mainRepositoryRoot(nested)).toBe(repo);
  });

  it('链接工作树：还原成主仓库根，不在树里再套一层池', () => {
    const repo = makeRepo();
    const worktree = makeLinkedWorktree(repo);
    expect(mainRepositoryRoot(worktree)).toBe(repo);
    const nested = join(worktree, 'src');
    mkdirSync(nested, { recursive: true });
    expect(mainRepositoryRoot(nested)).toBe(repo);
  });

  it('子模块：gitdir 指向 .git/modules，同样不建树', () => {
    const repo = makeRepo();
    const sub = join(repo, 'vendor', 'lib');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, '.git'), `gitdir: ${join(repo, '.git', 'modules', 'lib')}\n`);
    expect(mainRepositoryRoot(sub)).toBeUndefined();
  });

  it('不是 Git 仓库：undefined（就地建会话）', () => {
    const plain = join(home, 'plain');
    mkdirSync(join(plain, 'a'), { recursive: true });
    expect(mainRepositoryRoot(join(plain, 'a'))).toBeUndefined();
  });

  it('.git 文件内容不是 gitdir 指针：按非仓库处理', () => {
    const weird = join(home, 'weird');
    mkdirSync(weird, { recursive: true });
    writeFileSync(join(weird, '.git'), 'garbage\n');
    expect(mainRepositoryRoot(weird)).toBeUndefined();
  });
});

describe('worktreeSourceRoot', () => {
  it('普通检出（含子目录）：undefined，工作区不归一', () => {
    const repo = makeRepo();
    expect(worktreeSourceRoot(repo)).toBeUndefined();
    const nested = join(repo, 'src');
    mkdirSync(nested, { recursive: true });
    expect(worktreeSourceRoot(nested)).toBeUndefined();
  });

  it('链接工作树：还原成主仓库根', () => {
    const repo = makeRepo();
    const worktree = makeLinkedWorktree(repo);
    expect(worktreeSourceRoot(worktree)).toBe(repo);
    const nested = join(worktree, 'src');
    mkdirSync(nested, { recursive: true });
    expect(worktreeSourceRoot(nested)).toBe(repo);
  });

  it('子模块与不是 Git 仓库的目录：undefined', () => {
    const repo = makeRepo();
    const sub = join(repo, 'vendor', 'lib');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, '.git'), `gitdir: ${join(repo, '.git', 'modules', 'lib')}\n`);
    expect(worktreeSourceRoot(sub)).toBeUndefined();
    const plain = join(home, 'plain');
    mkdirSync(plain, { recursive: true });
    expect(worktreeSourceRoot(plain)).toBeUndefined();
  });
});

describe('worktreeFailureText', () => {
  it('剥掉服务前缀，只留 git 的真实原因', () => {
    const err = new Error(
      'Could not finish worktree dsh-1a2b3c4d-9f0e at D:\\repo\\.agents\\worktrees\\dsh-1a2b3c4d-9f0e. '
      + 'Any created checkout and branch are retained. fatal: cannot lock ref \'refs/heads/dsh-x\'',
    );
    expect(worktreeFailureText(err)).toBe("fatal: cannot lock ref 'refs/heads/dsh-x'");
  });

  it('多行 stderr 压成一行', () => {
    expect(worktreeFailureText(new Error('fatal: a\n\nfatal: b'))).toBe('fatal: a fatal: b');
  });

  it('剥掉宿主命令壳与 git 进度行，留下末尾的 fatal 原因', () => {
    const err = new Error(
      'Could not finish worktree dsh-x at /repo/.agents/worktrees/dsh-x. '
      + 'Any created checkout and branch are retained. '
      + "worktree command failed (255): Preparing worktree (new branch 'dsh-x') fatal: a branch named 'dsh-x' already exists",
    );
    expect(worktreeFailureText(err)).toBe("fatal: a branch named 'dsh-x' already exists");
  });

  it('超长原因截到 120 字并补省略号', () => {
    const text = worktreeFailureText(new Error('x'.repeat(140)));
    expect(text).toBe(`${'x'.repeat(120)}…`);
  });

  it('超时按 120s 说，不把 AbortError 原文抛给用户', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(worktreeFailureText(err)).toBe('git 超过 120s 没有完成');
  });

  it('空原因兜底成「未知错误」', () => {
    expect(worktreeFailureText(new Error('   '))).toBe('未知错误');
  });
});

describe('回执文案', () => {
  it('两行：首行只说会话与分支，次行说基点与路径', () => {
    expect(worktreeNotice({
      branch: 'dsh-1a2b3c4d-9f0e',
      baseCommit: '6b1f02c0ffee',
      path: 'D:\\repo\\.agents\\worktrees\\dsh-1a2b3c4d-9f0e',
    })).toBe(
      '✅ 已在新工作树 `dsh-1a2b3c4d-9f0e` 里开启会话\n'
      + '基点 `6b1f02c` · 路径: `D:\\repo\\.agents\\worktrees\\dsh-1a2b3c4d-9f0e`',
    );
  });

  it('知道父分支：次行说成「从 `main` 拉出」，不重复基点', () => {
    expect(worktreeNotice({
      branch: 'dsh-x',
      baseCommit: '6b1f02c0ffee',
      path: 'D:\\repo\\.agents\\worktrees\\dsh-x',
    }, 'main')).toBe(
      '✅ 已在新工作树 `dsh-x` 里开启会话\n'
      + '从 `main` 拉出 · 路径: `D:\\repo\\.agents\\worktrees\\dsh-x`',
    );
  });


  it('短号固定 7 位；不足时原样', () => {
    expect(shortCommit('abcdef0123456789')).toBe('abcdef0');
    expect(shortCommit('abc')).toBe('abc');
  });
});
