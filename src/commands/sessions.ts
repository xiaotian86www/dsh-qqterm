/**
 * 会话管理命令：/sessions（别名 /session）
 *
 * 子命令：
 *   /sessions                     列出 QQ 已持有的会话（跨工作区，带状态 / 当前项）
 *   /sessions <页码>              持有列表的下一页（超过一页时才用）
 *   /sessions all                 按工作区分组列出全部会话（只标 📌，不标当前）
 *   /sessions archived [页码]     列出已归档的会话（每条都可点击取消归档）
 *   /sessions resume <序号|id>     把当前聊天切到指定会话，接上历史继续
 *   /sessions archive              列出可归档的会话，每条都可点击归档
 *   /sessions archive <目标[,目标…]>   归档会话（从列表与 Web 侧栏隐藏，日志保留）
 *   /sessions unarchive <目标[,目标…]> 取消归档，让它重新可用
 *
 * **句柄规则（唯一要记住的一条）**：每行都显示 8 位短 id，任何视图都能用它操作；
 * 序号只对应 `/sessions` 的持有列表。`all` / `archived` / 归档候选都不编号，
 * 只用短 id。
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
import { getScopePeer, formatRelativeTime, sendMarkdownChunked, shortSessionId } from '../shared/index.ts';
import type { Logger } from '../types.ts';
import type { ArchiveSessionOutcome, WorkspaceGroup, WorkspaceSession } from '../session/index.ts';

/** 每页展示多少条（也是单次最多处理的目标数） */
const PAGE_SIZE = 10;

/** 标题渲染上限（日志标题可能很长） */
const TITLE_MAX = 28;

/** 一次最多处理多少个目标：够用，又不至于一条命令刷出几十行 */
const MAX_TARGETS = 10;

/** 行内展示文本的净化：换行会打散列表，markdown / 属性字符会破坏渲染 */
function cleanInline(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/[`*_~<>"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 超长文本截断（标题、用户输入的错误回显共用） */
function clip(raw: string, max = TITLE_MAX): string {
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/** 用户输入只用于展示：净化 + 截断，空值给 — */
function safeArg(raw: string): string {
  const cleaned = cleanInline(raw);
  return cleaned === '' ? '—' : clip(cleaned);
}

/** XML 属性值转义（`&` 在 QQ 的指令标签里必须先转义） */
function attrValue(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

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
      ? '⚠️ 会话管理需要先配置白名单\n用 /bot-me 查 OpenID，加入 access.c2cAllow'
      : '⚠️ 会话管理仅限白名单用户\n用 /bot-me 查 OpenID，加入 access.c2cAllow';
  };
}

const USAGE = [
  '### 🗂 会话管理',
  '',
  '`/sessions` 持有会话 · `/sessions <页码>` 翻页',
  '`/sessions all [页码]` 全部工作区 · `/sessions archived [页码]` 已归档',
  '`/sessions resume <序号|id>` 切到某个会话，接上历史（工作区跟着切）',
  '`/sessions rename <序号|id> <新标题>` 改会话名（标题固定，目标须已打开）',
  '`/sessions archive [序号|id,…]` 归档，可逆，一次最多 10 个',
  '`/sessions archive` 列出候选（`page <页码>` 翻页）',
  '`/sessions unarchive <id>[,…]` 取消归档',
  '',
  '序号只对 `/sessions` 的持有列表有效，其它视图用 8 位短 id',
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
  const printable = safeArg(raw.trim());
  if (arg === '') return { ok: false, error: '缺少目标（序号或 id）' };

  if (/^\d+$/.test(arg)) {
    const index = Number(arg);
    if (index >= 1 && index <= entries.length) {
      const entry = entries[index - 1];
      if (entry) return { ok: true, entry };
    }
    // 短数字是越界的序号；4 位以上按 id 继续往下解析
    if (arg.length < 4) {
      return { ok: false, error: `序号 ${printable} 超出范围（当前共 ${entries.length} 个会话）` };
    }
  }

  if (arg.length < 4) return { ok: false, error: 'id 至少 4 位，列表里的 8 位短 id 直接可用' };

  // 完整 id、带 session- 前缀的 id、列表里展示的短 id 都认
  const matches = entries.filter((entry) => entry.id === arg
    || entry.id.startsWith(arg)
    || shortId(entry.id).startsWith(arg)); // 短 id 与序号无关，必须比短形式
  if (matches.length === 0) return { ok: false, error: `没有匹配的会话: ${printable}` };
  if (matches.length > 1) return { ok: false, error: `id 前缀匹配到 ${matches.length} 个会话，多写几位再试` };
  const entry = matches[0];
  return entry ? { ok: true, entry } : { ok: false, error: `没有匹配的会话: ${printable}` };
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
 * 序号只在 `view`（`/sessions` 的持有列表）里解析，id 前缀在 `all`（全量，
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
  if (tokens.length === 0) return { message: `⚠️ 缺少目标 · 用法: \`${usage}\`` };
  if (tokens.length > MAX_TARGETS) {
    return { message: `⚠️ 一次最多处理 ${MAX_TARGETS} 个会话，分两次执行` };
  }
  return { tokens };
}

