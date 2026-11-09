import { errorText, sendMarkdownChunked } from "../shared/index.js";
import { renderPluginList } from "../plugins/format.js";
import { ownerOnlyAuth } from "./auth.js";
const USAGE = [
    '/plugins',
    '/plugins list [页码]',
    '/plugins install <包名> [--allow-builds=<包名,...>]',
    '/plugins update <包名> [版本]',
    '/plugins reload',
    '',
    '不带参数列出已安装的插件；install / update 走 registry。',
    'reload 应用磁盘上的插件变更；本地快照仍走 `pnpm dev:reload` + `/plugins reload`。',
].join('\n');
/** 解析 `--allow-builds=a,b`：只在用户看到「构建脚本被拦下」之后才会带 */
function parseApproved(args) {
    for (const arg of args) {
        const match = /^--allow-builds=(.*)$/.exec(arg);
        const value = match?.[1];
        if (value === undefined)
            continue;
        const names = value.split(',').map((name) => name.trim()).filter((name) => name !== '');
        if (names.length > 0)
            return names;
    }
    return undefined;
}
/** /plugins — 插件安装 / 更新 / 列表 / 热重载 */
export function pluginsCommand({ config, logger, installer, reloader }) {
    return {
        name: 'plugins',
        category: 'qqbot',
        scope: 'all',
        authorized: ownerOnlyAuth(config, logger),
        description: '列出、安装、更新插件，或热重载',
        panelDesc: '插件管理',
        usage: USAGE,
        handler: async (cmdCtx) => {
            const extras = cmdCtx;
            const bot = extras.bot;
            const targetId = extras.replyTarget?.targetId;
            const words = (cmdCtx.command?.raw ?? '').trim().split(/\s+/).filter((word) => word !== '');
            const sub = words[0] ?? '';
            const notify = targetId === undefined || targetId === '' ? undefined : { targetId };
            try {
                // 无参 / list / 纯数字都进列表视图
                if (sub === '' || sub === 'list' || /^\d+$/.test(sub)) {
                    if (installer === undefined)
                        return '⚠️ 当前 profile 没有插件管理能力';
                    const raw = sub === 'list' ? (words[1] ?? '1') : sub === '' ? '1' : sub;
                    const page = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 1;
                    return await listPage(cmdCtx, installer, page, config.textChunkLimit);
                }
                if (sub === 'install' || sub === 'update') {
                    if (installer === undefined)
                        return '⚠️ 当前 profile 没有插件管理能力';
                    const target = words[1];
                    if (target === undefined)
                        return `⚠️ 缺少包名\n用法: ${USAGE.split('\n')[2] ?? ''}`;
                    if (sub === 'update') {
                        const info = await installer.find(target);
                        if (info === undefined || !info.installed)
                            return `⚠️ 没有这个插件: ${target}`;
                        // 本地包（tgz / 目录）宿主不给 update，请求发出去只会多一条 already-installed
                        if (!info.updatable)
                            return '⚠️ 本地安装，不能自动更新';
                    }
                    // 上一轮的结果可能还没送到：run() 会改写成 running，那一轮就再也读不到了。
                    // 必须排在回执之前，否则结论会排在这条「正在…」后面，读成它的结果。
                    if (bot !== undefined)
                        await installer.announce(bot);
                    const running = installer.pending();
                    if (running !== undefined)
                        return `⚠️ 上一个插件操作还没结束: ${running.target}`;
                    const version = sub === 'update' ? words[2] : undefined;
                    const ack = sub === 'install'
                        ? `🔄 正在安装 ${target}…`
                        : version === undefined ? `🔄 正在更新 ${target}…` : `🔄 正在更新 ${target} → ${version}…`;
                    await sendMarkdownChunked(cmdCtx, ack, config.textChunkLimit);
                    const approved = sub === 'install' ? parseApproved(words.slice(2)) : undefined;
                    installer.run({
                        action: sub,
                        target,
                        ...(sub === 'install' ? { spec: target } : {}),
                        ...(version === undefined ? {} : { version }),
                        ...(approved === undefined ? {} : { approvedBuilds: approved }),
                        ...(notify === undefined ? {} : { notify }),
                    }, bot);
                    return { kind: 'noop' };
                }
                if (sub === 'reload') {
                    if (reloader === undefined || !reloader.available)
                        return '⚠️ 当前 profile 未启用热重载';
                    // 上一轮的结论可能还没送到（新 fiber 的 ready 补发之前又收到这条命令）：
                    // run() 会把状态改写成 running，那一轮「应用了什么」就再也读不到了。
                    if (bot !== undefined)
                        await reloader.announce(bot);
                    // 先回复再调度：重载会 dispose 当前 fiber，回复必须在此之前送出
                    await sendMarkdownChunked(cmdCtx, '🔄 正在应用插件变更…', config.textChunkLimit);
                    reloader.run(notify, bot);
                    return { kind: 'noop' };
                }
                return `⚠️ 不支持的子命令: \`${sub}\`\n用法: /plugins [页码|list|install|update|reload]`;
            }
            catch (err) {
                return `❌ 插件操作启动失败: ${errorText(err)}`;
            }
        },
    };
}
/** 列表视图：查询失败要给出理由，不能静默 */
async function listPage(cmdCtx, installer, page, chunkLimit) {
    const bundles = await installer.list();
    // 版本箭头来自后台检查的缓存，这里不为了列表去查 registry
    const cached = installer.updates();
    // 页码越界由渲染层夹到有效范围，这里不做二次判断
    await sendMarkdownChunked(cmdCtx, renderPluginList(bundles, page, cached?.versions), chunkLimit);
    return { kind: 'noop' };
}
//# sourceMappingURL=plugins.js.map