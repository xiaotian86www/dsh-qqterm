/**
 * `/to <会话> -- <文本>` — 向指定会话发 prompt，或在它等答案时提交答案。
 *
 * 目标可以是当前会话、已获取的会话，或只在磁盘上的会话——最后一种先按 id 接回来
 * 再发（与 `/sessions resume` 同一条路）。命令不改 current：发完仍回到原来的
 * 会话，输出照样回 QQ（非 current 带来源行与回复链接）。
 *
 * 目标正在等 `ask_user_question` 时，文本必须走答案通道，不能当新 prompt
 * 排在问题后面——否则永远答不上。空文本进入「下一条消息作为回答」模式。
 *
 * 正文有两种写法：一段参数（有空格就用引号包起来），或 `--` 之后的整段原样。
 * 没包引号又有多段、或以 `-` 开头的词，按参数错误回绝。
 */
import type { CommandDeps, SlashCommand } from './types.ts';
import { ArgError, parseArgs } from './args.ts';
import type { CommandArgs, CommandSpec } from './args.ts';
import { getScopePeer, shortSessionId } from '../shared/index.ts';
import {
  queuedPromptReceipt,
  sessionTargetLabel,
  sessionTitleOf,
  steeredPromptReceipt,
} from '../transport/session-source.ts';
import { sendMarkdownChunked } from '../shared/send-helper.ts';
import { resolveSessionTarget } from './sessions.ts';
import { buildPromptBody } from '../transport/prompt-body.ts';
import { takeQuote } from './quote.ts';
import type { SessionRecord, WorkspaceGroup, WorkspaceSession } from '../session/index.ts';
import { errorMessage } from '../shared/utils.ts';

const USAGE = [
  '### 📖 /to 用法',
  '',
  '`/to <会话> <文本>` 向会话发消息；正文有空格就用引号包起来',
  '`/to <会话> -- <文本>` 正文写在 `--` 之后：整段原样，空格与换行都不必再包引号',
  '正文只能一段：没包引号又有多段、或以 `-` 开头的词，按参数错误回绝',
  '目标在等答案时，文本作为回答；没打开的会话会先接回来',
  '回复一条消息再发：被引用的内容会一起带上（目标在等答案时整条不发）',
  '没有正文时写 `/to <会话> --`：只带引用，或进入「下一条消息作为回答」模式',
].join('\n');

/** 正文被切成多段时回绝：要么包引号，要么写在 `--` 之后 */
const BODY_FORMAT = '⚠️ 正文只能一段：有空格就用引号包起来，或写到 -- 之后 · 用法: /help to';

/** 把分组列表摊平成可解析的会话清单 */
function flattenGroups(groups: readonly WorkspaceGroup[]): WorkspaceSession[] {
  const seen = new Set<string>();
  const out: WorkspaceSession[] = [];
  for (const group of groups) {
    for (const session of group.sessions) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      out.push(session);
    }
  }
  return out;
}

/** 展示用 id：`#` + 8 位短 id */
function displayId(id: string): string {
  return `#${shortSessionId(id)}`;
}

/** /to 的参数：目标 + 一段正文，或 `--` 之后的整段正文 */
const TO_SPEC: CommandSpec = { command: 'to', terminator: true };

/** 目标缺失 */
const MISSING_TARGET = '⚠️ 缺少会话 · 用法: /help to';

type ToParse = { ok: true; target: string; text: string } | { ok: false; error: string };

/**
 * 取会话与正文：一段参数，或 `--` 之后的整段。
 *
 * `/to #id`（或 `/to #id --`）是空正文，留给「只带引用」与「下一条消息作为回答」；
 * `/to #id 你好` 与 `/to #id "你好 世界"` 是同一段参数；`--` 之后整段原样（空格、
 * 换行、引号都不动）。没包引号又有多段、或正文以 `-` 开头，都按参数错误回绝。
 * 目标、正文与 `--` 一律交给同一份 parseArgs，不在命令里另写切词规则。
 */
function parseToArgs(raw: string): ToParse {
  let parsed: CommandArgs;
  try {
    parsed = parseArgs(raw, TO_SPEC);
  } catch (error) {
    if (error instanceof ArgError) return { ok: false, error: error.message };
    throw error;
  }
  const [target, ...extra] = parsed.words;
  if (target === undefined) return { ok: false, error: MISSING_TARGET };
  if (parsed.rest !== undefined) {
    if (extra.length > 0) return { ok: false, error: BODY_FORMAT };
    return { ok: true, target, text: parsed.rest };
  }
  if (extra.length > 1) return { ok: false, error: BODY_FORMAT };
  return { ok: true, target, text: extra[0] ?? '' };
}

