/**
 * PrefsStore — per-peer 会话偏好持久化（会话映射 + 工作目录）
 *
 * 隔离文件 I/O 操作，便于单元测试时 mock。
 * 存储路径：~/.dsh-qqbot/model-prefs.json（全局共享，多实例/多进程共存）。
 *
 * 并发安全（该文件存在多个写者——同进程多 bot 实例、跨进程多 profile）：
 * - 原子写：同目录临时文件 + rename，崩溃不留半份文件；
 * - 写前合并：重读磁盘，保留其他写者的条目，内存覆盖同 key（本进程视角权威）；
 * - 删除墓碑：本进程显式删除的 key 在合并时压住磁盘旧值，防止「删除被并发写复活」。
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { PLUGIN_HOME } from '../shared/dirs.ts';

/** 日志回调（可选） */
type DebugFn = (msg: string) => void;
/** 持久化异常回调（可选，应接 warn 级日志——映射丢失影响会话连续性，需可见） */
type ErrorFn = (msg: string) => void;

/** 隔离偏好文件结构 */
interface PrefsFile {
  /** sessionKey → 最新 sessionId（用于重启后恢复当前会话） */
  sessionIds: Record<string, string>;
  /** sessionKey → 该聊天当前所在的工作目录（换会话后跟着会话走，/new 保留） */
  dirs: Record<string, string>;
}

/** 各段的删除墓碑（key 集合），合并时用于压住磁盘上的旧值 */
interface Tombstones {
  sessionIds: Set<string>;
  dirs: Set<string>;
}

export class PrefsStore {
  /** per-peer 最新 sessionId（内存态） */
  private sessionIds = new Map<string, string>();
  /** per-peer 当前工作目录（内存态） */
  private dirs = new Map<string, string>();
  /** 本进程显式删除的 key（防止并发合并把删除复活） */
  private deleted: Tombstones = {
    sessionIds: new Set(),
    dirs: new Set(),
  };
  /** 隔离偏好文件路径 */
  private readonly prefsPath: string;
  private readonly debugLog?: DebugFn;
  private readonly onError?: ErrorFn;

  constructor(debugLog?: DebugFn, options?: { path?: string; onError?: ErrorFn }) {
    this.prefsPath = options?.path ?? resolve(PLUGIN_HOME, 'model-prefs.json');
    this.debugLog = debugLog;
    this.onError = options?.onError;
    this.load();
  }

  // ── SessionId 操作 ──

  getSessionId(sessionKey: string): string | undefined {
    return this.sessionIds.get(sessionKey);
  }

  setSessionId(sessionKey: string, sessionId: string): void {
    this.sessionIds.set(sessionKey, sessionId);
    this.deleted.sessionIds.delete(sessionKey);
    this.write();
  }

  clearSessionId(sessionKey: string): boolean {
    const deleted = this.sessionIds.delete(sessionKey);
    if (deleted) {
      this.deleted.sessionIds.add(sessionKey);
      this.write();
    }
    return deleted;
  }

  /** sessionKey → sessionId 快照（删除会话后重指向用） */
  sessionIdEntries(): Array<[string, string]> {
    return [...this.sessionIds.entries()];
  }

  // ── 工作目录操作 ──

  getDirectory(sessionKey: string): string | undefined {
    return this.dirs.get(sessionKey);
  }

  setDirectory(sessionKey: string, directory: string): void {
    if (this.dirs.get(sessionKey) === directory) return;
    this.dirs.set(sessionKey, directory);
    this.deleted.dirs.delete(sessionKey);
    this.write();
  }

  clearDirectory(sessionKey: string): boolean {
    const deleted = this.dirs.delete(sessionKey);
    if (deleted) {
      this.deleted.dirs.add(sessionKey);
      this.write();
    }
    return deleted;
  }

  // ── 私有方法 ──

