import { ArgError, optionValue, parseArgs } from "./args.js";
import { WorktreeError, worktreeErrorText, worktreeNoticeWithWorkspace } from "../session/index.js";
import { buildPromptBody } from "../transport/prompt-body.js";
import { takeQuote } from "./quote.js";
import { getScopePeer, shortSessionId } from "../shared/index.js";
import { errorMessage } from "../shared/utils.js";
/**
 * 有会话时的二次确认。
 *
 * `/clear`、`/clear all` 会停掉会话，先在 QQ 里发一张确认卡，点「确认」才执行
 * run。门禁只在真有可能误伤时打开：没有当前会话（且没有已获取会话）就没什么
 * 可停的，直接执行。卡片发不出去时放弃本次动作——退回直接执行等于没有二次确认。
 * `/new` 只清当前指针、不停旧会话，不在这里拦。
 */
async function confirmOrRun(cmdCtx, manager, action, run) {
    const channel = manager.sessionConfirmChannel;
    const currentId = manager.currentSessionId();
    const risky = currentId !== undefined || (action === 'reset-all' && manager.size > 0);
    if (!channel || !risky)
        return run();
    const { scope, peerId } = getScopePeer(cmdCtx);
    const offered = await channel.offer({
        action,
        ...(currentId === undefined ? {} : { currentId }),
        target: { scope, targetId: peerId },
        run,
    });
    return offered ? { kind: 'noop' } : '⚠️ 确认卡片没能发出';
}
/** 只读沙箱下开不了工作树：建树前唯一要先解决的约束 */
const READ_ONLY_WORKTREE = '⚠️ 只读沙箱开不了工作树 · 用 /permission 换成可写再试';
/** `--dir` 后面没跟工作区 */
const DIR_MISSING = '⚠️ --dir 后要跟工作区 · 用法: /help new';
/** `--background` 没给提示词：后台会话没有要跑的东西 */
const BACKGROUND_MISSING = '⚠️ --background 需要提示词 · 用法: /help new';
/** 提示词多段却没包引号：只收一段，不把词拼回字符串 */
const PROMPT_FORMAT = '⚠️ 提示词只能一段：有空格就用引号包起来，或写到 -- 之后 · 用法: /help new';
/**
 * `/new` 的开启回执：带工作区时并进首行，不再另起一行；后台保留短 id。
 */
function newSessionHead(workspace, backgroundShort, team) {
    const head = backgroundShort !== undefined
        ? workspace === undefined
            ? `✅ 已在后台开启会话 \`#${backgroundShort}\``
            : `✅ 已在工作区 ${workspace} 开启后台会话 \`#${backgroundShort}\``
        : workspace === undefined
            ? '✅ 已开启新会话'
            : `✅ 已在工作区 ${workspace} 开启新会话`;
    return team ? `${head}（团队模式）` : head;
}
/**
 * 团队模式没开成：会话照常回执，另起一行只说事实——不回滚会话，也不把「开成了」
 * 说成成功。
 */
function withTeamFailure(head, teamError) {
    return teamError === undefined ? head : `${head}\n⚠️ 团队模式没开: ${teamError}`;
}
/**
 * `/new` 的参数：`--dir`（`-d`）指定工作区，`--worktree`（`-w`）要求下一条
 * 消息先建树，提示词是一段：有空格就用引号包起来，或写在 `--` 之后（整段原样）；
 * `--prompt` 已删除，写了按未知参数处理。
 *
 * 规则与其它命令同一份（args.ts 的 parseArgs）：空格分隔，带空格的路径用引号包起来；
 * 位置参数只收一段，多写一段按参数错误回绝，不拼回字符串。不认识的参数不猜，只回
 * error，不动会话。
 */
