/**
 * 会话管理命令：/sessions（别名 /session）
 *
 * 子命令：
 *   /sessions                     列出未归档的会话（与 Web 侧栏同一来源）
 *   /sessions <页码>              同一列表的下一页（超过一页时才用）
 *   /sessions all                 按工作区分组列出全部会话
 *   /sessions archived [页码]     列出已归档的会话（每条都可点击取消归档）
 *   /sessions resume <序号|id>     把当前聊天切到指定会话，接上历史继续
 *   /sessions archive              列出可归档的会话，每条都可点击归档
 *   /sessions archive <目标[,目标…]>   归档会话（从列表与 Web 侧栏隐藏，日志保留）
 *   /sessions unarchive <目标[,目标…]> 取消归档，让它重新可用
 *
 * **句柄规则（唯一要记住的一条）**：每行都显示 8 位短 id，任何视图都能用它操作；
 * 序号只对应 `/sessions` 这一页的行号。`/sessions all` 按工作区分组、组内从 1
 * 编号，和命令解析的顺序对不上，所以那里**不显示序号**，只显示短 id。
 *
 * 「目标」是序号或 id 前缀（至少 4 位，8 位短 id 正好）；多个目标用英文逗号
 * 分隔，一次最多 10 个，逐个执行、逐个报告，单个失败不影响其它。
 *
 * 输出统一走 sendMarkdownChunked（与 /model、/preset 一致）：普通字符串回复
 * 不会按 markdown 渲染，`###` 和 `<qqbot-cmd-input>` 会原样显示成文本。
 * 列表里每条会话渲染成可点击命令，点一下就把对应子命令填进输入框。
 *
 * 归档走宿主 `workspaceRegistry.archiveSession`：只往 registry 的全局归档集里
 * 加一个 id，Web 侧栏与本命令都不再列出它，磁盘日志原样保留，随时可取消归档。
 *
 * 本插件**不提供物理删除**：宿主没有删除 API，按下层存储布局删目录既不可恢复，
 * 又容易撞上文件占用（Windows 上会话被 Web 端打开就删不掉）。归档是可逆的，
 * 足够满足「从列表里拿掉」的需求。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import type { ImQQBotConfig } from '../config.ts';
import { getScopePeer, formatRelativeTime, sendMarkdownChunked } from '../shared/index.ts';
import type { Logger } from '../types.ts';
import type { ArchiveSessionOutcome, WorkspaceGroup, WorkspaceSession } from '../session/index.ts';

/** 每页展示多少条（也是单次最多处理的目标数） */
const PAGE_SIZE = 10;

/** 标题渲染上限（日志标题可能很长） */
const TITLE_MAX = 28;

/** 一次最多处理多少个目标：够用，又不至于一条命令刷出几十行 */
const MAX_TARGETS = 10;

/**
 * 会话管理鉴权。
 *
 * 归档会让会话从所有人的列表里消失（Web 侧栏同样受影响），列表里还能看到别的
 * 聊天的会话标题，因此要求操作者在 `access.c2cAllow` 名单内；没配名单时一律拒绝
 * （fail-closed），哪怕 `c2cMode` 是 open——open 是「谁能和 bot 聊天」，不是
 * 「谁能改动别人的会话」。
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
  '🗂 **会话管理**',
  '`/sessions` 当前工作区 · `/sessions all` 全部 · `/sessions archived` 归档',
  '`/sessions resume <序号|id>` 切到某个会话，接上历史继续（工作区跟着切）',
  '`/sessions archive [序号|id,…]` 归档（可逆，一次最多 10 个）；不带目标时列出候选',
  '`/sessions unarchive <id>[,…]` 取消归档',
  'id 是列表里的 8 位；序号只对 `/sessions` 这一页有效',
].join('\n');

/** 目标解析结果 */
export type SessionTargetResult =
  | { ok: true; entry: WorkspaceSession }
  | { ok: false; error: string };