/** 展示用短 id：去掉统一的 `session-` 前缀，避免只显示出一个前缀 */
export function shortId(id: string): string {
  return shortSessionId(id);
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
  const raw = cleanInline(entry.title ?? '');
  if (raw === '') return '未命名会话';
  return clip(raw);
}

/**
 * 工作区标题行。
 *
 * 目录不存在时单独一行：状态图标只能放行首，不能跟在路径后面。
 */
function workspaceHeader(
  title: string,
  path: string,
  missing: boolean,
): string[] {
  const name = clip(cleanInline(title)) || '未命名工作区';
  const lines = [path === '' ? `**${name}**` : `**${name}** · \`${path}\``];
  if (missing) lines.push('⚠️ 目录不存在');
  return lines;
}

/**
 * 持有列表里的会话状态。
 *
 * 其它视图不展示状态，只标 `📌`；状态词只出现在 `/sessions` 默认视图。
 */
function statusOf(entry: WorkspaceSession): string {
  if (entry.held) return entry.running ? '生成中' : '空闲';
  return '待恢复';
}

/** 一行会话的展示文本：`1. #9d2c4410 · 标题 · 生成中 · 3d 前 ✅` */
interface RowOptions {
  /** 行首带序号（只有 `/sessions` 持有列表的编号能被命令解析） */
  numbered?: boolean;
  /** 行尾带上所属工作区（归档页 / 跨工作区持有列表用） */
  withWorkspace?: boolean;
  /** 展示生成状态（只在持有列表里开） */
  showStatus?: boolean;
  /** 给持有会话加 `📌` 标记（工作区 / 全部 / 归档候选） */
  showHeld?: boolean;
  /** 展示当前项 `✅`（只在持有列表里开） */
  showCurrent?: boolean;
}

function renderRow(entry: WorkspaceSession, index: number, options: RowOptions = {}): string {
  const body: string[] = [];
  body.push(displayId(entry.id));
  body.push(shortTitle(entry));
  if (options.showStatus) body.push(statusOf(entry));
  const time = formatRelativeTime(entry.createdAt);
  if (time !== '—') body.push(time);
  const workspace = clip(cleanInline(entry.workspace ?? ''));
  if (options.withWorkspace && workspace !== '') body.push(workspace);
  // 持有标记固定放行尾；工作区后缀先写，避免 📌 被挤到中间
  if (options.showHeld && entry.held) body.push('📌');
  const head = options.numbered ? `${index}. ` : '';
  // 当前项标记放行尾，与 /model、/preset 的按钮标签一致
  const tail = options.showCurrent && entry.current ? ' ✅' : '';
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
  const label = cleanInline(show) || command;
  return `<qqbot-cmd-input text="${attrValue(command)}" show="${attrValue(label)}"/>`;
}

/**
 * 持有列表底部：归档 / 全部视图；当前指针不在列表里时补一个恢复入口，
 * 避免「待恢复」只提示不给动作。
 */