const NEW_SPEC = {
    command: 'new',
    terminator: true,
    options: [
        { name: 'dir', alias: 'd', kind: 'value', missing: DIR_MISSING },
        { name: 'worktree', alias: 'w' },
        { name: 'team', alias: 't' },
        { name: 'background', alias: 'b' },
    ],
};
export function parseNewArgs(raw) {
    let parsed;
    try {
        parsed = parseArgs(raw, NEW_SPEC);
    }
    catch (error) {
        if (error instanceof ArgError) {
            return { arg: '', worktree: false, team: false, background: false, prompt: undefined, error: error.message };
        }
        throw error;
    }
    const worktree = optionValue(parsed, 'worktree') ?? false;
    const team = optionValue(parsed, 'team') ?? false;
    const background = optionValue(parsed, 'background') ?? false;
    const arg = optionValue(parsed, 'dir') ?? '';
    const failed = (error) => ({ arg: '', worktree, team, background, prompt: undefined, error });
    // 提示词只收一段：`--` 之后整段原样；没有 `--` 时只能是切出来的那一个词
    if (parsed.rest !== undefined) {
        if (parsed.words.length > 0)
            return failed(PROMPT_FORMAT);
        return {
            arg,
            worktree,
            team,
            background,
            prompt: parsed.rest === '' ? undefined : parsed.rest,
            error: undefined,
        };
    }
    if (parsed.words.length > 1)
        return failed(PROMPT_FORMAT);
    return {
        arg,
        worktree,
        team,
        background,
        prompt: parsed.words[0],
        error: undefined,
    };
}
/**
 * /new — 开始新会话
 *
 * 不带参数：在当前工作区开新会话（旧会话继续在后台跑，与 `/reset` 不同）。
 * 带 `--dir`（`-d`）在指定工作区开新会话。带 `--worktree`（`-w`）：下一个
 * 会话开在工作树里，基线是第一条消息到达时工作区的 HEAD；默认就地。提示词是
 * 一段（有空格就用引号包起来，或写在 `--` 之后）：立刻作为新会话的第一条消息
 * 发出，`--worktree` 的树也在这条上建；不给提示词就只清指针，等下一条消息再建会话。
 *
 * 参数先解析再动会话：路径写错不该把当前会话弄丢。换工作区等于换 agent 能读写
 * 的目录，所以带参数时只允许唯一绑定用户；不带参数的 `/new` 不受限制。
 *
 * 两条路径都不做二次确认：旧会话继续跑，没有可误伤的东西。
 */
