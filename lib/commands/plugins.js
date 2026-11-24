import { errorText, sendMarkdownChunked } from "../shared/index.js";
import { renderPluginCheck, renderPluginList } from "../plugins/format.js";
import { ownerOnlyAuth } from "./auth.js";
import { ArgError, optionValue, parseArgs } from "./args.js";
/** 用法页：没有 hmr 服务时 `reload` 整条不出现，免得用户看到一条注定回「不支持」的子命令 */
function usageFor(reloadable) {
    return [
        '### 📖 /plugins 用法',
        '',
        '`/plugins [页码]` 列出已安装插件',
        '`/plugins install <包名> [--allow-builds=<包名,…>]` 安装插件',
        '`/plugins update <包名> [版本]` 更新插件',
        '`/plugins check` 立即检查插件更新',
        ...(reloadable ? ['`/plugins reload` 应用磁盘变更'] : []),
    ].join('\n');
}
/** `--allow-builds` 没给包名 */
const ALLOW_BUILDS_MISSING = '⚠️ --allow-builds 后要跟包名 · 用法: /help plugins';
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
            // 切词按约定俗成：空格分隔，带空格的值用引号包起来；认不出的参数直接回绝
            let parsed;
            try {
                parsed = parseArgs((cmdCtx.command?.raw ?? '').trim(), {
                    command: 'plugins',
                    options: [{ name: 'allow-builds', kind: 'list', missing: ALLOW_BUILDS_MISSING }],
                });
            }
            catch (error) {
                if (error instanceof ArgError)
                    return error.message;
                throw error;
            }
            const { words } = parsed;
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
                if (sub === 'check') {
                    if (installer === undefined)
                        return '⚠️ 当前 profile 没有插件管理能力';
                    if (words[1] !== undefined)
                        return `⚠️ 未知参数: ${words[1]} · 用法: /help plugins`;
                    // 检查只读 registry、写更新缓存，不碰 profile：可以就地等结果，不必脱离 fiber
                    let text;
                    try {
                        text = renderPluginCheck(await installer.checkUpdates());
                    }
                    catch (err) {
                        return `❌ 检查插件更新失败: ${errorText(err)}`;
                    }
                    // SDK 只把 handler 的返回值按纯文本发；命令链接必须走 markdown 发送路径，
                    // 否则会退化成裸标签（与列表视图同一条路）
                    await sendMarkdownChunked(cmdCtx, text, config.textChunkLimit);
                    return { kind: 'noop' };
                }
                if (sub === 'install' || sub === 'update') {
                    if (installer === undefined)
                        return '⚠️ 当前 profile 没有插件管理能力';
                    const target = words[1];
                    if (target === undefined)
                        return '⚠️ 缺少包名 · 用法: /help plugins';
                    // 参数先校验再动手：多给的位置参数回绝，不静默丢掉（拼错的 --allow-builds
                    // 已在 parseArgs 里当未知参数挡掉）
                    const version = sub === 'update' ? words[2] : undefined;
                    const extra = sub === 'install' ? words[2] : words[3];
                    if (extra !== undefined)
                        return `⚠️ 未知参数: ${extra} · 用法: /help plugins`;
                    const approved = sub === 'install' ? optionValue(parsed, 'allow-builds') : undefined;
                    if (sub === 'update') {
                        const info = await installer.find(target);
                        if (info === undefined || !info.installed)
                            return `⚠️ 没有这个插件: ${target}`;
                        // 本地包（tgz / 目录）宿主不给 update，请求发出去只会多一条 already-installed
                        if (info.update !== 'registry')
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