  private load(): void {
    try {
      if (!existsSync(this.prefsPath)) return;
      const content = readFileSync(this.prefsPath, 'utf8');
      const data = JSON.parse(content) as PrefsFile;
      if (data.sessionIds && typeof data.sessionIds === 'object') {
        for (const [key, sessionId] of Object.entries(data.sessionIds)) {
          if (typeof sessionId === 'string' && sessionId) {
            this.sessionIds.set(key, sessionId);
          }
        }
      }
      if (data.dirs && typeof data.dirs === 'object') {
        for (const [key, dir] of Object.entries(data.dirs)) {
          if (typeof dir === 'string' && dir) {
            this.dirs.set(key, dir);
          }
        }
      }
    } catch (err) {
      const msg = `loadPrefs failed: ${err instanceof Error ? err.message : String(err)}`;
      // 解析失败（半截 JSON 等）意味着 sessionKey→sessionId 映射丢失，
      // 会话将回退固定 id——影响连续性，必须可见而非仅 debug
      this.onError?.(msg);
      this.debugLog?.(msg);
    }
  }

  /**
   * 读取磁盘当前状态用于合并。
   *
   * 不存在 → null（首次写）；损坏（半截 JSON 等）→ 先备份原文件再返回 null：
   * 损坏文件通常只是尾部截断，前面的映射条目往往完好，直接覆盖会把它们一并
   * 丢掉（用户表现为「QQ 里丢上下文」且无从恢复）。备份保留一份人工可救的证据。
   */
  private readDiskState(): PrefsFile | null {
    if (!existsSync(this.prefsPath)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.prefsPath, 'utf8');
    } catch {
      return null; // 读不到（权限/并发删除）：按首次写处理，不备份
    }
    try {
      const data = JSON.parse(raw) as PrefsFile;
      if (typeof data !== 'object' || data === null) throw new Error('not an object');
      return data;
    } catch {
      this.backupCorrupted(raw);
      return null;
    }
  }

  /** 损坏文件只备份一次（避免每次写入都产生新备份），失败不阻断写入 */
  private corruptedBackedUp = false;
  private backupCorrupted(raw: string): void {
    if (this.corruptedBackedUp) return;
    this.corruptedBackedUp = true;
    const backupPath = `${this.prefsPath}.corrupted.${Date.now()}`;
    try {
      writeFileSync(backupPath, raw, 'utf8');
      this.onError?.(`model-prefs.json 损坏，已备份原文件到 ${backupPath}（会话映射可能丢失，可从备份人工恢复）`);
    } catch (err) {
      this.onError?.(`model-prefs.json 损坏且备份失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 合并内存与磁盘（内存覆盖同 key，磁盘独有的其他写者条目保留，墓碑 key 除外） */
  private mergeDisk(disk: PrefsFile | null): PrefsFile {
    const pick = <T>(mem: Map<string, T>, diskMap: Record<string, T> | undefined, tomb: Set<string>): Record<string, T> => {
      const out = Object.fromEntries(mem.entries());
      if (diskMap && typeof diskMap === 'object') {
        for (const [key, value] of Object.entries(diskMap)) {
          if (key in out || tomb.has(key)) continue;
          out[key] = value;
        }
      }
      return out;
    };
    return {
      sessionIds: pick(this.sessionIds, disk?.sessionIds, this.deleted.sessionIds),
      dirs: pick(this.dirs, disk?.dirs, this.deleted.dirs),
    };
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.prefsPath), { recursive: true });
      const data = this.mergeDisk(this.readDiskState());
      // 原子写：同目录临时文件 + rename（同分区保证原子，崩溃不留半份文件）。
      // tmp 名带进程+随机后缀：跨进程并发写时各自的临时文件互不覆盖，
      // rename 只会带走自己写的那份（固定名会让 A 的 rename 落盘 B 的内容）
      const tmpPath = `${this.prefsPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        renameSync(tmpPath, this.prefsPath);
      } catch (err) {
        try { unlinkSync(tmpPath); } catch { /* 临时文件可能不存在 */ }
        throw err;
      }
    } catch (err) {
      const msg = `writePrefs failed: ${err instanceof Error ? err.message : String(err)}`;
      this.onError?.(msg);
      this.debugLog?.(msg);
    }
  }
}