function heldFooter(recoverId?: string): string {
  const parts = [
    commandLink('/sessions archive', '归档'),
    commandLink('/sessions all', '查看全部'),
  ];
  if (recoverId !== undefined) {
    parts.push(commandLink(`/sessions resume ${displayId(recoverId)}`, '恢复当前'));
  }
  return parts.join(' · ');
}

/** 分页导航：多页时给出 上一页 · 第 x/y 页 · 下一页，缺哪边省略哪边 */
function pageLinks(
  page: number,
  pages: number,
  command: (page: number) => string,
): string[] {
  if (pages <= 1) return [];
  const links: string[] = [];
  if (page > 1) links.push(commandLink(command(page - 1), '上一页'));
  links.push(`第 ${page}/${pages} 页`);
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
    description: '列出持有会话、恢复、改名、归档',
    usage: USAGE,
    handler: async (cmdCtx) => {
      const raw = (cmdCtx.command?.raw ?? '').trim();
      const words = raw.split(/\s+/).filter(Boolean);
      let sub = words[0] ?? '';
      const rest = words.slice(1);
      const { scope, peerId } = getScopePeer(cmdCtx);

      // `/sessions 2` = 持有列表第二页；`all 2` / `archived 2` 同理
      let page = 1;
      if (/^\d+$/.test(sub)) {
        page = Number(sub);
        sub = '';
      } else if (
        (sub === 'archived' || sub === 'all' || sub === 'groups'
          || sub === 'workspaces' || sub === 'list')
        && rest[0] !== undefined && /^\d+$/.test(rest[0])
      ) {
        page = Number(rest[0]);
        rest.shift();
      }

      const loadHeld = async (): Promise<WorkspaceSession[] | string> => {
        try {
          // 按工作区分组后再编号：列表顺序与数字目标必须一致
          return groupHeldOrder(await manager.listHeldSessions(scope, peerId));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger?.warn(`/sessions 列举持有会话失败: ${message}`);
          return `⚠️ 读取持有会话失败: ${message}`;
        }
      };

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

      /**
       * 解析单个目标：纯序号只对应持有列表；id 先查持有集合，再查全量清单。
       * 返回字符串表示已经是要直接回给用户的错误。
       */
      const resolveOne = async (arg: string): Promise<SessionTargetResult | string> => {
        if (/^\d+$/.test(arg)) {
          const held = await loadHeld();
          if (typeof held === 'string') return held;
          return resolveSessionTarget(held, arg);
        }

        const held = await loadHeld();
        const fromHeld = typeof held === 'string' ? undefined : resolveSessionTarget(held, arg);
        if (fromHeld?.ok) return fromHeld;

        const groups = await loadGroups();
        if (typeof groups === 'string') return groups;
        return resolveSessionTarget(flattenGroups(groups), arg);
      };

      const render = async (): Promise<string> => {
        switch (sub) {
          case '':
          case 'list': {
            const loaded = await loadHeld();
            if (typeof loaded === 'string') return loaded;
            const workspace = await loadWorkspaceInfo();
            return renderHeldList(loaded, workspace, manager.currentSessionId(), page);
          }

          case 'workspace':
          case 'ws':
            return `⚠️ \`/sessions workspace\` 已移除 · 用 ${commandLink('/sessions all', '查看全部工作区')} 找会话`;

          case 'all':
          case 'groups':
          case 'workspaces': {
            const groups = await loadGroups();
            if (typeof groups === 'string') return groups;
            return renderGroups(groups, page);
          }

          case 'archived': {
            const groups = await loadGroups();
            if (typeof groups === 'string') return groups;
            const archived = flattenGroups(groups).filter((entry) => entry.archived);
            return renderArchived(archived, page);
          }

          case 'resume':
          case 'r': {
            const arg = rest[0] ?? '';
            if (arg.trim() === '') return `⚠️ 缺少目标 · ${commandLink('/sessions', '选择会话')}`;

            const target = await resolveOne(arg);
            if (typeof target === 'string') return target;
            if (!target.ok) {
              return `⚠️ ${target.error} · ${commandLink('/sessions', '查看会话')}`;
            }
            if (target.entry.current) return '✅ 已是当前会话';

            const outcome = await manager.switchSession(
              scope,
              peerId,
              target.entry.id,
              cmdCtx.message.senderId ?? peerId,
              { scope, targetId: peerId, msgId: cmdCtx.message.messageId },
            );
            if (outcome.ok) {
              const unarchived = outcome.unarchived ? '（已取消归档）' : '';
              return `✅ 已恢复会话「${shortTitle(target.entry)}」 · \`${displayId(target.entry.id)}\`${unarchived}`;
            }
            switch (outcome.reason) {
              case 'not-found':
                return `⚠️ 这个会话已不存在（可能被删除） · ${commandLink('/sessions', '查看会话')}`;
              case 'locked':
                return '⚠️ 这个会话正在别的客户端运行，先在那里关闭再恢复';
              default:
                return `⚠️ 恢复失败: ${outcome.message ?? '未知错误'} · ${commandLink('/sessions', '查看会话')}`;
            }
          }

          case 'rename':
          case 'rn': {
            const arg = rest[0] ?? '';
            const title = rest.slice(1).join(' ').trim();
            if (arg.trim() === '') {
              return `⚠️ 缺少目标 · 用法: \`/sessions rename <序号|id> <新标题>\``;
            }
            if (title === '') {
              return `⚠️ 缺少新标题 · 用法: \`/sessions rename <序号|id> <新标题>\``;
            }

            const target = await resolveOne(arg);
            if (typeof target === 'string') return target;
            if (!target.ok) {
              return `⚠️ ${target.error} · ${commandLink('/sessions', '查看会话')}`;
            }

            const outcome = manager.renameSession(target.entry.id, title);
            if (outcome.ok) {
              return `✅ 会话名已改为「${clip(cleanInline(outcome.title))}」 · \`${displayId(target.entry.id)}\``;
            }
            switch (outcome.reason) {
              case 'no-session':
                return `⚠️ 这个会话还没打开 · ${commandLink(`/sessions resume ${displayId(target.entry.id)}`, '先恢复')}`;
              case 'invalid':
                return '⚠️ 新标题不能为空';
              case 'not-live':
                return `⚠️ 这个会话已关闭 · ${commandLink(`/sessions resume ${displayId(target.entry.id)}`, '先恢复')}`;
              default:
                return `❌ 改名失败: ${outcome.message ?? '未知错误'}`;
            }
          }

          case 'archive':
          case 'a': {
            // 候选页用 `page <页码>`，避免和 `archive <序号|id>` 的数字目标撞车
            let pickerPage = 1;
            if (rest[0] === 'page') {
              const rawPage = rest[1];
              if (rawPage === undefined || !/^\d+$/.test(rawPage)) {
                return `⚠️ 页码必须是数字 · ${commandLink('/sessions archive', '查看候选')}`;
              }
              pickerPage = Number(rawPage);
              rest.splice(0, 2);
              if (rest.length > 0) {
                return `⚠️ 页码后面不要再跟目标 · ${commandLink('/sessions archive', '查看候选')}`;
              }
            }
            const loaded = await loadEntries();
            if (typeof loaded === 'string') return loaded;
            const active = loaded.filter((entry) => !entry.archived);

            // 不带目标 = 页脚「归档」链接的落地页：当前工作区优先，再补其它工作区的持有会话
            if (rest.length === 0) {
              const loadedHeld = await loadHeld();
              if (typeof loadedHeld === 'string') return loadedHeld;
              const workspace = await loadWorkspaceInfo();
              const local = [...active];
              const localIds = new Set(local.map((entry) => entry.id));
              // 宿主列表暂时没返回的本工作区持有会话也补进来
              for (const entry of loadedHeld) {
                if (workspace !== undefined && entry.workspace === workspace.title
                  && !localIds.has(entry.id)) {
                  local.push(entry);
                  localIds.add(entry.id);
                }
              }
              const candidates = [...local, ...loadedHeld.filter((entry) => !localIds.has(entry.id))];
              if (candidates.length === 0) {
                return loaded.length === 0
                  ? '⚠️ 这个工作区还没有会话'
                  : `⚠️ 没有未归档的会话 · ${commandLink('/sessions archived', '查看已归档')}`;
              }
              return renderArchivePicker(candidates, workspace, pickerPage);
            }

            const parsed = parseTargetsOrError(rest.join(' '), '/sessions archive <序号|id>[,…]');
            if ('message' in parsed) return parsed.message;

            // 序号只对应持有列表；id 需要跨工作区全量清单（可能来自 /sessions all）
            let all: WorkspaceSession[] = [];
            if (parsed.tokens.some((token) => !/^\d+$/.test(token))) {
              const groups = await loadGroups();
              if (typeof groups === 'string') return groups;
              all = flattenGroups(groups);
              // 宿主列表暂时没返回的持有会话也要能用 id 归档
              const loadedHeld = await loadHeld();
              if (typeof loadedHeld !== 'string') {
                const heldIds = new Set(loadedHeld.map((entry) => entry.id));
                all = [...loadedHeld, ...all.filter((entry) => !heldIds.has(entry.id))];
              }
            }
            let held: WorkspaceSession[] = [];
            if (parsed.tokens.some((token) => /^\d+$/.test(token))) {
              const loadedHeld = await loadHeld();
              if (typeof loadedHeld === 'string') return loadedHeld;
              held = loadedHeld;
            }

            const batch = resolveTargets(held, all, parsed.tokens);
            const skipped = batch.picks
              .filter((entry) => entry.archived)
              .map((entry) => `「${shortTitle(entry)}」本来就在归档里，跳过`);
            const picks = batch.picks.filter((entry) => !entry.archived);
            if (picks.length === 0) {
              return formatNoPicks(
                batch.errors,
                skipped,
                '没有可归档的会话',
                commandLink('/sessions', '查看会话'),
              );
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
            // 序号只对应 /sessions 的持有列表，在归档页上没有意义：直接说清楚，别猜
            if (parsed.tokens.some((token) => /^\d+$/.test(token))) {
              return [
                '⚠️ 序号只对应 `/sessions` 的持有列表',
                `取消归档用 8 位短 id · ${commandLink('/sessions archived', '查看已归档')}`,
              ].join('\n');
            }

            const batch = resolveTargets(archived, all, parsed.tokens);
            const skipped = batch.picks
              .filter((entry) => !entry.archived)
              .map((entry) => `「${shortTitle(entry)}」没有归档，跳过`);
            const picks = batch.picks.filter((entry) => entry.archived);
            if (picks.length === 0) {
              return formatNoPicks(
                batch.errors,
                skipped,
                '没有可恢复的已归档会话',
                commandLink('/sessions archived', '查看已归档'),
              );
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
            return `⚠️ 未知子命令: ${safeArg(sub)} · ${commandLink('/sessions help', '查看用法')}`;
        }
      };

      // 统一走 markdown 通道：否则 `###` 与 <qqbot-cmd-input> 会成为字面文本
      await sendMarkdownChunked(cmdCtx, await render(), config.textChunkLimit);
      return { kind: 'noop' as const };
    },
  };
}

/**
 * 持有列表里的一个工作区分组。
 *
 * `rows` 里的 `index` 是这条会话在整份持有列表里的序号（1 起），不是组内序号；
 * 分组只改变展示位置，不改命令的解析顺序。
 */
interface HeldGroup {
  title: string;
  path: string;
  missing: boolean;
  rows: Array<{ entry: WorkspaceSession; index: number }>;
}

/** 分组键：优先路径（同名工作区不合并），没有路径才退回标题 */
function workspaceKey(entry: WorkspaceSession): string {
  const path = (entry.workspacePath ?? '').trim().toLowerCase();
  if (path !== '') return `path:${path}`;
  const title = (entry.workspace ?? '').trim();
  return title === '' ? 'ungrouped' : `title:${title.toLowerCase()}`;
}

/**
 * 按工作区把一段持有会话聚成组，保持组第一次出现的顺序。
 *
 * 组内行沿用传入顺序；序号从 `start` 继续，分页后仍与整份列表对齐。
 */
function groupHeldEntries(
  entries: readonly WorkspaceSession[],
  start: number,
): HeldGroup[] {
  const groups: HeldGroup[] = [];
  const byKey = new Map<string, HeldGroup>();
  entries.forEach((entry, offset) => {
    const key = workspaceKey(entry);
    let group = byKey.get(key);
    if (group === undefined) {
      const title = cleanInline(entry.workspace ?? '');
      group = {
        title: title === '' ? '未分组' : title,
        path: cleanInline(entry.workspacePath ?? ''),
        missing: entry.workspaceMissing === true,
        rows: [],
      };
      byKey.set(key, group);
      groups.push(group);
    } else if (entry.workspaceMissing === true) {
      group.missing = true;
    }
    group.rows.push({ entry, index: start + offset + 1 });
  });
  return groups;
}

/**
 * 持有列表的展示顺序：按工作区分组，组内保持「当前 → 获取时间倒序」。
 *
 * 序号与数字目标都按这个顺序解析，`/sessions resume 2` 必须和第 2 行一致。
 */
function groupHeldOrder(entries: readonly WorkspaceSession[]): WorkspaceSession[] {
  return groupHeldEntries(entries, 0).flatMap((group) => group.rows.map((row) => row.entry));
}

/**
 * 渲染持有列表（`/sessions`，可分页）。
 *
 * 这里才是「QQ 正在使用哪些会话」：按工作区分组（组标题与 `/sessions all`
 * 同一套写法），组内展示生成状态与当前项，序号跨组、跨页连续。
 * 序号只在这个视图里有效，`resume` / `archive` 的数字目标也按这份列表解析。
 *
 * @param entries 已持有会话（已按工作区分组，当前优先，再按获取时间倒序）
 * @param workspace 当前工作区（只在空列表时展示）
 * @param currentId 当前指针；不在持有列表里时单独补一行
 * @param page 页码（1 起）
 */
function renderHeldList(
  entries: readonly WorkspaceSession[],
  workspace: WorkspaceSummary | undefined,
  currentId: string | undefined,
  page: number,
): string {
  const total = entries.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page < 1 || page > pages) {
    return `⚠️ 第 ${page} 页没有内容（共 ${pages} 页） · ${commandLink('/sessions 1', '回到第 1 页')}`;
  }

  const start = (page - 1) * PAGE_SIZE;
  const shown = total === 0 ? [] : entries.slice(start, start + PAGE_SIZE);
  const currentEntry = entries.find((entry) => entry.current);
  const currentLineId = currentId !== undefined && !shown.some((entry) => entry.current)
    ? currentId
    : undefined;
  // 只有当前指针不在持有集合里才需要「恢复」；只是翻到别的页不用
  const missingCurrentId = currentLineId !== undefined && currentEntry === undefined
    ? currentLineId
    : undefined;
  const fields: string[] = [];
  // 当前项不在这一页时单独补一行：翻到第 2 页也能看到当前是哪个
  if (currentLineId !== undefined) {
    const status = currentEntry === undefined ? '待恢复' : statusOf(currentEntry);
    fields.push(`**当前**: ${displayId(currentLineId)} · ${status}`);
  }
  // 空列表没有分组可看，补一行当前工作区，说明下一条消息会落在哪
  if (total === 0 && workspace !== undefined) {
    if (fields.length > 0) fields.push('');
    fields.push(...workspaceHeader(workspace.title, workspace.path, workspace.missing));
  }

  const lines: string[] = [
    `### 🗂 持有会话（${total} 个）`,
    '',
    ...fields,
    ...(fields.length > 0 ? [''] : []),
  ];

  if (total === 0) {
    lines.push('还没有持有会话');
    lines.push('', heldFooter(missingCurrentId));
    return lines.join('\n');
  }

  groupHeldEntries(shown, start).forEach((group, groupIndex) => {
    if (groupIndex > 0) lines.push('');
    lines.push(...workspaceHeader(group.title, group.path, group.missing), '');
    for (const row of group.rows) {
      lines.push(renderLine(row.entry, renderRow(row.entry, row.index, {
        numbered: true,
        showStatus: true,
        showCurrent: true,
      })));
    }
  });

  const nav = pageLinks(page, pages, (next) => `/sessions ${next}`);
  if (nav.length > 0) lines.push('', nav.join(' · '));
  lines.push('', heldFooter(missingCurrentId));
  return lines.join('\n');
}

/**
 * 渲染「选择要归档的会话」（`/sessions archive` 不带目标时的落地页）。
 *
 * 页脚里的「归档」只能填进不带目标的命令，所以这里再给一层可点击候选：
 * 点一条就把 `/sessions archive <id>` 填进输入框。先列当前工作区里的会话，
 * 再补其它工作区的持有会话；最多 10 条，不编号（序号属于持有列表）。
 *
 * 候选可能来自别的项目，行尾补工作区标题，避免同名会话分不清。
 * 超过一页时用 `archive page <页码>` 翻页，下一页仍是同一份候选清单。
 */
function renderArchivePicker(
  entries: readonly WorkspaceSession[],
  workspace: WorkspaceSummary | undefined,
  page = 1,
): string {
  const total = entries.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page < 1 || page > pages) {
    return `⚠️ 第 ${page} 页没有内容（共 ${pages} 页） · ${commandLink('/sessions archive page 1', '回到第 1 页')}`;
  }

  const start = (page - 1) * PAGE_SIZE;
  const shown = entries.slice(start, start + PAGE_SIZE);
  const lines: string[] = [
    `### 🗄 归档候选（${total} 个）`,
    '',
  ];
  shown.forEach((entry) => {
    const withWorkspace = workspace === undefined
      || (entry.workspace !== undefined && entry.workspace !== workspace.title);
    const label = renderRow(entry, 0, { showHeld: true, withWorkspace });
    lines.push(commandLink(`/sessions archive ${displayId(entry.id)}`, label));
  });
  const nav = pageLinks(page, pages, (next) => `/sessions archive page ${next}`);
  if (nav.length > 0) lines.push('', nav.join(' · '));
  lines.push('', commandLink('/sessions', '返回持有列表'));
  return lines.join('\n');
}

