/**
 * 会话管理命令：/sessions（别名 /session）
 *
 * 子命令：
 *   /sessions                 列出本工作区的会话（与 Web 侧栏同一来源）
 *   /sessions resume <序号|id> 把当前聊天切到指定会话，接上历史继续
 *   /sessions delete <序号|id> 删除指定会话（连磁盘日志一起删，不可恢复）
 *
 * 输出统一走 sendMarkdownChunked（与 /model、/preset 一致）：普通字符串回复
 * 不会按 markdown 渲染，`###` 和 `<qqbot-cmd-input>` 会原样显示成文本。
 * 列表里每条会话渲染成可点击命令，点一下就把 `/sessions resume <n>` 填进输入框。
 *
 * 删除是宿主的缺口：`SessionPersistence` 没有删除 API，这里按 JSONL 后端的
 * 磁盘布局定位会话目录后移除（见 session-store.ts）。删除前会释放进程内
 * agent、把悬空映射换成新 id，并连带删除其 subagent 子会话。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import type { ImQQBotConfig } from '../config.ts';
import { getScopePeer, formatRelativeTime, sendMarkdownChunked } from '../shared/index.ts';
import type { Logger } from '../types.ts';
import type { WorkspaceSession } from '../session/index.ts';

/** 列表最多展示多少条（其余折叠为提示） */
const LIST_LIMIT = 10;

/** 标题渲染上限（日志标题可能很长） */
const TITLE_MAX = 28;

/**
 * 会话管理鉴权。
 *
 * 删除是不可恢复的破坏性操作，且列表里能看到别的聊天的会话标题，
 * 因此要求操作者在 `access.c2cAllow` 名单内；没配名单时一律拒绝（fail-closed），
 * 哪怕 `c2cMode` 是 open——open 是「谁能和 bot 聊天」，不是「谁能删库」。
 */
export function sessionAdminAuth(
  config: ImQQBotConfig,
  logger?: Logger,
): (ctx: { message: { senderId?: string } }) => boolean | string {
  return (ctx) => {
    const allow = config.access.c2cAllow;
    const senderId = ctx.message.senderId;
    if (senderId !== undefined && allow.includes(senderId)) return true;
    logger?.warn(`im-qqbot: /sessions denied: sender=${senderId ?? '(missing)'} allowlist=${allow.length}`);
    return allow.length === 0
      ? '⚠️ 会话管理需要先配置白名单：把你的 OpenID（/bot-me 可查）加入 access.c2cAllow'
      : '⚠️ 会话管理仅限白名单用户（access.c2cAllow）';
  };
}

const USAGE = [
  '**会话管理**',
  '`/sessions` 列出会话',
  '`/sessions resume <序号|id>` 恢复会话（接上历史继续聊）',
  '`/sessions delete <序号|id>` 删除会话（连磁盘一起删，不可恢复）',
].join('\n');

/** 目标解析结果 */
export type SessionTargetResult =
  | { ok: true; entry: WorkspaceSession }
  | { ok: false; error: string };

/**
 * 把用户输入解析成列表中的一条会话。
 *
 * 支持序号（1 起，与列表一致）或 id 前缀；前缀至少 4 位且必须唯一，
 * 避免误删/误切到相近 id。
 */
export function resolveSessionTarget(
  entries: readonly WorkspaceSession[],
  raw: string,
): SessionTargetResult {
  const arg = raw.trim();
  if (arg === '') return { ok: false, error: `缺少目标。\n\n${USAGE}` };

  if (/^\d+$/.test(arg)) {
    const index = Number(arg);
    const entry = entries[index - 1];
    if (!entry) return { ok: false, error: `序号 ${arg} 超出范围（当前共 ${entries.length} 个会话）` };
    return { ok: true, entry };
  }

  if (arg.length < 4) return { ok: false, error: 'id 至少写 4 位，或者直接用列表里的序号' };

  const matches = entries.filter((entry) => entry.id === arg || entry.id.startsWith(arg));
  if (matches.length === 0) return { ok: false, error: `没有匹配的会话：${arg}` };
  if (matches.length > 1) return { ok: false, error: `id 前缀匹配到 ${matches.length} 个会话，请写长一点` };
  const entry = matches[0];
  return entry ? { ok: true, entry } : { ok: false, error: `没有匹配的会话：${arg}` };
}

/** 展示用短 id：去掉统一的 `session-` 前缀，避免只显示出一个前缀 */
function shortId(id: string): string {
  return id.replace(/^session-/, '').slice(0, 8);
}

