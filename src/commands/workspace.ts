/**
 * 工作区命令：/workspace
 *
 *   /workspace                     看当前工作区（标题 / 路径 / 还能不能改）
 *   /workspace <名字|路径>          换工作区（下一个会话落在哪）
 *
 * 「工作区」就是会话的 cwd：它决定 agent 在哪个目录读写文件，也决定 `/sessions`
 * 列出哪个项目里的会话。cwd 在会话创建时写进 header，宿主没有改它的接口
 * （`workingDirectory` 只读），所以换工作区只能在会话**落盘之前**生效：`/new`
 * 之后，或这个聊天还没说过话。已有会话时直接拒绝，并给出「先 /new」的下一步
 * ——不然改目录是静默无效的（resume 回来的会话以自己的 header.cwd 为准）。
 *
 * 参数认三种：宿主工作区的标题、目录名（都大小写不敏感、支持唯一前缀）、绝对
 * 路径。标题一般是宿主按目录名自动生成的，用户改过标题时两种写法都能用。
 *
 * 与 `/sessions` 同一权限面：换工作区等于换 agent 能碰的目录，只允许私聊 +
 * 白名单（`access.c2cAllow`，空名单拒绝）。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import type { ChangeWorkspaceOutcome, SessionManager } from '../session/index.ts';
import type { ChatScope } from '../types.ts';
import { getScopePeer, sendMarkdownChunked } from '../shared/index.ts';
import { sessionAdminAuth, shortId } from './sessions.ts';

const USAGE = [
  '**工作区**',
  '`/workspace` 看当前工作区',
  '`/workspace <名字|路径>` 换（只能在 `/new` 之后改）',
].join('\n');

/** 已有会话时的下一步：这是唯一能换工作区的路径 */
const NEW_HINT = '换工作区：`/new <名字|路径>`（也可以先 `/new`，再 `/workspace <名字>`）';

/** /workspace — 查看 / 切换当前聊天的工作区 */
export function workspaceCommand({ manager, config, logger }: CommandDeps): CategorizedCommand {
  return {
    name: 'workspace',
    category: 'agent',
    // 换工作区 = 换 agent 能读写的目录：与 /sessions 同一权限面
    scope: 'c2c',
    authorized: sessionAdminAuth(config, logger),
    description: '工作区：查看 / 切换（/new 后可改）',
    usage: USAGE,
    handler: async (cmdCtx) => {
      const arg = (cmdCtx.command?.raw ?? '').trim();
      const { scope, peerId } = getScopePeer(cmdCtx);

      let text: string;
      try {
        text = arg === ''
          ? await renderCurrent(manager, scope, peerId)
          : renderChange(await manager.changeChatWorkspace(scope, peerId, arg));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.warn(`/workspace 失败: ${message}`);
        text = `⚠️ 工作区操作失败：${message}`;
      }

      // 统一走 markdown 通道：否则 `###` 与 `**` 会成为字面文本
      await sendMarkdownChunked(cmdCtx, text, config.textChunkLimit);
      return { kind: 'noop' as const };
    },
  };
}

/** 当前工作区视图：在哪、还能不能改 */
async function renderCurrent(
  manager: SessionManager,
  scope: ChatScope,
  peerId: string,
): Promise<string> {
  const info = await manager.currentWorkspaceInfo(scope, peerId).catch(() => undefined);
  if (!info) return '⚠️ 读不到当前工作区。';

  const state = await manager.canChooseWorkspace(scope, peerId)
    .catch(() => ({ canChoose: false, sessionId: undefined as string | undefined }));

  const lines = ['### 🗂 工作区', '', `**${info.title}** · \`${info.path}\``];
  if (info.missing) lines.push('', '⚠️ 目录已不存在，换一个：`/workspace <名字|路径>`');

  lines.push('');
  if (state.canChoose) {
    lines.push('下一条消息会在这里开新会话。');
    lines.push('换：`/workspace <名字|路径>`（`/sessions all` 看有哪些）');
  } else {
    const id = state.sessionId ? `（\`#${shortId(state.sessionId)}\`）` : '';
    lines.push(`这个聊天已经有会话${id}，工作区在建会话时写进会话，改不了。`);
    lines.push(NEW_HINT);
  }
  return lines.join('\n');
}

/** 切换结果渲染 */
function renderChange(outcome: ChangeWorkspaceOutcome): string {
  if (outcome.ok) {
    return [
      `✅ 工作区已切到 **${outcome.title}** · \`${outcome.path}\``,
      '',
      outcome.isNew
        ? '这个工作区还是新的，下一条消息会在这里建第一个会话。'
        : '下一条消息会在这里开新会话。',
    ].join('\n');
  }
  return describeChangeFailure(outcome);
}

/**
 * 失败文案（`/workspace` 与 `/new <工作区>` 共用，措辞保持一致）。
 *
 * `has-session` 只会出现在 `/workspace` 里：`/new` 先 `/new` 再改目录，那时会话
 * 已经不在盘上了。
 */
export function describeChangeFailure(outcome: ChangeWorkspaceOutcome): string {
  if (outcome.ok) return '';
  switch (outcome.reason) {
    case 'has-session': {
      const id = outcome.sessionId ? `（\`#${shortId(outcome.sessionId)}\`）` : '';
      return [`⚠️ 这个聊天已经有会话${id}，工作区在建会话时写进会话，改不了。`, NEW_HINT].join('\n');
    }
    case 'missing':
      return `⚠️ 目录不存在：\`${outcome.path}\`\n换一个存在的目录，或直接给绝对路径。`;
    case 'ambiguous':
      return [
        `⚠️ 有 ${outcome.matches.length} 个工作区匹配：${outcome.matches.join('、')}`,
        '用绝对路径指定：`/workspace D:\\项目\\目录`',
      ].join('\n');
    case 'not-found':
      return `⚠️ 没有叫 \`${outcome.arg}\` 的工作区。\`/sessions all\` 看有哪些，或直接给绝对路径。`;
    default:
      return '⚠️ 工作区切换失败。';
  }
}
