/**
 * 杂项命令
 *
 * - /steer：把一条排队消息改成插话（不中止当前生成）
 * - /stop：中止当前生成；`/stop <id>` 中止指定已获取会话；`/stop all` 中止全部
 */
import type { CommandDeps, SlashCommand } from './types.ts';
import type { SessionRecord } from '../session/index.ts';
import { getScopePeer } from '../shared/index.ts';
import { shortSessionId } from '../shared/utils.ts';
import {
  sessionTitleOf,
  sourceTitle,
  steeredPromptReceipt,
} from '../transport/session-source.ts';
import { sendMarkdownChunked } from '../shared/send-helper.ts';
import { ArgError, parseArgs, parseRest } from './args.ts';
import { matchSessionTarget } from './sessions.ts';

/**
 * 中止成功的回执：`⛔ 已中止「标题」 · #短id`，取不到标题时只给 id。
 *
 * 命令的字符串回复按纯文本发出、不渲染 markdown，所以这里不包反引号（正文版
 * 才包）；标题经 `sourceTitle` 压成一行并截断，避免撑破反馈行数。
 */
function cancelledReceipt(record: SessionRecord): string {
  const id = `#${shortSessionId(record.sessionId)}`;
  const title = sessionTitleOf(record);
  return title === undefined ? `⛔ 已中止 ${id}` : `⛔ 已中止「${sourceTitle(title)}」 · ${id}`;
}

/** /stop — 中止当前生成；`/stop <id>` 中止指定会话；`/stop all` 中止全体（隐藏） */
export function stopCommand({ manager }: CommandDeps): SlashCommand {
  return {
    name: 'stop',
    scope: 'all',
    description: '中止生成',
    hidden: true,
    usage: [
      '### 📖 /stop 用法',
      '',
      '`/stop` 中止当前生成',
      '`/stop <id>` 中止指定会话',
      '`/stop all` 中止全部生成',
      '',
      '排队中的消息一并丢弃；只想插队用 /steer',
      '目标用 8 位短 id（行首 `#` 后那串）',
    ].join('\n'),
    handler: (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const arg = parseRest(cmdCtx.command?.raw ?? '');

      if (arg === '') {
        const record = manager.getSessionRecord(scope, peerId);
        // 会话存在不等于正在生成：只有 agent 处于 running 才算有进行中的回复
        if (record === undefined || record.agent.status !== 'running') {
          return '⚠️ 当前没有进行中的生成';
        }

        // cancel 会让当前轮以 turn/end (kind=interrupted) 收尾，
        // 出站侧据此收尾本轮并投递已生成内容。
        record.agent.cancel({ kind: 'user' });
        return '⛔ 已中止';
      }

      if (arg.toLowerCase() === 'all') {
        const cancelled = manager.cancelAllRunning();
        return cancelled.length === 0
          ? '⚠️ 当前没有进行中的生成'
          : `⛔ 已中止 ${cancelled.length} 个会话`;
      }

      // 目标可以是任何一个已获取会话，不限于当前指针；匹配规则与 /sessions 同一份
      const candidates = manager.listAcquiredSessions().map((record) => ({
        id: record.sessionId,
        record,
      }));
      const target = matchSessionTarget(candidates, arg);
      if (!target.ok) {
        return `⚠️ ${target.error} · 用 /sessions 查看会话`;
      }
      const { record } = target.entry;
      if (record.agent.status !== 'running') {
        return `⚠️ 没有进行中的生成 · #${shortSessionId(record.sessionId)}`;
      }
      record.agent.cancel({ kind: 'user' });
      return cancelledReceipt(record);
    },
  };
}

/**
 * /steer — 把一条仍在排队的 prompt 改成插话（下一步消费）
 *
 * 只改落点，不中止当前生成、不写当前指针。消息 id 由排队回执带过来，
 * 手输时省略则取该会话最近一条排队消息。
 */
export function steerCommand({ manager, config }: CommandDeps): SlashCommand {
  return {
    name: 'steer',
    scope: 'all',
    description: '插话排队消息',
    usage: [
      '### 📖 /steer 用法',
      '',
      '/steer 插话当前会话最近一条排队消息',
      '/steer <id> 插话指定会话最近一条排队消息',
      '/steer <id> <消息id> 插话指定的那条消息',
      '',
      '只改落点，不中止当前生成；目标用 8 位短 id',
    ].join('\n'),
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      let parsed;
      try {
        parsed = parseArgs(cmdCtx.command?.raw ?? '', { command: 'steer' });
      } catch (error) {
        if (error instanceof ArgError) return error.message;
        throw error;
      }
      const words = parsed.words;
      if (words.length > 2) return '⚠️ 参数过多 · 用法: /help steer';

      let record: SessionRecord | undefined;
      let exactId: string | undefined;
      let itemId: string;
      if (words.length === 0) {
        record = manager.getSessionRecord(scope, peerId);
        if (record === undefined) return '⚠️ 当前没有会话 · 用 /sessions 恢复';
      } else {
        // 目标可以是任何一个已获取会话，不限于当前指针；匹配规则与 /sessions 同一份
        const candidates = manager.listAcquiredSessions().map((entry) => ({
          id: entry.sessionId,
          record: entry,
        }));
        const target = matchSessionTarget(candidates, words[0]!);
        if (!target.ok) return `⚠️ ${target.error} · 用 /sessions 查看会话`;
        record = target.entry.record;
        exactId = words[1];
      }

      const { agent } = record;
      const short = `#${shortSessionId(record.sessionId)}`;
      const queued = agent.inbox.nextTurn;
      const stepping = agent.inbox.nextStep;

      if (exactId !== undefined) {
        // 已经插过的不重复提交：队列项已被移到 next-step
        if (stepping.some((item) => item.id === exactId)) return `✅ 已经插话 · ${short}`;
        if (!queued.some((item) => item.id === exactId)) {
          return '⚠️ 这条消息已不在队列';
        }
        if (agent.status !== 'running') {
          return '⚠️ 本轮已结束 · 排队消息会继续发送';
        }
        itemId = exactId;
      } else {
        if (queued.length === 0) return `⚠️ 没有排队消息 · ${short}`;
        if (agent.status !== 'running') {
          return '⚠️ 本轮已结束 · 排队消息会继续发送';
        }
        itemId = queued[queued.length - 1]!.id;
      }

      const outcome = await manager.steerQueued(record.sessionId, itemId);
      if (outcome.ok) {
        const text = steeredPromptReceipt(
          record.sessionId,
          sessionTitleOf(record),
          manager.isCurrentSession(record.sessionId),
        );
        // 命令的字符串回复按纯文本发出；非当前会话的署名行带反引号，走 markdown
        if (manager.isCurrentSession(record.sessionId)) return text;
        await sendMarkdownChunked(cmdCtx, text, config.textChunkLimit);
        return { kind: 'noop' as const };
      }
      if (outcome.reason === 'not-found') return '⚠️ 这条消息已不在队列';
      if (outcome.reason === 'steer-unavailable') {
        return '⚠️ 本轮已结束 · 排队消息会继续发送';
      }
      return '❌ 插话失败';
    },
  };
}