/**
 * 渲染全部工作区的分组列表（`/sessions all`，按会话分页）。
 *
 * 组内序号与命令的解析顺序对不上，所以这里**不显示序号**，只显示 8 位短 id；
 * 持有会话加 `📌` 标记，但不标当前项（当前只在 `/sessions` 里标）。
 *
 * 一页 10 条会话，跨工作区连续编号；翻页后仍会重复当前页首条所属工作区的
 * 标题。会话全部归档的工作区放在最后一页，避免每页重复。
 *
 * @param groups 宿主工作区分组
 * @param page 页码（1 起）
 */
function renderGroups(groups: readonly WorkspaceGroup[], page = 1): string {
  const visible = groups.filter((group) => group.sessions.length > 0);
  if (visible.length === 0) {
    return [
      '### 🗂 全部工作区（0 个工作区）',
      '',
      '还没有任何工作区会话',
      '',
      commandLink('/sessions', '返回持有列表'),
    ].join('\n');
  }

  const rows: { group: WorkspaceGroup; entry: WorkspaceSession }[] = [];
  for (const group of visible) {
    for (const entry of group.sessions) {
      if (!entry.archived) rows.push({ group, entry });
    }
  }

  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page < 1 || page > pages) {
    return `⚠️ 第 ${page} 页没有内容（共 ${pages} 页） · ${commandLink('/sessions all 1', '回到第 1 页')}`;
  }

  const start = (page - 1) * PAGE_SIZE;
  const shown = rows.slice(start, start + PAGE_SIZE);
  const lines: string[] = [
    `### 🗂 全部工作区（${visible.length} 个工作区 · ${total} 个未归档会话）`,
    '',
  ];

  let lastGroupId: string | undefined;
  for (const { group, entry } of shown) {
    if (group.id !== lastGroupId) {
      if (lastGroupId !== undefined) lines.push('');
      lines.push(...workspaceHeader(group.title, group.path, group.missing), '');
      lastGroupId = group.id;
    }
    lines.push(renderLine(entry, renderRow(entry, 0, { showHeld: true })));
  }

  const allArchived = visible.filter(
    (group) => !group.sessions.some((entry) => !entry.archived),
  );
  if (page === pages && allArchived.length > 0) {
    if (shown.length > 0) lines.push('');
    allArchived.forEach((group, index) => {
      if (index > 0) lines.push('');
      lines.push(...workspaceHeader(group.title, group.path, group.missing), '');
      lines.push(`${group.sessions.length} 个会话全部已归档`);
    });
  }

  const archivedTotal = visible.reduce(
    (sum, group) => sum + group.sessions.filter((entry) => entry.archived).length,
    0,
  );
  const nav = pageLinks(page, pages, (next) => `/sessions all ${next}`);
  if (nav.length > 0) lines.push('', nav.join(' · '));

  const footer = [commandLink('/sessions', '返回持有列表')];
  if (archivedTotal > 0) footer.push(commandLink('/sessions archived', '查看已归档'));
  lines.push('', footer.join(' · '));
  return lines.join('\n').trimEnd();
}

