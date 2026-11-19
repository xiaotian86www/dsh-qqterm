/**
 * 目录浏览命令：/ls
 *
 *   /ls              列出当前工作区的子目录
 *   /ls <路径>       列出指定目录（相对当前工作区 / 绝对路径 / `~` 开头都认）
 *
 * 用途是「在 QQ 里逛目录」：先看当前工作区有哪些项目，点目录进去继续看，点文件
 * 直接把它发到聊天里（`/get`）。所以每个条目都是一个可点击命令：目录填 `/ls <路径>`、
 * 文件填 `/get <路径>`。
 *
 * 不给 `.` / `..` 这类固定条目——在 QQ 里它们渲染成的按钮太小，点起来费劲，
 * 回上一级直接写路径更实在。
 *
 * 条目的命令文本一律用**绝对路径**：相对路径的基准会随「当前工作区」变化，点进
 * 第二层就会跑偏，而绝对路径点进任何一层都稳。
 *
 * 与 `/new --dir <工作区>` 同一权限面：列目录等于让人看见 agent 能碰的文件系统，只允许
 * 唯一绑定用户（`access.owner`）。
 */
import type { CommandDeps, SlashCommand } from './types.ts';
import { parseRest } from './args.ts';
import type { ChatScope } from '../types.ts';
import { getScopePeer, sendMarkdownChunked } from '../shared/index.ts';
import { sessionAdminAuth } from './sessions.ts';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

/** 一次最多列多少个子目录（够逛，又不至于刷屏） */
const MAX_ENTRIES = 40;

const USAGE = [
  '### 📖 /ls 用法',
  '',
  '`/ls [路径]` 列出子目录',
  '不写路径看当前工作区；路径可用绝对路径或 `~`',
].join('\n');

/** 列目录的结果 */
type Listing =
  | { ok: true; dirs: string[]; files: string[] }
  | { ok: false; reason: 'missing' | 'not-directory' | 'denied' };

/** /ls — 列出目录里的子目录 */
export function lsCommand({ manager, config, logger }: CommandDeps): SlashCommand {
  return {
    name: 'ls',
    // 列目录 = 暴露文件系统结构：与 /new --dir <工作区> 同一权限面
    scope: 'c2c',
    authorized: sessionAdminAuth(config, logger),
    description: '列出子目录',
    usage: USAGE,
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      // 整行都是路径：带空格的路径不用引号也对，写了引号就去掉
      const arg = parseRest(cmdCtx.command?.raw ?? '');

      let text: string;
      try {
        text = await renderListing(manager, scope, peerId, arg);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.warn(`/ls 失败: ${message}`);
        text = `⚠️ 列目录失败: ${message}`;
      }

      // 统一走 markdown 通道：否则 `###` 与 <qqbot-cmd-input> 会成为字面文本
      await sendMarkdownChunked(cmdCtx, text, config.textChunkLimit);
      return { kind: 'noop' as const };
    },
  };
}

/**
 * 把参数解析成绝对路径。
 *
 * - 空 → 当前工作区目录；
 * - `~` / `~/xxx` → home 目录（手机上比敲绝对路径省事）；
 * - 绝对路径 → 原样规范化；
 * - 其它 → 相对当前工作区解析。
 *
 * @param base 当前工作区目录
 * @param arg 用户输入（已 trim）
 */
export function resolveLsTarget(base: string, arg: string): string {
  if (arg === '') return resolve(base);
  if (arg === '~') return homedir();
  if (arg.startsWith('~/') || arg.startsWith('~\\')) return resolve(homedir(), arg.slice(2));
  return isAbsolute(arg) ? resolve(arg) : resolve(base, arg);
}

/** 列出一个目录里的子目录与文件（符号链接按指向的类型归类） */
function listEntries(target: string): Listing {
  let stats;
  try {
    stats = statSync(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === 'EACCES' || code === 'EPERM' ? 'denied' : 'missing' };
  }
  if (!stats.isDirectory()) return { ok: false, reason: 'not-directory' };

  try {
    const dirs: string[] = [];
    const files: string[] = [];
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      const isDir = entry.isDirectory()
        || (entry.isSymbolicLink() && isDirectoryLink(target, entry.name));
      (isDir ? dirs : files).push(entry.name);
    }
    const byName = (left: string, right: string) => left.localeCompare(right);
    return { ok: true, dirs: dirs.sort(byName), files: files.sort(byName) };
  } catch {
    return { ok: false, reason: 'denied' };
  }
}

/** 符号链接是否指向目录（读不到就当作不是，别让一个坏链接拖垮整个列表） */
function isDirectoryLink(parent: string, name: string): boolean {
  try {
    return statSync(join(parent, name)).isDirectory();
  } catch {
    return false;
  }
}

/** 目录条目：点一下把 `/ls <路径>` 填进输入框 */
function dirButton(path: string, show: string): string {
  return `<qqbot-cmd-input text="${attr(`/ls ${path}`)}" show="${attr(show)}"/>`;
}

/** 文件条目：点一下把 `/get <路径>` 填进输入框，直接发文件 */
function fileButton(path: string, show: string): string {
  return `<qqbot-cmd-input text="${attr(`/get ${path}`)}" show="${attr(show)}"/>`;
}

/** 属性值转义：目录名里出现引号/尖括号不能把按钮标签弄坏 */
function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 渲染 `/ls` 的输出 */
async function renderListing(
  manager: CommandDeps['manager'],
  scope: ChatScope,
  peerId: string,
  arg: string,
): Promise<string> {
  const info = await manager.currentWorkspaceInfo(scope, peerId).catch(() => undefined);
  if (!info) return '⚠️ 读不到当前工作区。';
  if (info.missing) return `⚠️ 当前工作区目录不存在: \`${info.path}\``;

  const target = resolveLsTarget(info.path, arg);
  const listing = listEntries(target);
  if (!listing.ok) {
    switch (listing.reason) {
      case 'not-directory':
        return `⚠️ 不是目录: \`${target}\``;
      case 'denied':
        return `⚠️ 没有权限读取: \`${target}\``;
      default:
        return `⚠️ 目录不存在: \`${target}\``;
    }
  }

  const lines = [`### 📁 ${basename(target) || target} · \`${target}\``, ''];
  // 目录在前、文件在后，合计不超过上限
  const entries = [
    ...listing.dirs.map((name) => ({ name, dir: true })),
    ...listing.files.map((name) => ({ name, dir: false })),
  ];
  const shown = entries.slice(0, MAX_ENTRIES);
  for (const entry of shown) {
    lines.push(entry.dir
      ? dirButton(join(target, entry.name), entry.name)
      : fileButton(join(target, entry.name), entry.name));
  }
  if (entries.length === 0) lines.push('（这里是空的）');

  if (entries.length > shown.length) {
    lines.push('', `还有 ${entries.length - shown.length} 个条目，用 \`/ls <路径>\` 看更多`);
  }
  return lines.join('\n');
}
