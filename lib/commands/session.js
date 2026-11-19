import { parseArgs } from "./args.js";
import { WorktreeError, worktreeErrorText } from "../session/index.js";
import { getScopePeer, shortSessionId } from "../shared/index.js";
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
    return offered ? { kind: 'noop' } : '⚠️ 确认卡片没能发出，稍后再试一次';
}
/** 只读沙箱下开不了工作树：建树前唯一要先解决的约束 */
const READ_ONLY_WORKTREE = '⚠️ 只读沙箱开不了工作树 · 用 /permission 换成可写再试';
/** `--dir` 后面没跟工作区 */
const DIR_MISSING = '⚠️ --dir 后要跟工作区 · 用法: /help new';
/** `--background` 没给提示词：后台会话没有要跑的东西 */
const BACKGROUND_MISSING = '⚠️ --background 需要提示词 · 用法: /help new';
/**
 * `/new` 的参数：`--dir`（`-d`）指定工作区，`--worktree`（`-w`）要求下一条
 * 消息先建树，剩下的文字整体是提示词（直接写；`--prompt` 已删除，写了按未知参数处理）。
 *
 * 规则与其它命令同一份（args.ts 的 parseArgs）：空格分隔，带空格的路径或提示词用
 * 引号包起来；`--` 之后一律当提示词，参数位置随意。不认识的参数不猜，只回
 * error，不动会话。
 */
export function parseNewArgs(raw) {
    const parsed = parseArgs(raw, {
        command: 'new',
        terminator: true,
        flags: [
            { name: 'dir', alias: 'd', value: true, missing: DIR_MISSING },
            { name: 'worktree', alias: 'w' },
            { name: 'background', alias: 'b' },
        ],
    });
    const worktree = parsed.flags.has('worktree');
    const background = parsed.flags.has('background');
    if (parsed.error !== undefined) {
        return { arg: '', worktree, background, prompt: undefined, error: parsed.error };
    }
    const prompt = parsed.words.length === 0 ? undefined : parsed.words.join(' ');
    return { arg: parsed.values.get('dir') ?? '', worktree, background, prompt, error: undefined };
}
/**
 * /new — 开始新会话
 *
 * 不带参数：在当前工作区开新会话（旧会话继续在后台跑，与 `/reset` 不同）。
 * 带 `--dir`（`-d`）在指定工作区开新会话。带 `--worktree`（`-w`）：下一个
 * 会话开在工作树里，基线是第一条消息到达时工作区的 HEAD；默认就地。其余文字
 * （位置随意）整体是提示词：立刻作为新会话的第一条消息发出，`--worktree` 的树
 * 也在这条上建；不给提示词就只清指针，等下一条消息再建会话。
 *
 * 参数先解析再动会话：路径写错不该把当前会话弄丢。换工作区等于换 agent 能读写
 * 的目录，所以带参数时只允许唯一绑定用户；不带参数的 `/new` 不受限制。
 *
 * 两条路径都不做二次确认：旧会话继续跑，没有可误伤的东西。
 */
