import { errorText, sendMarkdownChunked } from "../shared/index.js";
import { renderPluginList } from "../plugins/format.js";
import { ownerOnlyAuth } from "./auth.js";
import { QUOTE_OPEN_TEXT, tokenize } from "./args.js";
/** 用法页：没有 hmr 服务时 `reload` 整条不出现，免得用户看到一条注定回「不支持」的子命令 */
function usageFor(reloadable) {
    return [
        '### 📖 /plugins 用法',
        '',
        '`/plugins [页码]` 列出已安装插件',
        '`/plugins install <包名> [--allow-builds=<包名,…>]` 安装插件',
        '`/plugins update <包名> [版本]` 更新插件',
        ...(reloadable ? ['`/plugins reload` 应用磁盘变更'] : []),
    ].join('\n');
}
/** `--allow-builds` 没给包名 */
const ALLOW_BUILDS_MISSING = '⚠️ --allow-builds 后要跟包名 · 用法: /help plugins';
/**
 * 安装的附加参数：只认 `--allow-builds=a,b`（用户看到「构建脚本被拦下」之后才会带）。
 *
 * 认不出的参数不猜：原先静默跳过，把 `--allow-builds` 拼错就成了「不带审批安装」，
 * 用户以为放行了，插件又被拦在构建脚本上。
 */
function parseInstallFlags(tokens) {
    const approved = [];
    for (const token of tokens) {
        if (!token.value.startsWith('--allow-builds')) {
            return { error: `⚠️ 未知参数: ${token.value} · 用法: /help plugins` };
        }
        const value = token.value.slice('--allow-builds'.length);
        if (!value.startsWith('='))
            return { error: ALLOW_BUILDS_MISSING };
        const names = value.slice(1).split(',').map((name) => name.trim()).filter((name) => name !== '');
        if (names.length === 0)
            return { error: ALLOW_BUILDS_MISSING };
        approved.push(...names);
    }
    return approved.length === 0 ? {} : { approved };
}
/** /plugins — 插件安装 / 更新 / 列表 / 热重载 */
export function pluginsCommand({ config, logger, installer, reloader }) {
    return {
        name: 'plugins',
        scope: 'all',
        authorized: ownerOnlyAuth(config, logger),
        description: '管理插件',
        // 部署里没有 hmr 时按未知子命令处理，用法页也不列这一行
        get usage() {
            return usageFor(reloader?.available === true);
        },
        handler: async (cmdCtx) => {
            const extras = cmdCtx;
            const bot = extras.bot;
            const targetId = extras.replyTarget?.targetId;
            // 切词按约定俗成：空格分隔，带空格的值用引号包起来
            const { tokens, error } = tokenize((cmdCtx.command?.raw ?? '').trim());
            if (error !== undefined)
                return `${QUOTE_OPEN_TEXT} · 用法: /help plugins`;
            const words = tokens.map((token) => token.value);
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
                        return '⚠️ 缺少包名 · 用法: /help plugins';
                    // 参数先校验再动手：认不出的参数回绝，不静默丢掉审批
                    const version = sub === 'update' ? words[2] : undefined;
                    let approved;
                    if (sub === 'install') {
                        const flags = parseInstallFlags(tokens.slice(2));
                        if (flags.error !== undefined)
                            return flags.error;
                        approved = flags.approved;
                    }
                    else if (tokens[3] !== undefined) {
                        return `⚠️ 未知参数: ${tokens[3].value} · 用法: /help plugins`;
                    }
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
                    const ack = sub === 'install'
                        ? `🔄 正在安装 ${target}…`
                        : version === undefined ? `🔄 正在更新 ${target}…` : `🔄 正在更新 ${target} → ${version}…`;
                    await sendMarkdownChunked(cmdCtx, ack, config.textChunkLimit);
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
                    if (reloader === undefined || !reloader.available) {
                        return `⚠️ 不支持的子命令: \`${sub}\` · 用法: /help plugins`;
                    }
                    // 上一轮的结论可能还没送到（新 fiber 的 ready 补发之前又收到这条命令）：
                    // run() 会把状态改写成 running，那一轮「应用了什么」就再也读不到了。
                    if (bot !== undefined)
                        await reloader.announce(bot);
                    // 先回复再调度：重载会 dispose 当前 fiber，回复必须在此之前送出
                    await sendMarkdownChunked(cmdCtx, '🔄 正在应用插件变更…', config.textChunkLimit);
                    reloader.run(notify, bot);
                    return { kind: 'noop' };
                }
                return `⚠️ 不支持的子命令: \`${sub}\` · 用法: /help plugins`;
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