/** 标题压缩成单行短文本（换行会打散列表，引号会破坏命令标签属性） */
function shortTitle(entry: WorkspaceSession): string {
  const raw = (entry.title ?? '').replace(/[\r\n]+/g, ' ').replace(/[`*_~<>"']/g, '').trim();
  if (raw === '') return `未命名会话（${shortId(entry.id)}）`;
  return raw.length > TITLE_MAX ? `${raw.slice(0, TITLE_MAX)}…` : raw;
}

/** 人类可读的字节数 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function sessionsCommand({ manager, config, logger }: CommandDeps): CategorizedCommand {
  return {
    name: ['sessions', 'session'],
    category: 'agent',
    // 会话里可能含其它 chat 的历史标题，且删除不可恢复：只允许私聊 + 白名单
    scope: 'c2c',
    authorized: sessionAdminAuth(config, logger),
    description: '会话管理：列出 / 恢复 / 删除',
    usage: USAGE,
    handler: async (cmdCtx) => {
      const args = (cmdCtx.command?.raw ?? '').trim();
      const [sub = '', ...rest] = args.split(/\s+/).filter(Boolean);
      const { scope, peerId } = getScopePeer(cmdCtx);

      const loadEntries = async (): Promise<WorkspaceSession[] | string> => {
        try {
          return await manager.listWorkspaceSessions(scope, peerId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger?.warn(`/sessions 列举会话失败: ${message}`);
          return `⚠️ 读取会话列表失败：${message}`;
        }
      };

      const render = async (): Promise<string> => {
        switch (sub) {
          case '':
          case 'list': {
            const entries = await loadEntries();
            if (typeof entries === 'string') return entries;
            return renderList(entries);
          }

          case 'resume':
          case 'r': {
            const entries = await loadEntries();
            if (typeof entries === 'string') return entries;
            const target = resolveSessionTarget(entries, rest[0] ?? '');
            if (!target.ok) return target.error;
            if (target.entry.current) return '这已经是当前会话，直接发消息就行';

            const outcome = await manager.switchSession(
              scope,
              peerId,
              target.entry.id,
              cmdCtx.message.senderId ?? peerId,
              { scope, targetId: peerId, msgId: cmdCtx.message.messageId },
            );
            if (outcome.ok) {
              return [
                `✅ 已恢复会话「${shortTitle(target.entry)}」`,
                `\`${shortId(target.entry.id)}\` · 历史已接上，直接发消息继续`,
              ].join('\n');
            }
            switch (outcome.reason) {
              case 'not-found':
                return '⚠️ 磁盘上没有这个会话（可能已被删除），先 /sessions 看看列表';
              case 'in-use':
                return '⚠️ 该会话正在另一个聊天中使用，先在那个聊天里 /new 再切过来';
              default:
                return `⚠️ 恢复失败：${outcome.message ?? '未知错误（可能被 Web 端打开占用）'}`;
            }
          }

          case 'delete':
          case 'rm': {
            const entries = await loadEntries();
            if (typeof entries === 'string') return entries;
            const target = resolveSessionTarget(entries, rest[0] ?? '');
            if (!target.ok) return target.error;

            const outcome = await manager.deleteSessions([target.entry.id]);
            return renderDelete(target.entry, outcome);
          }

          case 'help':
            return USAGE;

          default:
            return `未知子命令：${sub}\n\n${USAGE}`;
        }
      };

      // 统一走 markdown 通道：否则 `###` 与 <qqbot-cmd-input> 会成为字面文本
      await sendMarkdownChunked(cmdCtx, await render(), config.textChunkLimit);
      return { kind: 'noop' as const };
    },
  };
}

/**
 * 渲染会话列表。
 *
 * 每条非当前会话都是一个可点击的命令：点一下把 `/sessions resume <序号>`
 * 填进输入框（与 /model 的模型列表同一交互）。当前会话只是状态行，点了没意义。
 */
function renderList(entries: readonly WorkspaceSession[]): string {
  if (entries.length === 0) {
    return '这个工作区还没有会话。发一条消息就会创建第一个会话。';
  }

  const shown = entries.slice(0, LIST_LIMIT);
  const lines: string[] = [`### 🗂 会话（共 ${entries.length} 个，点击即可恢复）`, ''];

  shown.forEach((entry, index) => {
    const index_ = index + 1;
    const label = `${index_}. ${[
      shortTitle(entry),
      formatRelativeTime(entry.createdAt),
      ...(entry.live && !entry.current ? ['使用中'] : []),
    ].join(' · ')}`;

    if (entry.current) {
      lines.push(`✅ **当前** · ${label}`);
      return;
    }
    lines.push(`<qqbot-cmd-input text="/sessions resume ${index_}" show="${label}"/>`);
  });

  if (entries.length > shown.length) {
    lines.push('', `还有 ${entries.length - shown.length} 个更早的会话未显示`);
  }
  lines.push(
    '',
    '删除：`/sessions delete <序号|id>`（连磁盘一起删，不可恢复）',
  );
  return lines.join('\n');
}

/** 渲染删除结果 */
function renderDelete(
  entry: WorkspaceSession,
  outcome: Awaited<ReturnType<CommandDeps['manager']['deleteSessions']>>,
): string {
  if (!outcome.ok && outcome.reason === 'no-root') {
    return `⚠️ 无法删除：${outcome.message ?? '宿主未暴露会话存储目录'}`;
  }
  if (!outcome.ok && outcome.reason === 'not-found') {
    return [
      `⚠️ 磁盘上没有找到会话 \`${shortId(entry.id)}\``,
      '它可能从未落盘或已被删除；如果列表里还能看到，说明宿主索引还没刷新。',
    ].join('\n');
  }

  const lines: string[] = [];
  if (outcome.removed.length > 0) {
    const freed = outcome.removed.reduce((sum, item) => sum + item.bytes, 0);
    lines.push(`🗑 已删除会话「${shortTitle(entry)}」\`${shortId(entry.id)}\``);
    lines.push(`释放 ${formatBytes(freed)}${outcome.cascaded > 0 ? `（含 ${outcome.cascaded} 个子会话）` : ''}`);
  }
  if (entry.current) lines.push('刚才删的是当前会话，已自动切换到一个新会话。');

  for (const failure of outcome.failed) {
    lines.push(`⚠️ \`${shortId(failure.id)}\` 删除失败：${failure.message}`);
  }
  if (outcome.remapped > 0) lines.push(`已把 ${outcome.remapped} 个聊天的会话映射改到新会话。`);
  if (outcome.removed.length > 0) lines.push('Web 侧栏刷新后该会话就不再出现。');
  return lines.join('\n') || '没有删除任何会话。';
}
