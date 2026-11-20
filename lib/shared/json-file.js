/**
 * JSON 状态文件读写
 *
 * 插件操作、热重载、偏好、被动回复缓存都有一份「小状态文件」：不存在当没有、
 * 解析失败不炸主流程、写入走同目录临时文件 + rename 以防崩溃留半份。
 * 这层只做文件动作，字段校验留在各自的 state 模块。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { errorText } from "./utils.js";
/**
 * 读 JSON：文件不存在或损坏一律当「没有记录」，不让排障信息挡住主流程。
 *
 * `label` 进 warn 文案（`读取插件操作状态失败`），调用方给中文名。
 */
export function readJsonFile(path, label, logger) {
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
/** 尽力写：失败只 warn 不抛，用于「写不进去也不该挡住主流程」的状态文件 */
export function writeJsonFile(path, value, options) {
    try {
        writeJsonAtomic(path, value, options.pretty);
    }
    catch (err) {
        options.logger?.warn(`写入${options.label}失败: ${errorText(err)}`);
    }
}
/**
 * 原子写：先写同目录临时文件再 rename，避免并发读方读到半个 JSON。
 *
 * 写失败抛出，由调用方决定是 warn 还是走自己的错误回调；临时文件会先清掉。
 * 临时名带进程 + 随机后缀：多进程同时写各自的临时文件不互相覆盖，
 * rename 只会带走自己写的那份。
 */
export function writeJsonAtomic(path, value, pretty = false) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
        writeFileSync(tmp, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value), 'utf8');
        renameSync(tmp, path);
    }
    catch (err) {
        try {
            unlinkSync(tmp);
        }
        catch { /* 临时文件可能没写出来 */ }
        throw err;
    }
}
//# sourceMappingURL=json-file.js.map