/**
 * 把用户输入解析成列表中的一条会话。
 *
 * 句柄有两种：
 * - 序号（1 起，与 `/sessions` 列表一致）；
 * - id：完整 id 或列表里那 8 位短 id，前面可以带 `#`。短 id 可能全是数字
 *   （uuid 前 8 位恰好都是数字的概率约 2%），所以「短数字当序号、4 位以上的
 *   数字当 id」——列表里的序号不可能长到 4 位。
 */
export function resolveSessionTarget(
  entries: readonly WorkspaceSession[],
  raw: string,
): SessionTargetResult {
  const arg = raw.trim().replace(/^#/, '');
  if (arg === '') return { ok: false, error: '缺少目标（序号或 id）' };

  if (/^\d+$/.test(arg)) {
    const index = Number(arg);
    if (index >= 1 && index <= entries.length) {
      const entry = entries[index - 1];
      if (entry) return { ok: true, entry };
    }
    // 短数字是越界的序号；4 位以上按 id 继续往下解析
    if (arg.length < 4) {
      return { ok: false, error: `序号 ${arg} 超出范围（当前共 ${entries.length} 个会话）` };
    }
  }

  if (arg.length < 4) return { ok: false, error: 'id 至少 4 位；列表里的 8 位短 id 可以直接用' };

  // 完整 id、带 session- 前缀的 id、列表里展示的短 id 都认
  const matches = entries.filter((entry) => entry.id === arg
    || entry.id.startsWith(arg)
    || shortId(entry.id).startsWith(arg)); // 短 id 与序号无关，必须比短形式
  if (matches.length === 0) return { ok: false, error: `没有匹配的会话: ${arg}` };
  if (matches.length > 1) return { ok: false, error: `id 前缀匹配到 ${matches.length} 个会话，请写长一点` };
  const entry = matches[0];
  return entry ? { ok: true, entry } : { ok: false, error: `没有匹配的会话: ${arg}` };
}

/**
 * 把 `1,3,9d2c4410` 这样的输入拆成多个目标 token。
 *
 * 英文逗号是约定写法；全角逗号一并接受（手机上更容易打出来）。空段忽略，
 * 允许逗号前后带空格。
 */
export function parseTargetTokens(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((token) => token.trim())
    .filter((token) => token !== '');
}

/** 批量解析结果：命中项按输入顺序去重，失败项保留原因 */
interface TargetBatch {
  picks: WorkspaceSession[];
  errors: string[];
}

/**
 * 逐个解析目标；某个 token 解析失败只记错误，不影响其它 token。
 *
 * 序号只在 `view`（`/sessions` 那一页的数据）里解析，id 前缀在 `all`（全量，
 * 含别的项目与已归档）里解析——这样列表上看到哪个短 id 都能直接操作。
 */
function resolveTargets(
  view: readonly WorkspaceSession[],
  all: readonly WorkspaceSession[],
  tokens: readonly string[],
): TargetBatch {
  const picks: WorkspaceSession[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const result = /^\d+$/.test(token)
      ? resolveSessionTarget(view, token)
      : resolveSessionTarget(all, token);
    if (!result.ok) {
      errors.push(result.error);
      continue;
    }
    // 序号和 id 可能指向同一个会话，去重后再执行，避免重复归档/恢复
    if (seen.has(result.entry.id)) continue;
    seen.add(result.entry.id);
    picks.push(result.entry);
  }

  return { picks, errors };
}

/** 拆 token 并做数量校验；返回字符串表示要直接回给用户 */
function parseTargetsOrError(
  raw: string,
  usage: string,
): { tokens: string[] } | { message: string } {
  const tokens = parseTargetTokens(raw);
  if (tokens.length === 0) return { message: `⚠️ 缺少目标。用法: \`${usage}\`` };
  if (tokens.length > MAX_TARGETS) {
    return { message: `⚠️ 一次最多处理 ${MAX_TARGETS} 个会话` };
  }
  return { tokens };
}

/** 展示用短 id：去掉统一的 `session-` 前缀，避免只显示出一个前缀 */
export function shortId(id: string): string {
  return id.replace(/^session-/, '').slice(0, 8);
}

/**
 * 展示用 id：短 id 前面加 `#`。
 *
 * 加 `#` 是为了和行首的序号一眼分开（`1. #3f2a9b1c · 标题`），同时它也能直接
 * 粘进命令里——解析时会去掉这个前缀。
 */
function displayId(id: string): string {
  return `#${shortId(id)}`;
}

/** 标题压缩成单行短文本（换行会打散列表，引号会破坏命令标签属性） */
function shortTitle(entry: WorkspaceSession): string {
  const raw = (entry.title ?? '').replace(/[\r\n]+/g, ' ').replace(/[`*_~<>"']/g, '').trim();
  if (raw === '') return '未命名会话';
  return raw.length > TITLE_MAX ? `${raw.slice(0, TITLE_MAX)}…` : raw;
}

/** 列表行里展示的附加状态 */
function statusTags(entry: WorkspaceSession): string[] {
  return entry.live && !entry.current ? ['使用中'] : [];
}

/** 一行会话的展示文本：`1. 9d2c4410 · 标题 · 3d 前 ✅`（✅ 只给当前会话） */
interface RowOptions {
  /** 行首带序号（只有 `/sessions` 的编号能被命令解析） */
  numbered?: boolean;
  /** 行尾带上所属工作区（归档页用） */
  withWorkspace?: boolean;
}

function renderRow(entry: WorkspaceSession, index: number, options: RowOptions = {}): string {
  const body: string[] = [];
  body.push(displayId(entry.id));
  body.push(shortTitle(entry));
  const time = formatRelativeTime(entry.createdAt);
  if (time !== '—') body.push(time);
  body.push(...statusTags(entry));
  if (options.withWorkspace && entry.workspace) body.push(entry.workspace);
  const head = options.numbered ? `${index}. ` : '';
  // 当前项标记放行尾，与 /model、/preset 的按钮标签一致
  const tail = entry.current ? ' ✅' : '';
  return `${head}${body.join(' · ')}${tail}`;
}

/**
 * 把一行渲染成可点击命令。
 *
 * 当前会话这一行也走同一个命令：`/sessions resume` 自身会识别「已是当前会话」
 * 并直接提示，链接层不需要为当前项换命令。仍用按钮渲染是因为 QQ 把
 * `<qqbot-cmd-input>` 渲染成带内边距的块，纯文本行是齐左的，混在一起会错位。
 */
function renderLine(entry: WorkspaceSession, label: string): string {
  return commandLink(`/sessions resume ${displayId(entry.id)}`, label);
}

/**
 * 可点击命令：QQ 会把它渲染成按钮，点一下就把 `command` 填进输入框。
 *
 * 只用于**真能执行**的命令；`show` 是纯文本标签（不能再带 markdown）。
 */
function commandLink(command: string, show: string): string {
  return `<qqbot-cmd-input text="${command}" show="${show}"/>`;
}

/** `/sessions` 列表底部的单行操作入口：每项都是可点击命令 */
function listFooter(archivedCount: number): string {
  const parts = [
    commandLink('/sessions archive', '归档'),
    commandLink('/sessions all', '查看全部'),
  ];
  if (archivedCount > 0) parts.push(commandLink('/sessions archived', `已归档 ${archivedCount}`));
  return parts.join(' · ');
}

/** 分页导航：只给存在的方向，标签固定「上一页 / 下一页」 */
function pageLinks(page: number, pages: number, command: (page: number) => string): string[] {
  const links: string[] = [];
  if (page > 1) links.push(commandLink(command(page - 1), '上一页'));
  if (page < pages) links.push(commandLink(command(page + 1), '下一页'));
  return links;
}

/** 当前工作区摘要（/sessions 顶部那行） */
interface WorkspaceSummary {
  title: string;
  path: string;
  missing: boolean;
}

export function sessionsCommand({ manager, config, logger }: CommandDeps): CategorizedCommand {
  return {
    name: ['sessions', 'session'],
    category: 'agent',
    // 会话里可能含其它 chat 的历史标题，归档会影响所有人的列表：只允许私聊 + 白名单
    scope: 'c2c',
    authorized: sessionAdminAuth(config, logger),
    description: '列出、恢复、归档会话',
    usage: USAGE,
    handler: async (cmdCtx) => {
      const raw = (cmdCtx.command?.raw ?? '').trim();
      const words = raw.split(/\s+/).filter(Boolean);
      let sub = words[0] ?? '';
      const rest = words.slice(1);
      const { scope, peerId } = getScopePeer(cmdCtx);

      // `/sessions 2` = 第二页；数字子命令不当成未知命令
      let page = 1;
      if (/^\d+$/.test(sub)) {
        page = Number(sub);
        sub = '';
      }

      const loadEntries = async (): Promise<WorkspaceSession[] | string> => {
        try {
          return await manager.listWorkspaceSessions(scope, peerId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger?.warn(`/sessions 列举会话失败: ${message}`);
          return `⚠️ 读取会话列表失败: ${message}`;
        }
      };

      const loadGroups = async (): Promise<WorkspaceGroup[] | string> => {
        try {
          return await manager.listWorkspaceGroups(scope, peerId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger?.warn(`/sessions all 列举工作区失败: ${message}`);
          return `⚠️ 读取工作区失败: ${message}`;
        }
      };

      /** 当前工作区信息：标题 + 路径 + 目录是否还在 */
      const loadWorkspaceInfo = async (): Promise<WorkspaceSummary | undefined> => {
        try {
          return await manager.currentWorkspaceInfo(scope, peerId);
        } catch (err) {
          logger?.debug?.(`/sessions 读取工作区信息失败: ${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        }
      };

      /** 全量会话（跨工作区、按 id 去重），用于 id 前缀解析与归档页 */
      const flattenGroups = (groups: readonly WorkspaceGroup[]): WorkspaceSession[] => {
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
      };

      const render = async (): Promise<string> => {
        switch (sub) {
          case '':
          case 'list': {
            const loaded = await loadEntries();
            if (typeof loaded === 'string') return loaded;
            const active = loaded.filter((entry) => !entry.archived);
            const workspace = await loadWorkspaceInfo();
            // 工作区空着时才知道「别的项目里还有没有会话」，为空才多查一次
            let elsewhere = 0;
            if (loaded.length === 0) {
              const groups = await loadGroups();
              if (typeof groups !== 'string') elsewhere = flattenGroups(groups).length;
            }
            return renderList(active, loaded.length - active.length, workspace, page, elsewhere);
          }

          case 'all':
          case 'groups':
          case 'workspaces': {
            const groups = await loadGroups();
            if (typeof groups === 'string') return groups;
            return renderGroups(groups);
          }

          case 'archived': {
            const groups = await loadGroups();
            if (typeof groups === 'string') return groups;
            const archived = flattenGroups(groups).filter((entry) => entry.archived);
            const pageArg = rest[0] !== undefined && /^\d+$/.test(rest[0]) ? Number(rest[0]) : 1;
            return renderArchived(archived, pageArg);
          }

          case 'resume':
          case 'r': {
            const arg = rest[0] ?? '';
            if (arg.trim() === '') return `⚠️ 缺少目标 · ${commandLink('/sessions', '选择会话')}`;

            const loaded = await loadEntries();
            if (typeof loaded === 'string') return loaded;
            const active = loaded.filter((entry) => !entry.archived);

            // 纯序号不需要跨工作区清单：省一次全量列举和一轮标题日志读取
            let target: SessionTargetResult;
            if (/^\d+$/.test(arg.trim())) {
              target = resolveSessionTarget(active, arg);
            } else {
              const groups = await loadGroups();
              if (typeof groups === 'string') return groups;
              target = resolveSessionTarget(flattenGroups(groups), arg);
            }
            if (!target.ok) return target.error;
            if (target.entry.current) return '✅ 已是当前会话';

            const outcome = await manager.switchSession(
              scope,
              peerId,
              target.entry.id,
              cmdCtx.message.senderId ?? peerId,
              { scope, targetId: peerId, msgId: cmdCtx.message.messageId },
            );
            if (outcome.ok) {
              return `✅ 已恢复会话「${shortTitle(target.entry)}」 · \`${displayId(target.entry.id)}\``;
            }
            switch (outcome.reason) {
              case 'not-found':
                return `⚠️ 磁盘上没有这个会话（可能已被删除） · ${commandLink('/sessions', '查看会话')}`;
              case 'in-use':
                return '⚠️ 该会话正在另一个聊天中使用，先在那边 /new';
              default:
                return `⚠️ 恢复失败: ${outcome.message ?? '未知错误（可能被 Web 端打开占用）'}`;
            }
          }

          case 'archive':
          case 'a': {
            const loaded = await loadEntries();
            if (typeof loaded === 'string') return loaded;
            const active = loaded.filter((entry) => !entry.archived);
            if (active.length === 0) {
              return loaded.length === 0
                ? '⚠️ 这个工作区还没有会话'
                : `⚠️ 没有未归档的会话 · ${commandLink('/sessions archived', '查看已归档')}`;
            }

            // 不带目标 = 页脚「归档」链接的落地页：给可点击候选，不猜要归档哪一个
            if (rest.length === 0) return renderArchivePicker(active);

            const parsed = parseTargetsOrError(rest.join(' '), '/sessions archive <序号|id>[,…]');
            if ('message' in parsed) return parsed.message;

            // 只有写 id 时才需要跨工作区全量清单（id 可能来自 /sessions all）
            let all: WorkspaceSession[] = [];
            if (parsed.tokens.some((token) => !/^\d+$/.test(token))) {
              const groups = await loadGroups();
              if (typeof groups === 'string') return groups;
              all = flattenGroups(groups);
            }

            const batch = resolveTargets(active, all, parsed.tokens);
            const skipped = batch.picks
              .filter((entry) => entry.archived)
              .map((entry) => `「${shortTitle(entry)}」本来就在归档里，跳过`);
            const picks = batch.picks.filter((entry) => !entry.archived);
            if (picks.length === 0) {
              return formatNoPicks(batch.errors, skipped, '没有可归档的会话。');
            }

            const results: ArchiveResult[] = [];
            for (const entry of picks) {
              results.push({ entry, outcome: await manager.archiveSession(entry.id) });
            }
            return renderArchiveResults('archive', results, skipped, batch.errors);
          }

          case 'unarchive':
          case 'u':
          case 'restore': {
            const groups = await loadGroups();
            if (typeof groups === 'string') return groups;
            const all = flattenGroups(groups);
            const archived = all.filter((entry) => entry.archived);
            if (archived.length === 0) {
              return `⚠️ 没有已归档的会话 · ${commandLink('/sessions archive', '归档会话')}`;
            }

            if (rest.length === 0) {
              return `⚠️ 缺少目标 · ${commandLink('/sessions archived', '查看已归档')}`;
            }

            const parsed = parseTargetsOrError(rest.join(' '), '/sessions unarchive <id>[,…]');
            if ('message' in parsed) return parsed.message;
            // 序号只对应 /sessions 那一页，在归档页上没有意义：直接说清楚，别猜
            if (parsed.tokens.some((token) => /^\d+$/.test(token))) {
              return `⚠️ 序号只对应 \`/sessions\` 列表；取消归档用 8 位 id · ${commandLink('/sessions archived', '查看已归档')}`;
            }

            const batch = resolveTargets(archived, all, parsed.tokens);
            const skipped = batch.picks
              .filter((entry) => !entry.archived)
              .map((entry) => `「${shortTitle(entry)}」没有归档，跳过`);
            const picks = batch.picks.filter((entry) => entry.archived);
            if (picks.length === 0) {
              return formatNoPicks(batch.errors, skipped, '没有可恢复的已归档会话。');
            }

            const results: ArchiveResult[] = [];
            for (const entry of picks) {
              results.push({ entry, outcome: await manager.unarchiveSession(entry.id) });
            }
            return renderArchiveResults('unarchive', results, skipped, batch.errors);
          }

          case 'help':
            return USAGE;

          default:
            return `⚠️ 未知子命令: ${sub} · ${commandLink('/sessions help', '查看用法')}`;
        }
      };

      // 统一走 markdown 通道：否则 `###` 与 <qqbot-cmd-input> 会成为字面文本
      await sendMarkdownChunked(cmdCtx, await render(), config.textChunkLimit);
      return { kind: 'noop' as const };
    },
  };
}

