/**
 * 会话状态命令：/status
 *
 * 当前聊天会话的「现场」：会话标题与 id、生成状态、所在工作区、模型 / 思考强度 /
 * preset / 权限、上下文占用。
 *
 * 与其它状态类命令的分工：
 *   - `/cost` 只看计费口径（累计 token 与缓存命中率）；
 *   - `/status` 是会话相关的完整状态，想知道「这个会话现在什么样」看它。
 */
import type { CommandDeps, SlashCommand } from './types.ts';
import type { SessionContextUsage, SessionManager, SessionTurnProgress } from '../session/index.ts';
import type { ChatScope } from '../types.ts';
import { getScopePeer, sendMarkdownChunked } from '../shared/index.ts';
import { sessionTargetLabel, sessionTitleOf } from '../transport/session-source.ts';
import { effortLabel } from '../model/effort-label.ts';
import { presetLabel } from './permission.ts';

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

/** 时长（轮次 / 阶段耗时）：60s 内给秒，1h 内给分秒，再长给时分 */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}

/**
 * 生成状态：先给步数与累计时长（看出跑了多久、是否在动），最后说现在在做什么；
 * 「生成中」与「正在 read」是同一件事，不重复写。
 */
function renderState(progress: SessionTurnProgress | undefined): string {
  if (!progress) return '生成中';
  const parts: string[] = [];
  if (progress.step !== undefined) parts.push(`第 ${progress.step} 步`);
  // elapsedMs 是本轮从 turn/start 起的累计时间；标「共」避免被读成当前这一步的耗时
  parts.push(`共 ${formatDuration(progress.elapsedMs)}`);
  parts.push(progress.waiting === 'tool'
    ? (progress.toolName ? `正在 \`${progress.toolName}\`` : '正在执行工具')
    : '等待模型响应');
  return parts.join(' · ');
}

/** 重试退避单独一行：它和「在等什么」不是同一件事，混进状态会看不清还要等多久 */
function renderRetry(progress: SessionTurnProgress): string | undefined {
  if (!progress.retry) return undefined;
  const remaining = progress.retry.since + progress.retry.delayMs - Date.now();
  return `**重试**: 第 ${progress.retry.attempt} 次 · ${remaining > 0 ? `${formatDuration(remaining)} 后重发` : '正在重发'}`;
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

  // 会话：标题 + 短 id（标题还没生成时只给 id）
  const running = record?.agent.status === 'running';
  if (status.active && status.sessionId) {
    const title = record === undefined ? undefined : sessionTitleOf(record);
    lines.push(`**会话**: ${sessionTargetLabel(status.sessionId, title)}`);

    // 状态：生成中 / 空闲以及生成中的现场都收在这一行
    const progress = running ? manager.getTurnProgress(scope, peerId) : undefined;
    lines.push(`**状态**: ${running ? renderState(progress) : '空闲'}`);
    if (running && progress) {
      const retry = renderRetry(progress);
      if (retry) lines.push(retry);
    }
  } else {
    lines.push('**会话**: 未建立');
  }

  // 工作区：会话落在哪个目录（读不到就跳过，不影响其它字段）
  const workspace = await manager.currentWorkspaceInfo(scope, peerId).catch(() => undefined);
  if (workspace) {
    const missing = workspace.missing ? ' ⚠️ 目录已不存在' : '';
    // 没有工作区名（没有 registry）时只给路径，不拿末段目录名冒充
    const prefix = workspace.title === '' ? '' : `${workspace.title} · `;
    lines.push(`**工作区**: ${prefix}\`${workspace.path}\`${missing}`);
  }

  // 模型 / 思考强度 / preset / 权限：没有会话时展示部署默认值（新建会话会用它），
  // 与各命令的「当前」口径一致，不另标默认
  if (status.model) {
    lines.push(`**模型**: ${status.provider}/${status.model}`);
  }
  // 思考强度跟着模型走：只在模型支持时显示
  const effort = await manager.getEffortView(scope, peerId);
  if (effort.current) {
    lines.push(`**思考强度**: ${effortLabel(effort.current)}`);
  }
  const preset = manager.getEffectivePreset(scope, peerId);
  if (preset) lines.push(`**Preset**: ${preset}`);
  const permission = manager.getPermissionPreset(scope, peerId);
  if (permission) {
    const entry = manager.listPermissionPresets().find((item) => item.id === permission);
    lines.push(`**权限**: ${presetLabel(permission, entry)}`);
  } else {
    // 宿主读不出权限（目录投影缺失等）时也保留字段，不能整行消失
    lines.push('**权限**: —');
  }

  // 上下文只在会话已建立时有意义；消息数与累计 token 不在这里重复
  if (status.active) {
    const contextLine = renderContext(manager.getContextUsage(scope, peerId));
    if (contextLine) lines.push(`**上下文**: ${contextLine}`);
  }

  // 生成中给一个可点击的停止入口：QQ 不能编辑消息，停止要能直接点到
  if (running) {
    lines.push('', '<qqbot-cmd-input text="/stop" show="停止生成"/>');
  }

  return lines.join('\n');
}

/** /status — 查看当前会话的完整状态 */
export function sessionStatusCommand({ manager, config, logger }: CommandDeps): SlashCommand {
  return {
    name: 'status',
    scope: 'all',
    description: '查看会话状态',
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
