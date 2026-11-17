import { getScopePeer } from "../shared/index.js";
/** 千分位（与 /status 一致，避免不同环境的本地化分隔符） */
function num(n) {
    return n.toLocaleString('en-US');
}
/**
 * 有会话时的二次确认。
 *
 * `/clear`、`/clear all`、`/new` 都会停掉或切走会话，先在 QQ 里发一张确认卡，
 * 点「确认」才执行 run。门禁只在真有可能误伤时打开：没有当前会话（且没有已获取
 * 会话）就没什么可停的，直接执行。卡片发不出去时放弃本次动作——退回直接执行
 * 等于没有二次确认。
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
/**
 * /new — 开始新会话
 *
 * 不带参数：在当前工作区开新会话（旧会话继续在后台跑，与 `/reset` 不同）。
 * 带参数：在指定工作区开新会话。
 *
 * 参数先解析再动会话：路径写错不该把当前会话弄丢。换工作区等于换 agent 能读写
 * 的目录，所以带参数时只允许唯一绑定用户；不带参数的 `/new` 不受限制。
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
                named ? '`/new <工作区>` 在指定工作区新建会话' : '`/new <路径>` 在指定目录新建会话',
                ...(named ? ['工作区认标题、目录名或绝对路径'] : []),
            ].join('\n');
        },
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const arg = (cmdCtx.command?.raw ?? '').trim();
            // 不带参数 = 留在当前工作区；异步释放 agent，不阻塞回复
            if (arg === '') {
                return confirmOrRun(cmdCtx, manager, 'new', async () => {
                    void manager.remove();
                    return '✅ 已开启新会话';
                });
            }
            // 带参数 = 换工作区（= 换 agent 能读写的目录）：只允许唯一绑定用户
            const senderId = cmdCtx.message.senderId;
            const owner = config.access.owner.trim();
            const allowed = scope === 'c2c'
                && owner !== ''
                && senderId === owner;
            if (!allowed) {
                return '⚠️ `/new` 带参数仅限绑定用户可用；直接 `/new` 不受限制。';
            }
            // 先解析目标再动会话：路径写错不该把当前会话弄丢
            const resolved = manager.resolveWorkspace(arg);
            if (!resolved.ok)
                return describeChangeFailure(resolved);
            return confirmOrRun(cmdCtx, manager, 'new', async () => {
                await manager.remove();
                const changed = await manager.changeChatWorkspace(scope, peerId, arg);
                if (!changed.ok)
                    return describeChangeFailure(changed);
                // 没有 registry 时 title 只是路径末段，贴出来就是重复；只显示路径
                const label = manager.workspaceRegistryAvailable()
                    ? `工作区: ${changed.title} · ${changed.path}`
                    : `工作区: ${changed.path}`;
                return `✅ 已开启新会话\n${label}`;
            });
        },
    };
}
/** 换工作区失败文案（`/new <工作区>` 用，措辞与成功结果的第二行对应） */
function describeChangeFailure(outcome) {
    if (outcome.ok)
        return '';
    switch (outcome.reason) {
        case 'missing':
            return `⚠️ 目录不存在: \`${outcome.path}\`\n换一个存在的目录，或直接给绝对路径。`;
        case 'ambiguous':
            return [
                `⚠️ 有 ${outcome.matches.length} 个工作区匹配: ${outcome.matches.join('、')}`,
                '用绝对路径: `/new D:\\项目\\目录`',
            ].join('\n');
        case 'not-found':
            return `⚠️ 没有叫 \`${outcome.arg}\` 的工作区。\`/sessions all\` 看全部会话`;
        case 'unavailable':
            return '⚠️ 只支持绝对路径: `/new D:\\项目\\目录`';
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
 * 换工作区用 `/new <工作区|路径>`。
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
                    return `⚠️ /${name} 不支持指定工作区\n换工作区用 /new <工作区|路径>。`;
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
            const { scope, peerId } = getScopePeer(cmdCtx);
            const msg = cmdCtx.message;
            const outcome = await manager.compact(scope, peerId, {
                senderId: msg.senderId,
                replyTarget: { scope, targetId: peerId },
            });
            if (outcome.ok) {
                if (!outcome.shadowed)
                    return '⚠️ 没有可压缩的历史';
                // 不估算压缩后的占比：真实占用要等下一轮请求才更新，估出来的值会自相矛盾
                return `✅ 已压缩 ${outcome.shadowed} 条历史记录（约 ${num(outcome.tokens ?? 0)} tokens）`;
            }
            switch (outcome.reason) {
                case 'no-session':
                    return '⚠️ 当前没有会话';
                case 'busy':
                    return '⚠️ 正在生成中，无法压缩';
                case 'no-compaction':
                    return '⚠️ 当前 preset 没有压缩能力';
                default:
                    return `❌ 压缩失败: ${outcome.message ?? '未知错误'}`;
            }
        },
    };
}
//# sourceMappingURL=session.js.map