export function newCommand({ manager, config, logger }) {
    return {
        name: 'new',
        scope: 'all',
        description: '新建会话',
        acceptsQuote: true,
        // 用法页只在有 workspaceRegistry 时列名字写法：没有该服务就只认绝对路径，
        // 与 /sessions 组标题一致，不提示「当前部署不支持按名字」。
        get usage() {
            const named = manager.workspaceRegistryAvailable();
            return [
                '### 📖 /new 用法',
                '',
                '`/new` 在当前工作区新建会话，旧会话继续跑',
                '`/new <提示词>` 新建会话并把提示词发出去；有空格就用引号包起来',
                '`/new -- <提示词>` 提示词写在 -- 之后，整段原样',
                '回复一条消息再发：被引用的内容会一起作为新会话首条消息',
                named ? '`/new --dir <工作区>` 在指定工作区新建（`-d`）' : '`/new --dir <路径>` 在指定目录新建（`-d`）',
                ...(manager.worktreesAvailable() ? ['`/new --worktree` 新会话开在独立工作树（`-w`）'] : []),
                ...(manager.teamsAvailable() ? ['`/new --team` 新会话开团队模式（`-t`）'] : []),
                '`/new --background <提示词>` 后台另开一条，不切走当前会话（`-b`）',
                ...(named ? ['工作区认标题、目录名或绝对路径'] : []),
                '`-t`、`-w`、`-b` 可合写（如 `-tb`），带值的 `-d` 只能收尾（`-wbd <工作区>`）',
                '`--` 之后不再解析参数：提示词里的 `-w` 这样原样带过去',
            ].join('\n');
        },
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const senderId = cmdCtx.message.senderId;
            const { arg, worktree, team, background, prompt, error } = parseNewArgs((cmdCtx.command?.raw ?? '').trim());
            if (error !== undefined)
                return error;
            // 没有 worktrees 服务时按未知参数处理：不解释部署差异（同 /preset 缺服务）
            if (worktree && !manager.worktreesAvailable()) {
                return '⚠️ 未知参数: --worktree · 用法: /help new';
            }
            // 没有 agentTeams 服务时同样按未知参数处理（团队模式由宿主服务落日志）
            if (team && !manager.teamsAvailable()) {
                return '⚠️ 未知参数: --team · 用法: /help new';
            }
            // 带工作区参数 = 换 agent 能读写的目录：只允许唯一绑定用户
            if (arg !== '') {
                const owner = config.access.owner.trim();
                const allowed = scope === 'c2c'
                    && owner !== ''
                    && senderId === owner;
                if (!allowed) {
                    return '⚠️ `/new` 带参数仅限绑定用户可用；直接 `/new` 不受限制。';
                }
            }
            if (worktree && manager.readOnlySandbox())
                return READ_ONLY_WORKTREE;
            // 带引用的命令：先确认引用取得到，再动会话（取不到就什么都不改）
            const taken = await takeQuote(cmdCtx, config.media, logger);
            if (typeof taken === 'string')
                return taken;
            const quote = taken;
            // 后台：另开一条会话把内容发出去，当前会话与它的工作区都不动
            if (background) {
                // 后台会话没有提示词也没有引用就没有要跑的东西（普通 /new 不给提示词是合法的）
                if (prompt === undefined && quote === undefined)
                    return BACKGROUND_MISSING;
                let directory;
                let workspaceLabel;
                let workspaceName;
                if (arg === '') {
                    directory = (await manager.chatWorkspaceInfo(scope, peerId))?.path ?? '';
                }
                else {
                    const resolved = manager.resolveWorkspace(arg);
                    if (!resolved.ok)
                        return describeChangeFailure(resolved);
                    directory = resolved.path;
                    workspaceName = resolved.title;
                    workspaceLabel = manager.workspaceRegistryAvailable()
                        ? resolved.title
                        : `\`${resolved.path}\``;
                }
                if (directory === '')
                    return '⚠️ 拿不到当前工作区 · 用 `--dir` 指定一个';
                const body = quote === undefined
                    ? prompt
                    : buildPromptBody({ quote: quote.quote, quoteFiles: quote.files, text: prompt ?? '' });
                let started;
                try {
                    started = await manager.startBackgroundSession({
                        directory,
                        worktree,
                        team,
                        prompt: body,
                        scope,
                        peerId,
                        senderId,
                        replyTarget: { scope, targetId: peerId },
                    });
                }
                catch (err) {
                    if (err instanceof WorktreeError)
                        return worktreeErrorText(err);
                    const message = errorMessage(err);
                    return `❌ 没能开启会话: ${message}`;
                }
                const short = shortSessionId(started.sessionId);
                if (started.worktreeNotice !== undefined) {
                    const head = workspaceName === undefined
                        ? started.worktreeNotice
                        : worktreeNoticeWithWorkspace(started.worktreeNotice, workspaceName);
                    return withTeamFailure(head, started.teamError);
                }
                return withTeamFailure(newSessionHead(workspaceLabel, short, team && started.teamError === undefined), started.teamError);
            }
            // 先解析目标再动会话：路径写错不该把当前会话弄丢
            if (arg !== '') {
                const resolved = manager.resolveWorkspace(arg);
                if (!resolved.ok)
                    return describeChangeFailure(resolved);
            }
            // 先清指针：带提示词时紧接着建会话，不带时等下一条消息再建
            await manager.remove();
            let workspaceLabel;
            let workspaceName;
            if (arg !== '') {
                const changed = await manager.changeChatWorkspace(scope, peerId, arg);
                if (!changed.ok)
                    return describeChangeFailure(changed);
                // 没有 registry 时 title 只是路径末段，首行贴完整路径
                workspaceName = changed.title;
                workspaceLabel = manager.workspaceRegistryAvailable()
                    ? changed.title
                    : `\`${changed.path}\``;
            }
            if (worktree)
                manager.armWorktree();
            if (team)
                manager.armTeam();
            // 带提示词或引用：立刻开会话，把内容作为第一条消息发出（--worktree 的树也在这条上建）
            if (prompt !== undefined || quote !== undefined) {
                const body = buildPromptBody({
                    ...(quote === undefined ? {} : { quote: quote.quote, quoteFiles: quote.files }),
                    text: prompt ?? '',
                });
                let started;
                try {
                    started = await manager.promptNewSession(scope, peerId, senderId, body, { scope, targetId: peerId });
                }
                catch (err) {
                    if (err instanceof WorktreeError)
                        return worktreeErrorText(err);
                    const message = errorMessage(err);
                    return `❌ 没能开启会话: ${message}`;
                }
                const head = started.worktreeNotice === undefined
                    ? newSessionHead(workspaceLabel, undefined, team && started.teamError === undefined)
                    : workspaceName === undefined
                        ? started.worktreeNotice
                        : worktreeNoticeWithWorkspace(started.worktreeNotice, workspaceName);
                return withTeamFailure(head, started.teamError);
            }
            // 树要到下一条消息才建，这里不预告：建好那一刻由建树回执交代
            return newSessionHead(workspaceLabel, undefined, team);
        },
    };
}
/** 换工作区失败文案（`/new --dir <工作区>` 用，措辞与成功回执首行的工作区对应） */
function describeChangeFailure(outcome) {
    if (outcome.ok)
        return '';
    switch (outcome.reason) {
        case 'missing':
            return `⚠️ 目录不存在: \`${outcome.path}\``;
        case 'ambiguous':
            return [
                `⚠️ 有 ${outcome.matches.length} 个工作区匹配: ${outcome.matches.join('、')}`,
                '用绝对路径: `/new --dir D:\\项目\\目录`',
            ].join('\n');
        case 'not-found':
            return `⚠️ 没有叫 \`${outcome.arg}\` 的工作区。\`/sessions all\` 看全部会话`;
        case 'unavailable':
            return '⚠️ 只支持绝对路径: `/new --dir D:\\项目\\目录`';
        default:
            return '⚠️ 工作区切换失败。';
    }
}
/**
 * /clear（别名 /reset）— 停掉当前会话，再在原工作区开新会话
 *
 * 主名用 `clear`：指令面板与 `/help` 都取第一个名字，`clear` 比 `reset`
 * 更像是「清掉当前对话」；`reset` 作为别名继续可用，行为完全一致。
 *
 * 与 `/new` 的区别：`/new` 只清掉当前指针，旧会话继续在后台跑；
 * `/clear` 会 cancel 并释放当前会话，旧会话不再回 QQ。`/clear all` 停掉所有
 * 已获取会话。其它已获取会话不受影响（不带 all 时）。不支持工作区参数，
 * 换工作区用 `/new --dir <工作区|路径>`。
 */
