/**
 * 会话状态命令：/status
 *
 * 当前聊天会话的「现场」：会话标题与 id、生成状态、所在工作区、模型 / preset、
 * 消息数、上下文占用、累计 token。
 *
 * 与其它状态类命令的分工：
 *   - `/bot-status` 是最小视图（会话 / 模型 / preset / 消息数），与这里共用「会话」写法；
 *   - `/cost` 只看计费口径（累计 token 与缓存命中率）；
 *   - `/status` 是会话相关的完整状态，想知道「这个会话现在什么样」看它。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import type { SessionContextUsage, SessionManager } from '../session/index.ts';
import type { ChatScope } from '../types.ts';
import { getScopePeer, sendMarkdownChunked } from '../shared/index.ts';
import { sessionTargetLabel, sessionTitleOf } from '../transport/session-source.ts';
import { effortLabel } from '../model/effort-label.ts';

/** 千分位（与 /cost 一致，避免不同环境的本地化分隔符） */
function num(n: number): string {
  return n.toLocaleString('en-US');
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

/** 渲染会话状态正文（handler 只负责兜错与发送） */
async function renderStatus(
  manager: SessionManager,
  scope: ChatScope,
  peerId: string,
): Promise<string> {
  const status = manager.getStatus(scope, peerId);
  const record = manager.getSessionRecord(scope, peerId);

  const lines: string[] = ['### 📊 会话状态', ''];

  // 会话：标题 + 短 id + 是否正在生成（标题还没生成时只给 id）
  if (status.active && status.sessionId) {
    const running = record?.agent.status === 'running';
    const title = record === undefined ? undefined : sessionTitleOf(record);
    lines.push(
      `**会话**: ${sessionTargetLabel(status.sessionId, title)} · ${running ? '生成中' : '空闲'}`,
    );
  } else {
    lines.push('**会话**: 未建立');
  }

  // 工作区：会话落在哪个目录（读不到就跳过，不影响其它字段）
  const workspace = await manager.currentWorkspaceInfo(scope, peerId).catch(() => undefined);
  if (workspace) {
    const missing = workspace.missing ? ' ⚠️ 目录已不存在' : '';
    lines.push(`**工作区**: ${workspace.title} · \`${workspace.path}\`${missing}`);
  }

  lines.push(`**模型**: ${status.model ? `${status.provider}/${status.model}` : '宿主默认'}`);
  // 思考强度跟着模型走：只在模型支持时显示
  const effort = await manager.getEffortView(scope, peerId);
  if (effort.current) {
    lines.push(`**思考强度**: ${effortLabel(effort.current)}${effort.defaulted ? '（默认）' : ''}`);
  }
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
  }

  return lines.join('\n');
}

/** /status — 查看当前会话的完整状态 */
export function sessionStatusCommand({ manager, config, logger }: CommandDeps): CategorizedCommand {
  return {
    name: 'status',
    category: 'agent',
    scope: 'all',
    description: '查看会话状态（含上下文与 token）',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);

      let text: string;
      try {
        text = await renderStatus(manager, scope, peerId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.warn(`/status 失败: ${message}`);
        text = `⚠️ 读取会话状态失败: ${message}`;
      }

      // 统一走 markdown 通道：否则 `###` 与 `**` 会成为字面文本
      await sendMarkdownChunked(cmdCtx, text, config.textChunkLimit);
      return { kind: 'noop' as const };
    },
  };
}