/**
 * 渲染未归档列表（`/sessions`，可分页）。
 *
 * 每行都带 8 位短 id：这是唯一能直接打字的句柄；序号只是这一页的行号，
 * 供 `archive` / `resume` 使用。当前会话也走 resume，命令会识别并直接提示。
 *
 * @param entries 未归档会话（已按创建时间倒序）
 * @param archivedCount 已归档数量，只用于底部提示
 * @param workspace 当前工作区（标题 / 路径 / 目录是否还在）
 * @param page 页码（1 起）
 * @param elsewhere 其它工作区里的会话数（本工作区为空时才有意义）
 */
function renderList(
  entries: readonly WorkspaceSession[],
  archivedCount: number,
  workspace: WorkspaceSummary | undefined,
  page: number,
  elsewhere: number,
): string {
  const workspaceLine = workspace
    ? [
      `**${workspace.title}** · \`${workspace.path}\`${workspace.missing ? ' ⚠️ 目录不存在' : ''}`,
      '',
    ]
    : [];

  const total = entries.length;
  if (total === 0) {
    const lines = ['### 🗂 会话（共 0 个）', '', ...workspaceLine];
    lines.push(archivedCount === 0
      ? '这个工作区还没有会话'
      : `这个工作区没有未归档的会话；已归档 ${archivedCount} 个: ${commandLink('/sessions archived', '查看归档')}`);
    if (elsewhere > 0) lines.push(`其它工作区里还有 ${elsewhere} 个会话: ${commandLink('/sessions all', '查看全部')}`);
    return lines.join('\n');
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page < 1 || page > pages) {
    return `⚠️ 第 ${page} 页没有内容（共 ${pages} 页） · ${commandLink('/sessions 1', '回到第 1 页')}`;
  }

  const start = (page - 1) * PAGE_SIZE;
  const shown = entries.slice(start, start + PAGE_SIZE);
  const lines: string[] = [
    `### 🗂 会话（共 ${total} 个，按创建时间倒序）${pages > 1 ? ` · 第 ${page}/${pages} 页` : ''}`,
    '',
    ...workspaceLine,
  ];

  shown.forEach((entry, offset) => {
    const index = start + offset + 1;
    lines.push(renderLine(entry, renderRow(entry, index, { numbered: true })));
  });

  const nav = pageLinks(page, pages, (next) => `/sessions ${next}`);
  if (nav.length > 0) lines.push('', nav.join(' · '));
  lines.push('', listFooter(archivedCount));
  return lines.join('\n');
}

