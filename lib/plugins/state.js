/**
 * 插件操作状态文件
 *
 * 安装 / 更新会 reconcile profile，可能把 qqterm 自己换掉：命令处理器所在的
 * fiber 被 dispose 后，内存里的结果就没了。因此「这一轮在装什么、结果如何、
 * 往哪回」必须落盘，由新 fiber 的 ready 或下一条命令前的补发读回来。
 *
 * 路径按 profile 隔离（`~/.dsh-qqterm/plugin-ops/<sha1(profileDir)>.json`）：
 * web 与开发 profile 常同时开着，共用一份文件会互相覆盖通知与结果。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PLUGIN_HOME } from "../shared/dirs.js";
import { errorText, formatRelativeTime } from "../shared/utils.js";
const STATE_DIR = resolve(PLUGIN_HOME, 'plugin-ops');
/** 状态文件路径（profile 维度，避免多 profile 同时运行时互相覆盖） */
export function pluginOpStatePath(profileDir) {
    const digest = createHash('sha1').update(profileDir ?? '').digest('hex').slice(0, 8);
    return resolve(STATE_DIR, `${digest}.json`);
}
/** 检查结果路径：与操作状态同目录，多 profile 各自一份 */
export function pluginUpdateCachePath(profileDir) {
    const digest = createHash('sha1').update(profileDir ?? '').digest('hex').slice(0, 8);
    return resolve(STATE_DIR, `updates-${digest}.json`);
}
/** 读检查结果：文件不存在或损坏当作「还没查过」，列表不显示版本箭头 */
export function readPluginUpdateCache(path, logger) {
    const parsed = readJson(path, logger, '插件更新检查结果');
    if (parsed === undefined)
        return undefined;
    const raw = parsed.versions;
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const versions = {};
    for (const [name, version] of Object.entries(raw)) {
        if (typeof version === 'string' && version !== '')
            versions[name] = version;
    }
    const checkedAt = parsed.checkedAt;
    return { checkedAt: typeof checkedAt === 'number' ? checkedAt : 0, versions };
}
export function writePluginUpdateCache(path, cache, logger) {
    writeJson(path, cache, logger, '插件更新检查结果');
}
/** 读 JSON：文件不存在或损坏一律当「没有记录」，不让排障信息挡住主流程 */
function readJson(path, logger, label) {
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch (err) {
        if (err.code !== 'ENOENT') {
            logger?.warn(`读取${label}失败: ${errorText(err)}`);
        }
        return undefined;
    }
    try {
        return JSON.parse(text);
    }
    catch (err) {
        logger?.warn(`解析${label}失败: ${errorText(err)}`);
        return undefined;
    }
}
/** 原子写：先写同目录临时文件再 rename，避免新 fiber 读到半个 JSON */
function writeJson(path, value, logger, label) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(value), 'utf8');
        renameSync(tmp, path);
    }
    catch (err) {
        logger?.warn(`写入${label}失败: ${errorText(err)}`);
    }
}
/** 读状态：文件不存在或损坏一律当「没有记录」，不让排障信息挡住主流程 */
export function readPluginOpState(path, logger) {
    const parsed = readJson(path, logger, '插件操作状态');
    if (parsed === undefined)
        return undefined;
    if (parsed.action !== 'install' && parsed.action !== 'update')
        return undefined;
    if (parsed.phase !== undefined && parsed.phase !== 'done' && parsed.phase !== 'failed')
        return undefined;
    return {
        ...parsed,
        action: parsed.action,
        target: typeof parsed.target === 'string' ? parsed.target : '',
        phase: parsed.phase,
        startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
    };
}
/** 原子写：先写同目录临时文件再 rename，避免新 fiber 读到半个 JSON */
export function writePluginOpState(path, state, logger) {
    writeJson(path, state, logger, '插件操作状态');
}
/** 状态的一句话描述（`/bot-status` 用）；无记录时返回 undefined */
export function describePluginOpState(state) {
    if (state === undefined)
        return undefined;
    const when = formatRelativeTime(state.startedAt);
    const label = state.action === 'install' ? '安装' : '更新';
    if (state.phase === undefined)
        return `🔄 ${label}中 · ${when}`;
    if (state.phase === 'failed')
        return `❌ ${label}失败 · ${when}`;
    return `✅ 已${label} · ${when}`;
}
//# sourceMappingURL=state.js.map