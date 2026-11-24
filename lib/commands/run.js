import { parseArgs } from "./args.js";
import { sendMarkdownChunked } from "../shared/index.js";
import { sessionAdminAuth } from "./sessions.js";
import { errorMessage } from "../shared/utils.js";
import { buildShellArgv, execRoot, runLocalCommand, shellSpecOf, } from "../shell/local-exec.js";
/** 默认超时：够跑构建与测试，又不至于让一句命令挂到说不出话 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 插件自己的上限：再长就不如挂后台，也免得一条消息占住整轮 */
const MAX_TIMEOUT_MS = 600_000;
/** 每路输出在 QQ 里最多显示多少字符：只留末尾，手机上翻不完几万字符 */
const MAX_OUTPUT_CHARS = 3_000;
const USAGE = [
    '### 📖 /run 用法',
    '',
    '`/run <命令>` 在当前目录执行，默认 120 秒超时',
    '`/run --timeout <秒> <命令>` 改超时（1–600 秒，`-t` 同义）',
    '开关只写在命令前，命令从第一个词起按原文执行',
    '`--` 之后不再解析参数，命令以 `-` 开头时用它隔开',
    '当前目录 = dsh 进程启动时所在的位置；shell 用操作系统自带的，可在 `exec` 配置里换',
].join('\n');
/** 缺秒数 / 秒数越界的回执 */
const TIMEOUT_MISSING = '⚠️ --timeout 后要跟秒数 · 用法: /help run';
const TIMEOUT_RANGE = '⚠️ 超时秒数要在 1–600 之间 · 用法: /help run';
/**
 * 只认命令前面的开关：`--timeout`（`-t`）取值，第一个位置参数起到行尾是命令原文。
 * `--` 之后不再解析参数，命令本身以 `-` 开头时用它隔开。
 */
const RUN_SPEC = {
    command: 'run',
    terminator: true,
    rest: true,
    flags: [{ name: 'timeout', alias: 't', value: true, missing: TIMEOUT_MISSING }],
};
/** /run — 在当前目录执行一条本地命令 */
export function runCommand({ config, logger }) {
    return {
        name: 'run',
        // 执行本地命令 = 目标机上的一切：与 /ls、/get 同一权限面
        scope: 'c2c',
        authorized: sessionAdminAuth(config, logger),
        description: '执行本地命令',
        usage: USAGE,
        handler: async (cmdCtx) => {
            // 载荷模式：命令从第一个词起按原文交给 shell
            const parsed = parseRunArgs(cmdCtx.command?.raw ?? '');
            const text = parsed.ok
                ? await execute(config, parsed.request, logger)
                : parsed.text;
            await sendMarkdownChunked(cmdCtx, text, config.textChunkLimit);
            return { kind: 'noop' };
        },
    };
}
/** 解析 `/run` 的参数（导出给单测） */
export function parseRunArgs(raw) {
    const parsed = parseArgs(raw, RUN_SPEC);
    if (parsed.error !== undefined)
        return { ok: false, text: parsed.error };
    // 载荷：第一个位置参数起到行尾，原样交给 shell
    const command = (parsed.rest ?? '').trim();
    if (command === '')
        return { ok: false, text: '⚠️ 缺少要执行的命令 · 用法: /help run' };
    const seconds = parsed.values.get('timeout');
    if (seconds === undefined)
        return { ok: true, request: { command, timeoutMs: DEFAULT_TIMEOUT_MS } };
    const timeoutMs = /^\d+$/.test(seconds) ? Number(seconds) * 1_000 : Number.NaN;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
        return { ok: false, text: TIMEOUT_RANGE };
    }
    return { ok: true, request: { command, timeoutMs } };
}
/** 取根目录 → 执行 → 渲染 */
async function execute(config, request, logger) {
    const directory = execRoot();
    const shell = shellSpecOf(config);
    const started = Date.now();
    let result;
    try {
        result = await runLocalCommand(shell, {
            command: request.command,
            cwd: directory,
            timeoutMs: request.timeoutMs,
        });
    }
    catch (err) {
        const message = errorMessage(err);
        logger?.warn(`/run 执行失败: ${message}`);
        return `❌ 执行失败: ${message}`;
    }
    const elapsed = Date.now() - started;
    return renderRun(request.command, directory, shell, elapsed, result);
}
/** 渲染成「首行结论 + 字段行 + 输出块」 */
function renderRun(command, directory, shell, elapsedMs, result) {
    // 一条字段写清「最终真正跑的是什么」：shell、参数与命令都在这行里
    const invoked = [shell.file, ...buildShellArgv(shell, command)].join(' ');
    const head = [
        headline(elapsedMs, result),
        invoked.includes('\n') ? `**命令**:\n${fence(invoked)}` : `**命令**: ${inlineCode(invoked)}`,
        `**目录**: ${inlineCode(directory)}`,
    ];
    return [head.join('\n'), ...outputBlocks(result)].join('\n\n');
}
/** 首行结论：成功 / 失败 / 超时，都带耗时 */
function headline(elapsedMs, result) {
    if (result.timedOut) {
        return `❌ 执行超时 · 已中止 · ${formatDuration(result.timeoutMs || elapsedMs)}`;
    }
    if (result.exitCode === 0)
        return `✅ 执行完成 · 退出码 0 · ${formatDuration(elapsedMs)}`;
    return `❌ 执行失败 · 退出码 ${result.exitCode ?? '无'} · ${formatDuration(elapsedMs)}`;
}
/** 毫秒 → 人读的耗时（1 秒以下给毫秒，够用且不丢精度） */
function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 1_000)
        return `${Math.max(0, Math.round(ms))}ms`;
    return `${(ms / 1_000).toFixed(1)}s`;
}
/** 输出块：stdout 有内容就不加标签；两路都有、或只有 stderr 时标明来源 */
function outputBlocks(result) {
    const hasStdout = hasBody(result.stdout);
    const hasStderr = hasBody(result.stderr);
    if (!hasStdout && !hasStderr)
        return ['（没有输出）'];
    const blocks = [];
    if (hasStdout) {
        const body = renderStream(result.stdout);
        blocks.push(hasStderr ? `**stdout**:\n${body}` : body);
    }
    if (hasStderr)
        blocks.push(`**stderr**:\n${renderStream(result.stderr)}`);
    return blocks;
}
function hasBody(output) {
    return output.text.trim() !== '';
}
/** 一路输出：代码块 + 截断说明 */
function renderStream(output) {
    const text = output.text.replace(/\s+$/, '');
    const clipped = text.length > MAX_OUTPUT_CHARS;
    const body = clipped ? text.slice(-MAX_OUTPUT_CHARS) : text;
    const parts = [fence(body)];
    if (clipped)
        parts.push('…（已截断 · 只显示末尾）');
    if (output.truncated)
        parts.push('> 💡 只保留了输出末尾');
    return parts.join('\n');
}
/** 代码块围栏：正文里出现更长的反引号串时自动加长，避免提前闭合 */
function fence(text) {
    let ticks = '```';
    while (text.includes(ticks))
        ticks += '`';
    return `${ticks}text\n${text}\n${ticks}`;
}
/** 行内代码：内容里有反引号时用双反引号包住 */
function inlineCode(value) {
    const ticks = value.includes('`') ? '``' : '`';
    return `${ticks}${value}${ticks}`;
}
//# sourceMappingURL=run.js.map