/**
 * 渲染「选择要归档的会话」（`/sessions archive` 不带目标时的落地页）。
 *
 * 页脚里的「归档」只能填进不带目标的命令，所以这里再给一层可点击候选：
 * 点一条就把 `/sessions archive <id>` 填进输入框。只列最近 10 条，与
 * `/sessions` 第一页同序；更早的会话用 `/sessions all` 里的短 id 直接归档。
 */
function renderArchivePicker(entries: readonly WorkspaceSession[]): string {
  const shown = entries.slice(0, PAGE_SIZE);
  const lines: string[] = [`### 🗄 归档会话（共 ${entries.length} 个）`, ''];
  shown.forEach((entry, offset) => {
    const label = renderRow(entry, offset + 1, { numbered: true });
    lines.push(commandLink(`/sessions archive ${displayId(entry.id)}`, label));
  });
  const rest = entries.length - shown.length;
  if (rest > 0) {
    lines.push('', `还有 ${rest} 个更早的会话 · ${commandLink('/sessions all', '查看全部')}`);
  }
  return lines.join('\n');
}

/**
 * 渲染全部工作区的分组列表（`/sessions all`）。
 *
 * 组内序号从 1 开始、与命令的解析顺序无关，所以这里**不显示序号**，只显示
 * 8 位短 id：看到哪个都能直接 `/sessions resume <id>`。
 */
