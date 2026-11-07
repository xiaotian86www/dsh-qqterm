/**
 * 热重载状态文件
 *
 * 重载会 dispose 当前 fiber：命令处理器写下的「通知谁、什么时候开始」在内存里
 * 活不过一次 dispose，结果也只能靠落盘传给新 fiber。因此状态文件是这条链路
 * 唯一的事实来源，只存那一轮重载最必要的事实。
 *
 * 路径按 profile 隔离（`~/.dsh-qqbot/reload/<sha1(profileDir)>.json`）：web 与
 * 开发 profile 经常同时开着，共用一份文件会互相覆盖 notify 与结果。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PLUGIN_HOME } from "../shared/dirs.js";
import { formatRelativeTime } from "../shared/utils.js";
const STATE_DIR = resolve(PLUGIN_HOME, 'reload');
/** 状态文件路径（profile 维度，避免多 profile 同时运行时互相覆盖） */
export function reloadStatePath(profileDir) {
    const digest = createHash('sha1').update(profileDir ?? '').digest('hex').slice(0, 8);
    return resolve(STATE_DIR, `${digest}.json`);
}
/** 读状态：文件不存在或损坏一律当「没有记录」，不让排障信息挡住重载主流程 */
export function readReloadState(path, logger) {
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch (err) {
        if (err.code !== 'ENOENT') {
            logger?.warn(`读取热重载状态失败: ${errorText(err)}`);
        }
        return undefined;
    }
    try {
        const parsed = JSON.parse(text);
        if (parsed.phase !== 'running' && parsed.phase !== 'done' && parsed.phase !== 'failed') {
            return undefined;
        }
        return {
            ...parsed,
            phase: parsed.phase,
            startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
        };
    }
    catch (err) {
        logger?.warn(`解析热重载状态失败: ${errorText(err)}`);
        return undefined;
    }
}
/** 原子写：先写同目录临时文件再 rename，避免新 fiber 读到半个 JSON */
export function writeReloadState(path, state, logger) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(state), 'utf8');
        renameSync(tmp, path);
    }
    catch (err) {
        logger?.warn(`写入热重载状态失败: ${errorText(err)}`);
    }
}
/** 状态的一句话描述（`/bot-status` 用）；无记录时返回 undefined */
export function describeReloadState(state) {
    if (state === undefined)
        return undefined;
    const when = formatRelativeTime(state.startedAt);
    if (state.phase === 'running')
        return `🔄 进行中 · ${when}`;
    if (state.phase === 'failed')
        return `❌ 失败 · ${when}`;
    return state.restartReason === undefined
        ? `✅ 已应用 · ${when}`
        : `⚠️ 已应用，部分改动需重启 · ${when}`;
}
/** 错误消息截断：状态文件只留够排障的一行，不落整个堆栈 */
export function errorText(err, limit = 300) {
    const text = err instanceof Error ? err.message : String(err);
    return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
//# sourceMappingURL=state.js.map