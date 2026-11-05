/**
 * 会话相关命令
 *
 * - /new：开始新会话（换新 sessionId），可顺带指定工作区
 * - /reset（别名 /clear）：停掉当前会话，再在原工作区开新会话
 * - /compact：原地压缩会话历史（保留 sessionId，摘要替换旧历史）
 *
 * 两者都对应底层 dsh agent 能力，分类为 agent（通用能力）。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import type { ChangeWorkspaceOutcome } from '../session/index.ts';
import { getScopePeer } from '../shared/index.ts';
import { shortId } from './sessions.ts';

/** 千分位（与 /status 一致，避免不同环境的本地化分隔符） */
function num(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * /new — 开始新会话
 *
 * 不带参数：在当前工作区开新会话（旧会话继续在后台跑，与 `/reset` 不同）。
 * 带参数：在指定工作区开新会话。
 *
 * 参数先解析再动会话：路径写错不该把当前会话弄丢。换工作区等于换 agent 能读写
 * 的目录，所以带参数时要求白名单（`access.c2cAllow`），不带参数的 `/new` 不受
 * 限制。
 */
export function newCommand({ manager, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'new',
    category: 'agent',
    scope: 'all',
    description: '开始新会话（清空上下文，可指定工作区）',
    usage: [
      '/new',
      '/new <工作区|路径>',
      '',
      '不带参数：在当前工作区开新会话（上下文清空）。',
      '带参数：在指定工作区开新会话。',
      '工作区认标题、目录名（大小写不敏感，支持唯一前缀）或绝对路径。',
    ].join('\n'),
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const arg = (cmdCtx.command?.raw ?? '').trim();

      // 不带参数 = 留在当前工作区；异步释放 agent，不阻塞回复
      if (arg === '') {
        void manager.remove();
        return '✅ 已开启新会话';
      }

      // 带参数 = 换工作区（= 换 agent 能读写的目录）：只允许私聊 + 白名单
      const senderId = cmdCtx.message.senderId;
      const allowed = scope === 'c2c'
        && senderId !== undefined
        && config.access.c2cAllow.includes(senderId);
      if (!allowed) {
        return '⚠️ `/new <工作区>` 只在私聊 + 白名单（access.c2cAllow）可用；直接 `/new` 不受限制。';
      }

      // 先解析目标再动会话：路径写错不该把当前会话弄丢
      const resolved = manager.resolveWorkspace(arg);
      if (!resolved.ok) return describeChangeFailure(resolved);

      await manager.remove();
      const changed = await manager.changeChatWorkspace(scope, peerId, arg);
      if (!changed.ok) return describeChangeFailure(changed);
      return `✅ 已开启新会话\n工作区: ${changed.title} · ${changed.path}`;
    },
  };
}

/** 换工作区失败文案（`/new <工作区>` 用，措辞与成功结果的第二行对应） */
function describeChangeFailure(outcome: ChangeWorkspaceOutcome): string {
  if (outcome.ok) return '';
  switch (outcome.reason) {
    case 'has-session': {
      const id = outcome.sessionId ? `（\`#${shortId(outcome.sessionId)}\`）` : '';
      return `⚠️ 这个聊天已经有会话${id}，先 \`/new\` 再换工作区。`;
    }
    case 'missing':
      return `⚠️ 目录不存在: \`${outcome.path}\`\n换一个存在的目录，或直接给绝对路径。`;
    case 'ambiguous':
      return [
        `⚠️ 有 ${outcome.matches.length} 个工作区匹配: ${outcome.matches.join('、')}`,
        '用绝对路径: `/new D:\\项目\\目录`',
      ].join('\n');
    case 'not-found':
      return `⚠️ 没有叫 \`${outcome.arg}\` 的工作区。\`/sessions all\` 看全部工作区`;
    default:
      return '⚠️ 工作区切换失败。';
  }
}

/**
 * /reset（别名 /clear）— 停掉当前会话，再在原工作区开新会话
 *
 * 与 `/new` 的区别：`/new` 只把 current 指向新会话，旧会话继续在后台跑；
 * `/reset` 会 cancel 并释放当前会话，旧会话不再回 QQ。`/reset all` 停掉所有
 * 已获取会话。其它已获取会话不受影响（不带 all 时）。不支持工作区参数，
 * 换工作区用 `/new <工作区|路径>`。
 */
export function resetCommand({ manager }: CommandDeps): CategorizedCommand {
  return {
    name: ['reset', 'clear'],
    category: 'agent',
    scope: 'all',
    description: '停止当前会话并开启新会话，all 停全部',
    usage: [
      '/reset',
      '/reset all',
      '',
      '停止当前会话，再在原工作区开启新会话。',
      '带 all：停掉所有已获取会话，再开启新会话。',
      '要换工作区用 `/new <工作区|路径>`。',
    ].join('\n'),
    handler: async (cmdCtx) => {
      const arg = (cmdCtx.command?.raw ?? '').trim();
      const name = cmdCtx.command?.name ?? 'reset';

      if (arg !== '') {
        if (arg.toLowerCase() !== 'all') {
          return `⚠️ /${name} 不支持指定工作区\n换工作区用 /new <工作区|路径>。`;
        }

        const stopped = await manager.resetAllSessions();
        return stopped === 0
          ? '✅ 已开启新会话'
          : `✅ 已停止 ${stopped} 个会话，并开启新会话`;
      }

      const stopped = await manager.resetCurrentSession();
      return stopped ? '✅ 已停止当前会话，并开启新会话' : '✅ 已开启新会话';
    },
  };
}

/** /compact — 原地压缩会话历史 */
export function compactCommand({ manager }: CommandDeps): CategorizedCommand {
  return {
    name: 'compact',
    category: 'agent',
    scope: 'all',
    description: '压缩会话历史（摘要替换旧记录，保留上下文）',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const msg = cmdCtx.message;
      const outcome = await manager.compact(scope, peerId, {
        senderId: msg.senderId,
        replyTarget: { scope, targetId: peerId, msgId: msg.messageId },
      });

      if (outcome.ok) {
        if (!outcome.shadowed) return '⚠️ 没有可压缩的历史';
        // 不估算压缩后的占比：真实占用要等下一轮请求才更新，估出来的值会自相矛盾
        return `✅ 已压缩 ${outcome.shadowed} 条历史记录（约 ${num(outcome.tokens ?? 0)} tokens）`;
      }

      switch (outcome.reason) {
        case 'no-session':
          return '⚠️ 当前无活跃会话';
        case 'busy':
          return '⚠️ 正在生成中，无法压缩';
        default:
          return `❌ 压缩失败: ${outcome.message ?? '未知错误'}`;
      }
    },
  };
}