/**
 * 渲染已归档列表（可分页）。
 *
 * 这里不显示序号（序号只对 `/sessions` 的持有列表有效），每行给 8 位短 id 和所属工作区。
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
    `### 🗄 已归档（共 ${total} 个）`,
    '',
  ];

  for (const entry of shown) {
    const label = renderRow(entry, 0, { withWorkspace: true });
    lines.push(commandLink(`/sessions unarchive ${displayId(entry.id)}`, label));
  }

  const nav = pageLinks(page, pages, (next) => `/sessions archived ${next}`);
  if (nav.length > 0) lines.push('', nav.join(' · '));
  lines.push('', commandLink('/sessions', '返回持有列表'));
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
 * 第一行必须是图标开头——命令回复要和大模型正文一眼分开；只有跳过项时
 * 先补一行汇总，避免整条消息以 `· ` 开头。
 */
function formatNoPicks(
  errors: readonly string[],
  skipped: readonly string[],
  fallback: string,
  next?: string,
): string {
  const lines = [
    ...errors.map((error) => `⚠️ ${error}`),
    ...skipped.map((note) => `· ${note}`),
  ];
  if (errors.length === 0) lines.unshift(`⚠️ ${fallback}`);
  if (next !== undefined) lines.push(next);
  return lines.join('\n');
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
  const action = verb === 'archive' ? '归档' : '取消归档';
  const head = okCount === 0
    ? `⚠️ ${failCount} 个会话${action}失败`
    : verb === 'archive'
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
  // 全部失败时回到操作前的列表；有成功项才去目标列表
  const allFailed = okCount === 0;
  const footer = verb === 'archive'
    ? (allFailed ? commandLink('/sessions', '返回持有列表') : commandLink('/sessions archived', '查看已归档'))
    : (allFailed ? commandLink('/sessions archived', '查看已归档') : commandLink('/sessions', '返回持有列表'));
  lines.push('', footer);
  return lines.join('\n');
}

