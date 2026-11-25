/**
 * 工作树接入的判定与文案
 *
 * qqterm 不复制宿主的建树流程：新会话先落在仓库根，再交给 `ctx.worktrees.create`，
 * 由宿主自己写会话日志、切工作目录。这里只回答两件事——这个目录属于哪个主仓库、
 * 失败怎么讲给用户听。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { errorMessage } from '../shared/utils.ts';

/** 建树 / 重建的超时：宿主每条 Git 命令默认等 5 分钟，会话开局不该挂那么久 */
export const WORKTREE_TIMEOUT_MS = 120_000;

/**
 * 工作树操作失败。
 *
 * `kind` 决定入站消息怎么收尾：建不出来（含读不到基点提交）= 本次会话没有创建；
 * 重建不出来 = 会话还在，只是目录回不来。
 */
export class WorktreeError extends Error {
  readonly kind: 'create' | 'restore' | 'base';
  /** 拉出这棵树的父分支（读得到时才有，失败文案用它点明起点） */
  readonly base?: string;

  constructor(kind: 'create' | 'restore' | 'base', message: string, cause?: unknown, base?: string) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'WorktreeError';
    this.kind = kind;
    if (base !== undefined) this.base = base;
  }
}

/** 宿主建树失败的前缀：真正的原因在后面，展示前剥掉 */
const SERVICE_PREFIX = /^Could not finish worktree .*?Any created checkout and branch are retained\.\s*/s;
/** 宿主把 git stderr 塞进这个壳，壳与进度行都不是失败原因 */
const GIT_WRAPPER = /^worktree command failed \([^)]*\):\s*/;
const GIT_PROGRESS = /^Preparing worktree \([^)]*\)\s*/;
/** 原因限长：剥掉壳与进度后只剩失败点，留够它读完 */
const FAILURE_LIMIT = 120;

/**
 * 把宿主抛出的建树错误压成一行可展示的原因。
 *
 * git 的 stderr 常带多行与绝对路径，QQ 一次只该看到「为什么没建成」。
 * 宿主把 stderr 包进 `worktree command failed (255):`，git 又先写
 * `Preparing worktree (...)` 进度；不剥这两层，限长就会把末尾的
 * `fatal:` 原因整段截掉，用户只看到一堆壳。
 */