function renderGroups(groups: readonly WorkspaceGroup[]): string {
  const visible = groups.filter((group) => group.sessions.length > 0);
  if (visible.length === 0) {
    return [
      '### 🗂 全部工作区（0 个工作区）',
      '',
      '还没有任何工作区会话',
    ].join('\n');
  }

  const total = visible.reduce(
    (sum, group) => sum + group.sessions.filter((entry) => !entry.archived).length,
    0,
  );
  const lines: string[] = [`### 🗂 全部工作区（${visible.length} 个工作区 · 共 ${total} 个会话）`, ''];

  for (const group of visible) {
    const active = group.sessions.filter((entry) => !entry.archived);
    const archivedCount = group.sessions.length - active.length;
    lines.push(
      group.path === ''
        ? `**${group.title}**`
        : `**${group.title}** · \`${group.path}\`${group.missing ? ' ⚠️ 目录不存在' : ''}`,
      '',
    );

    if (active.length === 0) {
      lines.push(`${archivedCount} 个会话全部已归档 · ${commandLink('/sessions archived', '查看已归档')}`);
    } else {
      active.slice(0, PAGE_SIZE).forEach((entry) => {
        lines.push(renderLine(entry, renderRow(entry, 0)));
      });
      if (active.length > PAGE_SIZE) {
        lines.push(`还有 ${active.length - PAGE_SIZE} 个更早的会话未显示`);
      }
      if (archivedCount > 0) lines.push(`（另有 ${archivedCount} 个已归档）`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * 渲染已归档列表（可分页）。
 *
 * 这里不显示序号（序号只对 `/sessions` 有效），每行给 8 位短 id 和所属工作区。
 */
function renderArchived(entries: readonly WorkspaceSession[], page = 1): string {
  if (entries.length === 0) {
    return [
      '### 🗄 已归档（共 0 个）',
      '',
      '没有已归档的会话',
      '',
      commandLink('/sessions archive', '归档会话'),
    ].join('\n');
  }

  const total = entries.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page < 1 || page > pages) {
    return `⚠️ 第 ${page} 页没有内容（共 ${pages} 页） · ${commandLink('/sessions archived 1', '回到第 1 页')}`;
  }

  const start = (page - 1) * PAGE_SIZE;
  const shown = entries.slice(start, start + PAGE_SIZE);
  const lines: string[] = [
    `### 🗄 已归档（共 ${total} 个）${pages > 1 ? ` · 第 ${page}/${pages} 页` : ''}`,
    '',
  ];

  for (const entry of shown) {
    const label = renderRow(entry, 0, { withWorkspace: true });
    lines.push(commandLink(`/sessions unarchive ${displayId(entry.id)}`, label));
  }

  const nav = pageLinks(page, pages, (next) => `/sessions archived ${next}`);
  nav.push(commandLink('/sessions', '返回会话列表'));
  lines.push('', nav.join(' · '));
  return lines.join('\n');
}

/** 一条归档 / 取消归档的执行结果 */
interface ArchiveResult {
  entry: WorkspaceSession;
  outcome: ArchiveSessionOutcome;
}

/**
 * 没有可执行目标时的回包：错误项带 ⚠️，跳过项用 `· ` 单列。
 *
 * 第一行必须是图标开头——命令回复要和大模型正文一眼分开。
 */
function formatNoPicks(
  errors: readonly string[],
  skipped: readonly string[],
  fallback: string,
): string {
  const lines = [
    ...errors.map((error) => `⚠️ ${error}`),
    ...skipped.map((note) => `· ${note}`),
  ];
  return lines.length > 0 ? lines.join('\n') : `⚠️ ${fallback}`;
}

/**
 * 渲染归档 / 取消归档结果。
 *
 * 单目标时保留逐条详情；多目标时给一份清单（每行一个 ✅/⚠️），跳过项与解析
 * 失败项单列，避免一条命令几十行把聊天刷屏。
 */
function renderArchiveResults(
  verb: 'archive' | 'unarchive',
  results: readonly ArchiveResult[],
  skipped: readonly string[],
  errors: readonly string[],
): string {
  if (results.length === 1 && skipped.length === 0 && errors.length === 0) {
    const only = results[0]!;
    return verb === 'archive'
      ? renderArchive(only.entry, only.outcome)
      : renderUnarchive(only.entry, only.outcome);
  }

  const okCount = results.filter((item) => item.outcome.ok).length;
  const failCount = results.length - okCount;
  const head = verb === 'archive'
    ? `🗄 已归档 ${okCount} 个会话${failCount > 0 ? `，${failCount} 个失败` : ''}`
    : `♻️ 已取消归档 ${okCount} 个会话${failCount > 0 ? `，${failCount} 个失败` : ''}`;

  const lines: string[] = [head, ''];
  results.forEach(({ entry, outcome }, index) => {
    const label = `${index + 1}. ${shortTitle(entry)} \`${displayId(entry.id)}\``;
    lines.push(outcome.ok ? `✅ ${label}` : `⚠️ ${label}\n${archiveFailureText(entry, outcome, verb)}`);
  });
  for (const note of skipped) lines.push(`· ${note}`);
  for (const error of errors) lines.push(`⚠️ ${error}`);

  const remapped = results.reduce((sum, item) => sum + (item.outcome.remapped ?? 0), 0);
  if (remapped > 0) lines.push('', '当前聊天已切到新会话');
  lines.push('', verb === 'archive'
    ? commandLink('/sessions archived', '查看已归档')
    : commandLink('/sessions', '返回会话列表'));
  return lines.join('\n');
}

/** 渲染单条归档结果 */
function renderArchive(entry: WorkspaceSession, outcome: ArchiveSessionOutcome): string {
  if (!outcome.ok) return `⚠️ ${archiveFailureText(entry, outcome, 'archive')}`;

  const lines = [`🗄 已归档「${shortTitle(entry)}」 · \`${displayId(entry.id)}\``];
  if (outcome.alreadyArchived) lines.push('它本来就在归档里');
  if ((outcome.remapped ?? 0) > 0) lines.push('当前聊天已切到新会话');
  lines.push(commandLink(`/sessions unarchive ${displayId(entry.id)}`, '取消归档'));
  return lines.join('\n');
}

/** 渲染单条取消归档结果 */
function renderUnarchive(entry: WorkspaceSession, outcome: ArchiveSessionOutcome): string {
  if (!outcome.ok) return `⚠️ ${archiveFailureText(entry, outcome, 'unarchive')}`;

  return [
    `♻️ 已取消归档「${shortTitle(entry)}」 · \`${displayId(entry.id)}\``,
    commandLink(`/sessions resume ${displayId(entry.id)}`, '继续会话'),
  ].join('\n');
}

/** 归档 / 取消归档失败的原因文案（不含 ⚠️ 前缀，单条与批量共用） */
function archiveFailureText(
  entry: WorkspaceSession,
  outcome: ArchiveSessionOutcome,
  verb: 'archive' | 'unarchive',
): string {
  const action = verb === 'archive' ? '归档' : '取消归档';
  switch (outcome.reason) {
    case 'unavailable':
      return `${action}失败: ${outcome.message ?? '当前 profile 没装会话归档接口（web / desktop 自带）'}`;
    case 'not-found':
      return `${action}失败: 宿主找不到会话 \`${displayId(entry.id)}\`（可能已被删除）`;
    case 'busy':
      return `${action}失败: 该会话还有工作在运行，稍后再试`;
    default:
      return `${action}失败: ${outcome.message ?? '未知错误'}`;
  }
}