/** 渲染单条归档结果 */
function renderArchive(entry: WorkspaceSession, outcome: ArchiveSessionOutcome): string {
  if (!outcome.ok) {
    return `⚠️ ${archiveFailureText(entry, outcome, 'archive')} · ${commandLink('/sessions', '查看会话')}`;
  }

  const lines = [`🗄 已归档「${shortTitle(entry)}」 · \`${displayId(entry.id)}\``];
  if (outcome.alreadyArchived) lines.push('它本来就在归档里');
  if ((outcome.remapped ?? 0) > 0) lines.push('当前聊天已切到新会话');
  lines.push(commandLink(`/sessions unarchive ${displayId(entry.id)}`, '取消归档'));
  return lines.join('\n');
}

/** 渲染单条取消归档结果 */
function renderUnarchive(entry: WorkspaceSession, outcome: ArchiveSessionOutcome): string {
  if (!outcome.ok) {
    return `⚠️ ${archiveFailureText(entry, outcome, 'unarchive')} · ${commandLink('/sessions archived', '查看已归档')}`;
  }

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
    case 'not-found':
      return `${action}失败: 宿主找不到会话 \`${displayId(entry.id)}\`（可能已被删除）`;
    case 'busy':
      return `${action}失败: 该会话还有工作在运行，稍后再试`;
    default:
      return `${action}失败: ${outcome.message ?? '未知错误'}`;
  }
}
