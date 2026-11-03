/**
 * 宿主会话存储（JSONL 持久化）的定位与删除
 *
 * 宿主没有删除会话的 API（dsh-session-persistence-jsonl 的 README 原文：
 * 「日志累积在 root 下，直到被外部删除；该 seam 没有删除 API」）。插件要支持
 * 「删除指定会话」，只能在磁盘上定位并移除后端的会话目录：
 *
 *   <root>/--<cwd>--/<sessionId>/session.vN.jsonl[.zstd]
 *
 * 定位刻意**不复制**宿主的路径编码规则（cwd 归一化 / session id 转义都可能
 * 随版本漂移），而是扫描 root 下的一层 project 目录，用「目录名 === sessionId
 * 且目录内确实存在会话日志文件」双重校验，避免误删同名普通目录。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** 会话日志文件名：session.jsonl / session.v3.jsonl / 各自的 .zstd 变体 */
const SESSION_LOG_FILE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/;

/** 一处已定位的会话目录 */
export interface FoundSessionDir {
  /** 会话 id（= 目录名） */
  id: string;
  /** 会话目录的绝对路径 */
  path: string;
  /** 目录占用字节数（递归求和，失败的文件按 0 计） */
  bytes: number;
}

/** 删除结果 */
export interface RemoveSessionsResult {
  /** 已删除的会话目录 */
  removed: FoundSessionDir[];
  /** 删除失败的会话 */
  failed: Array<{ id: string; path?: string; message: string }>;
  /** 磁盘上找不到目录的 id（从未落盘 / 已被删除 / id 被宿主转义） */
  missing: string[];
}

/** 文件名是否为会话日志 */
export function isSessionLogName(name: string): boolean {
  return SESSION_LOG_FILE.test(name);
}

/**
 * 目标路径是否严格位于 root 之内（root 本身不算）。
 *
 * 删除前必须过这道闸：root 来自宿主服务，目录名来自会话 id，两者都不该让
 * rm -rf 落到 root 之外。
 */
export function isPathInside(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/** 目录占用字节数（递归；读不到的文件忽略） */
function directorySize(dir: string): number {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += directorySize(path);
      else if (entry.isFile()) total += statSync(path).size;
    } catch {
      // 被并发删除 / 无权限：不计入
    }
  }
  return total;
}

/** 目录内是否有会话日志文件 */
function hasSessionLog(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isFile() && isSessionLogName(entry.name));
  } catch {
    return false;
  }
}

/**
 * 在 root 下定位给定 id 的会话目录。
 *
 * 同一个 id 可能出现在多个 project 目录（历史上重复写入会这样），全部返回，
 * 删除时一并清掉——宿主的 `list()` 遇到重复 id 会整体报错。
 *
 * @param root 会话存储根目录（缺失或不可读时返回空数组）
 * @param ids 待定位的会话 id
 */
export function findSessionDirs(root: string, ids: Iterable<string>): FoundSessionDir[] {
  const wanted = new Set(ids);
  if (wanted.size === 0 || !existsSync(root)) return [];

  const found: FoundSessionDir[] = [];
  let projects: Dirent[];
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    let entries: Dirent[];
    try {
      entries = readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue; // 不可读的 project 目录跳过，不影响其它会话
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !wanted.has(entry.name)) continue;
      const path = join(projectPath, entry.name);
      if (!hasSessionLog(path)) continue;
      found.push({ id: entry.name, path, bytes: directorySize(path) });
    }
  }
  return found;
}

/**
 * 删除给定会话的磁盘目录。
 *
 * 只删「root 内 + 目录名匹配 + 含会话日志」的目录；越界一律拒绝并记入 failed，
 * 绝不为了“删干净”而超出 root。
 *
 * @param root 会话存储根目录
 * @param ids 待删除的会话 id
 */
export function removeSessionDirs(root: string, ids: readonly string[]): RemoveSessionsResult {
  const result: RemoveSessionsResult = { removed: [], failed: [], missing: [] };
  if (ids.length === 0) return result;

  const found = findSessionDirs(root, ids);
  const foundIds = new Set(found.map((dir) => dir.id));

  for (const dir of found) {
    if (!isPathInside(root, dir.path)) {
      result.failed.push({ id: dir.id, path: dir.path, message: '目录不在会话存储根目录内，已拒绝删除' });
      continue;
    }
    try {
      rmSync(dir.path, { recursive: true, force: true, maxRetries: 3 });
      result.removed.push(dir);
    } catch (err) {
      // Windows 上会话仍被宿主进程（如 Web 端打开中）持有会 EBUSY/EPERM
      result.failed.push({
        id: dir.id,
        path: dir.path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const id of ids) {
    if (!foundIds.has(id)) result.missing.push(id);
  }
  return result;
}