export function worktreeFailureText(err: unknown): string {
  const raw = errorMessage(err);
  if (err instanceof Error && err.name === 'AbortError') {
    return `git 超过 ${WORKTREE_TIMEOUT_MS / 1000}s 没有完成`;
  }
  const text = raw
    .replace(SERVICE_PREFIX, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(GIT_WRAPPER, '')
    .replace(GIT_PROGRESS, '');
  if (text === '') return '未知错误';
  return text.length > FAILURE_LIMIT ? `${text.slice(0, FAILURE_LIMIT)}…` : text;
}

/**
 * 建树回执（只发一次）：首行只说会话与分支，次行说基点 / 父分支与路径。
 *
 * `parent` 是创建那一刻 chatDir 的分支名；detached HEAD 没有分支名，退回基点短号。
 * 读不到基点提交时走不到这里——那种情况会话根本不创建。
 */
export function worktreeNotice(
  tree: { branch: string; baseCommit: string; path: string },
  parent?: string,
): string {
  const origin = parent === undefined
    ? `基点 \`${shortCommit(tree.baseCommit)}\``
    : `从 \`${parent}\` 拉出`;
  return `✅ 已在新工作树 \`${tree.branch}\` 里开启会话\n${origin} · 路径: \`${tree.path}\``;
}

/** 明确要求开树却没能开成时的就地提示（会话照常开了，不是失败） */
export function worktreeSkipNotice(reason: 'not-repo' | 'read-only'): string {
  return reason === 'not-repo'
    ? '⚠️ 当前目录不是 Git 仓库，本次就地开会话'
    : '⚠️ 沙箱已是只读，本次就地开会话';
}

/**
 * 建树失败给用户看的收尾文案（入站消息与 `/new <提示词>` 共用）。
 *
 * `create` / `base` 意味着会话根本没有建起来，给「重发」与「就地开」两条路；
 * `restore` 只丢了目录，会话还在，指回 `/new`。
 */
export function worktreeErrorText(err: WorktreeError): string {
  if (err.kind === 'create') {
    const head = err.base === undefined ? '❌ 没能建工作树' : `❌ 没能从 \`${err.base}\` 建工作树`;
    return `${head}: ${err.message}\n本次会话没有创建，重发一次可重试，或再发一条 /new 就地开始。`;
  }
  if (err.kind === 'base') {
    return '❌ 没能读到当前分支的提交\n本次会话没有创建，重发一次可重试，或再发一条 /new 就地开始。';
  }
  return `❌ 工作树重建失败: ${err.message} · 用 /new 重新开会话`;
}

/** 提交短号：回执与 /status 同一口径 */
export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/**
 * 找到目录所属的主仓库根；不是 Git 仓库时返回 undefined。
 *
 * 普通检出取最近的、含 `.git` 的祖先目录。链接工作树的 `.git` 是文件，内容是
 * `gitdir: <主仓库>/.git/worktrees/<名字>`：还原成主仓库根，新会话在主仓库里开
 * 新树，而不是往树里再套一层池（`/new` 之后从树里开会话也走这条）。
 * 子模块的 `gitdir` 指向 `.git/modules`，返回 undefined（就地建会话）。
 */
export function mainRepositoryRoot(dir: string): string | undefined {
  let current = resolve(dir);
  for (;;) {
    const dotGit = resolve(current, '.git');
    if (existsSync(dotGit)) return repositoryRootAt(current, dotGit);
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * 目录落在链接工作树里时返回主仓库根；普通检出（含其子目录）返回 undefined。
 *
 * 工作区是主仓库，树只是会话的运行目录：宿主给工作树会话写的 header.cwd 就是
 * 主仓库根，运行目录另走 `working-directory/change`。聊天工作目录若跟着树走，
 * `/status` 与 `/sessions` 就会把树当成工作区。
 */
export function worktreeSourceRoot(dir: string): string | undefined {
  let current = resolve(dir);
  for (;;) {
    const dotGit = resolve(current, '.git');
    if (existsSync(dotGit)) return linkedWorktreeRoot(current, dotGit);
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** 该层目录属于哪个主仓库：`.git` 是目录取自身，是工作树指针取主仓库根，其它 undefined */
function repositoryRootAt(root: string, dotGit: string): string | undefined {
  let isDirectory: boolean;
  try {
    isDirectory = statSync(dotGit).isDirectory();
  } catch {
    return undefined;
  }
  if (isDirectory) return root;
  return linkedWorktreeRoot(root, dotGit);
}

/** `.git` 是指向 `<主仓库>/.git/worktrees/<名字>` 的文件时返回主仓库根，其它 undefined */
function linkedWorktreeRoot(root: string, dotGit: string): string | undefined {
  let isDirectory: boolean;
  try {
    isDirectory = statSync(dotGit).isDirectory();
  } catch {
    return undefined;
  }
  // 普通检出与子模块（gitdir 指向 .git/modules）都不是工作树
  if (isDirectory) return undefined;

  const target = readGitdir(dotGit);
  if (target === undefined) return undefined;
  const worktrees = dirname(isAbsolute(target) ? target : resolve(root, target));
  return basename(worktrees) === 'worktrees' && basename(dirname(worktrees)) === '.git'
    ? dirname(dirname(worktrees))
    : undefined;
}

/** 读 `.git` 文件里的 `gitdir:` 目标（工作树 / 子模块指针） */
function readGitdir(dotGit: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(dotGit, 'utf8');
  } catch {
    return undefined;
  }
  const line = content.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!/^gitdir:/i.test(line)) return undefined;
  const target = line.slice('gitdir:'.length).trim();
  return target === '' ? undefined : target;
}
