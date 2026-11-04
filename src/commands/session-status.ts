/**
 * 会话状态命令：/status
 *
 * 这个聊天当前会话的「现场」：会话 id 与生成状态、所在工作区、模型 / preset、
 * 消息数、上下文占用、累计 token、最后活动与闲置回收。
 *
 * 与其它状态类命令的分工：
 *   - `/bot-status` 是插件最早的最小视图（会话 id / 模型 / preset / 消息数），保持原样；
 *   - `/cost` 只看计费口径（累计 token 与缓存命中率）；
 *   - `/status` 是会话相关的完整状态，想知道「这个会话现在什么样」看它。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import type { SessionContextUsage, SessionManager } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope } from '../types.ts';
import { formatRelativeTime, getScopePeer, sendMarkdownChunked } from '../shared/index.ts';
import { shortId } from './sessions.ts';

/** 千分位（与 /cost 一致，避免不同环境的本地化分隔符） */
function num(n: number): string {
  return n.toLocaleString('en-US');
}

/** 毫秒时长 → 「27m」/「2h10m」（回收倒计时用） */
function span(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}

/** 上下文占用：占用 / 窗口 / 剩余（窗口没上报时只给占用量） */
function renderContext(ctx: SessionContextUsage): string | undefined {
  const { used, window } = ctx;
  if (used !== undefined && window !== undefined && window > 0) {
    const pct = ((used / window) * 100).toFixed(1);
    return `${num(used)} / ${num(window)}（${pct}%，剩 ${num(Math.max(0, window - used))}）`;
  }
  if (used !== undefined) return `${num(used)}（窗口未上报）`;
  if (window !== undefined) return `窗口 ${num(window)}（还没有请求）`;
  return undefined;
}

/**
 * 闲置回收：多久之后这个会话会被卸载。
 *
 * 卸载只释放内存里的 agent，会话日志还在盘上，下一条消息会自动 resume，
 * 所以文案要说明「会话不丢」，否则容易被理解成会话到期作废。
 */
function renderIdle(lastActivity: number | undefined, timeoutMs: number): string | undefined {
  if (!lastActivity || !(timeoutMs > 0)) return undefined;
  const remain = lastActivity + timeoutMs - Date.now();
  if (remain <= 0) return '即将释放内存（会话不丢）';
  return `${span(remain)} 后释放内存（会话不丢）`;
}

/** 渲染会话状态正文（handler 只负责兜错与发送） */
async function renderStatus(
  manager: SessionManager,
  config: ImQQBotConfig,
  scope: ChatScope,
  peerId: string,
): Promise<string> {
  const status = manager.getStatus(scope, peerId);
  const record = manager.getSessionRecord(scope, peerId);

  const lines: string[] = ['### 📊 会话状态', ''];

  // 会话：短 id + 是否正在生成
  if (status.active && status.sessionId) {
    const running = record?.agent.status === 'running';
    lines.push(`**会话**: \`#${shortId(status.sessionId)}\` · ${running ? '生成中' : '空闲'}`);
  } else {
    lines.push('**会话**: 未建立（发一条消息即创建）');
  }

  // 工作区：会话落在哪个目录（读不到就跳过，不影响其它字段）
  const workspace = await manager.currentWorkspaceInfo(scope, peerId).catch(() => undefined);
  if (workspace) {
    const missing = workspace.missing ? ' ⚠️ 目录已不存在' : '';
    lines.push(`**工作区**: ${workspace.title} · \`${workspace.path}\`${missing}`);
  }

  lines.push(`**模型**: ${status.model ? `${status.provider}/${status.model}` : '宿主默认'}`);
  if (status.preset) lines.push(`**Preset**: ${status.preset}`);

  // 以下只在会话已建立时有意义
  if (status.active) {
    lines.push(`**消息**: ${num(status.messageCount ?? 0)} 条`);

    const contextLine = renderContext(manager.getContextUsage(scope, peerId));
    if (contextLine) lines.push(`**上下文**: ${contextLine}`);

    const usage = manager.getTokenUsage(scope, peerId);
    if (usage.input + usage.output > 0) {
      lines.push(`**Token**: 输入 ${num(usage.input)} · 输出 ${num(usage.output)}（累计）`);
    }

    lines.push(`**最后活动**: ${formatRelativeTime(status.lastActivity)}`);
    const idle = renderIdle(record?.lastActivity, config.sessionIdleTimeout);
    if (idle) lines.push(`**闲置回收**: ${idle}`);
  }

  return lines.join('\n');
}

/** /status — 查看当前会话的完整状态 */
export function sessionStatusCommand({ manager, config, logger }: CommandDeps): CategorizedCommand {
  return {
    name: 'status',
    category: 'agent',
    scope: 'all',
    description: '查看会话状态：工作区 / 模型 / 上下文 / token',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);

      let text: string;
      try {
        text = await renderStatus(manager, config, scope, peerId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.warn(`/status 失败: ${message}`);
        text = `⚠️ 读取会话状态失败：${message}`;
      }

      // 统一走 markdown 通道：否则 `###` 与 `**` 会成为字面文本
      await sendMarkdownChunked(cmdCtx, text, config.textChunkLimit);
      return { kind: 'noop' as const };
    },
  };
}