export function toCommand({ manager, config, logger }: CommandDeps): SlashCommand {
  return {
    name: 'to',
    scope: 'c2c',
    description: '向会话发消息',
    acceptsQuote: true,
    usage: USAGE,
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);

      // 目标是一个位置参数，正文是一段参数或 `--` 之后的整段：回复链接已经带好
      // `--`，点开补正文即可
      const parsed = parseToArgs(cmdCtx.command?.raw ?? '');
      if (!parsed.ok) return parsed.error;
      const targetArg = parsed.target;
      const text = parsed.text;

      // 带引用的命令：引用取不到就什么都不发
      const taken = await takeQuote(cmdCtx, config.media, logger);
      if (typeof taken === 'string') return taken;
      const quote = taken;

      let target: WorkspaceSession | undefined;
      try {
        const groups = await manager.listWorkspaceGroups(scope, peerId);
        const resolved = resolveSessionTarget(flattenGroups(groups), targetArg);
        if (resolved.ok) target = resolved.entry;
      } catch (err) {
        logger?.warn(`/to 列举会话失败: ${errorMessage(err)}`);
      }

      // 列表里没有（例如 live 但没有 cwd）时，允许直接用完整 id
      let sessionId: string;
      let title: string | undefined;
      if (target) {
        // 列表不再预读标题，命中后只补这一条
        await manager.fillSessionTitles([target]);
        sessionId = target.id;
        title = target.title;
      } else {
        const candidate = targetArg.replace(/^#/, '');
        if (candidate.length < 4 || !manager.hasLiveSession(candidate)) {
          return `⚠️ 没有匹配的会话: ${targetArg}\n用 /sessions 里的 8 位短 id。`;
        }
        sessionId = candidate;
      }

      // 名字：列表里有就用列表的标题，否则从已获取会话的日志里捞一次
      if (title === undefined) {
        const record: SessionRecord | undefined = manager.findBySessionId(sessionId);
        title = record === undefined ? undefined : sessionTitleOf(record);
      }
      const label = sessionTargetLabel(sessionId, title);

      // 目标在等回答时，这条文本是答案不是新 prompt：答案不接受引用，整条拒绝
      if (manager.isAwaitingAnswer(sessionId) && quote !== undefined) {
        return '⚠️ 不支持带引用的答案';
      }
      const body = quote === undefined
        ? text
        : buildPromptBody({ quote: quote.quote, quoteFiles: quote.files, text });

      const outcome = await manager.sendTo(
        scope,
        peerId,
        cmdCtx.message.senderId ?? peerId,
        sessionId,
        body,
        { scope, targetId: peerId },
      );

      if (outcome.ok) {
        let receipt: string;
        switch (outcome.kind) {
          case 'answered':
            receipt = `✅ 已回答${label}`;
            break;
          case 'answer-mode':
            receipt = `💡 请发送回答: ${label}`;
            break;
          case 'queued':
          case 'steered': {
            // 排队 / 插话回执带可点的插话入口，命令的纯文本回复不渲染，走 markdown
            const current = manager.isCurrentSession(sessionId);
            const body = outcome.kind === 'queued'
              ? queuedPromptReceipt(
                sessionId,
                title,
                outcome.messageId,
                current,
                manager.canSteer(),
              )
              : steeredPromptReceipt(sessionId, title, current);
            await sendMarkdownChunked(cmdCtx, body, config.textChunkLimit);
            return { kind: 'noop' as const };
          }
          default:
            receipt = `✅ 已发送到${label}`;
            break;
        }
        return receipt;
      }

      switch (outcome.reason) {
        case 'not-found':
          return `⚠️ 没有这个会话: ${label}`;
        case 'locked':
          return `⚠️ 这个会话正在别处使用: ${label}`;
        case 'archived':
          return `⚠️ 该会话已归档: ${label}\n先 /sessions unarchive ${displayId(sessionId)}。`;
        case 'forbidden':
          return `⚠️ 这个会话属于另一个用户: ${label}`;
        case 'empty':
          return `⚠️ 缺少文本: ${label}\n/to ${displayId(sessionId)} <文本>`;
        default:
          return `❌ 发送失败: ${label}\n${outcome.message ?? '未知错误'}`;
      }
    },
  };
}