export function newCommand({ manager, config }) {
    return {
        name: 'new',
        scope: 'all',
        description: '新建会话',
        // 用法页只在有 workspaceRegistry 时列名字写法：没有该服务就只认绝对路径，
        // 与 /sessions 组标题一致，不提示「当前部署不支持按名字」。
        get usage() {
            const named = manager.workspaceRegistryAvailable();
            return [
                '### 📖 /new 用法',
                '',
                '`/new` 在当前工作区新建会话',
                '`/new <提示词>` 新建会话并把提示词发出去',
                named ? '`/new --dir <工作区>` 在指定工作区新建会话' : '`/new --dir <路径>` 在指定目录新建会话',
                '`-d` 是 `--dir` 的简写，路径带空格就加引号',
                ...(manager.worktreesAvailable() ? ['`/new --worktree` 在当前分支上拉出独立工作树'] : []),
                ...(named ? ['工作区认标题、目录名或绝对路径'] : []),
                '`/new --background <提示词>`（`-b`）另开一条会话在后台跑，不切走当前会话',
                '空格分隔参数，带空格的路径或提示词加引号',
                '参数位置随意；`--` 之后一律当提示词',
                '不给提示词就只清指针；`--background` 必须带提示词',
            ].join('\n');
        },
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const senderId = cmdCtx.message.senderId;
            const { arg, worktree, background, prompt, error } = parseNewArgs((cmdCtx.command?.raw ?? '').trim());
            if (error !== undefined)
                return error;
            // 没有 worktrees 服务时按未知参数处理：不解释部署差异（同 /preset 缺服务）
            if (worktree && !manager.worktreesAvailable()) {
                return '⚠️ 未知参数: --worktree · 用法: /help new';
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
            // 后台：另开一条会话把提示词发出去，当前会话与它的工作区都不动
            if (background) {
                // 后台会话没有提示词就没有要跑的东西（普通 /new 不给提示词是合法的）
                if (prompt === undefined)
                    return BACKGROUND_MISSING;
                let directory;
                let label;
                if (arg === '') {
                    directory = (await manager.chatWorkspaceInfo(scope, peerId))?.path ?? '';
                }
                else {
                    const resolved = manager.resolveWorkspace(arg);
                    if (!resolved.ok)
                        return describeChangeFailure(resolved);
                    directory = resolved.path;
                    label = manager.workspaceRegistryAvailable()
                        ? `工作区: ${resolved.title} · ${resolved.path}`
                        : `工作区: ${resolved.path}`;
                }
                if (directory === '')
                    return '⚠️ 拿不到当前工作区 · 用 `--dir` 指定一个';
                let started;
                try {
                    started = await manager.startBackgroundSession({
                        directory,
                        worktree,
                        prompt,
                        scope,
                        peerId,
                        senderId,
                        replyTarget: { scope, targetId: peerId },
                    });
                }
                catch (err) {
                    if (err instanceof WorktreeError)
                        return worktreeErrorText(err);
                    const message = err instanceof Error ? err.message : String(err);
                    return `❌ 没能开启会话: ${message}\n稍后再试一次。`;
                }
                const short = shortSessionId(started.sessionId);
                const lines = started.worktreeNotice === undefined
                    ? [`✅ 已在后台开启会话 \`#${short}\``]
                    : [started.worktreeNotice];
                if (label !== undefined)
                    lines.push(label);
                lines.push(`> 💡 /sessions resume #${short} 切过去`);
                return lines.join('\n');
            }
            // 先解析目标再动会话：路径写错不该把当前会话弄丢
            if (arg !== '') {
                const resolved = manager.resolveWorkspace(arg);
                if (!resolved.ok)
                    return describeChangeFailure(resolved);
            }
            // 先清指针：带提示词时紧接着建会话，不带时等下一条消息再建
            await manager.remove();
            let label;
            if (arg !== '') {
                const changed = await manager.changeChatWorkspace(scope, peerId, arg);
                if (!changed.ok)
                    return describeChangeFailure(changed);
                // 没有 registry 时 title 只是路径末段，贴出来就是重复；只显示路径
                label = manager.workspaceRegistryAvailable()
                    ? `工作区: ${changed.title} · ${changed.path}`
                    : `工作区: ${changed.path}`;
            }
            if (worktree)
                manager.armWorktree();
            // 带提示词：立刻开会话，把提示词作为第一条消息发出（--worktree 的树也在这条上建）
            if (prompt !== undefined) {
                let notice;
                try {
                    const started = await manager.promptNewSession(scope, peerId, senderId, prompt, { scope, targetId: peerId });
                    notice = started.worktreeNotice;
                }
                catch (err) {
                    if (err instanceof WorktreeError)
                        return worktreeErrorText(err);
                    const message = err instanceof Error ? err.message : String(err);
                    return `❌ 没能开启会话: ${message}\n稍后再试一次。`;
                }
                const lines = notice === undefined ? ['✅ 已开启新会话，提示词已发出'] : [notice];
                if (label !== undefined)
                    lines.push(label);
                return lines.join('\n');
            }
            const head = '✅ 已开启新会话';
            const pending = worktree ? '\n🌿 下一条消息开新工作树' : '';
            return label === undefined ? `${head}${pending}` : `${head}\n${label}${pending}`;
        },
    };
}
/** 换工作区失败文案（`/new --dir <工作区>` 用，措辞与成功结果的第二行对应） */
function describeChangeFailure(outcome) {
    if (outcome.ok)
        return '';
    switch (outcome.reason) {
        case 'missing':
            return `⚠️ 目录不存在: \`${outcome.path}\`\n换一个存在的目录，或直接给绝对路径。`;
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