export function resetCommand({ manager }) {
    return {
        name: ['clear', 'reset'],
        scope: 'all',
        description: '停止并新建会话',
        usage: [
            '### 📖 /clear 用法',
            '',
            '`/clear` 停止当前会话并新建',
            '`/clear all` 停止全部会话并新建',
        ].join('\n'),
        handler: async (cmdCtx) => {
            const arg = (cmdCtx.command?.raw ?? '').trim();
            const name = cmdCtx.command?.name ?? 'clear';
            if (arg !== '') {
                if (arg.toLowerCase() !== 'all') {
                    return `⚠️ /${name} 不支持指定工作区\n换工作区用 /new --dir <工作区|路径>。`;
                }
                return confirmOrRun(cmdCtx, manager, 'reset-all', async () => {
                    const stopped = await manager.resetAllSessions();
                    return stopped === 0
                        ? '✅ 已开启新会话'
                        : `✅ 已停止 ${stopped} 个会话，并开启新会话`;
                });
            }
            return confirmOrRun(cmdCtx, manager, 'reset', async () => {
                const stopped = await manager.resetCurrentSession();
                return stopped ? '✅ 已停止当前会话，并开启新会话' : '✅ 已开启新会话';
            });
        },
    };
}
/** /compact — 原地压缩会话历史 */
export function compactCommand({ manager }) {
    return {
        name: 'compact',
        scope: 'all',
        description: '压缩会话历史',
        handler: async (cmdCtx) => {
            const msg = cmdCtx.message;
            const { scope, peerId } = getScopePeer(cmdCtx);
            // 没有活跃会话时从磁盘拉起：历史在磁盘上仍可压缩
            const record = await manager.getOrCreate(scope, peerId, msg.senderId, {
                scope,
                targetId: peerId,
            });
            const run = await manager.runHostCommand(record.agent, 'compact');
            // 文本是宿主原文：不估占比、不做映射（真实占用要等下一轮请求才更新）
            if (run.kind === 'unsupported')
                return '⚠️ 当前 preset 没有压缩能力';
            if (run.kind === 'threw')
                return `❌ 压缩失败: ${run.message}`;
            if (run.kind === 'success')
                return run.text ? `✅ 压缩完成: ${run.text}` : '✅ 压缩完成';
            return run.text ? `❌ 压缩失败: ${run.text}` : '❌ 压缩失败';
        },
    };
}
//# sourceMappingURL=session.js.map