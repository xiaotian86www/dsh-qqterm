/**
 * 本地命令：/run
 *
 *   /run <命令>                 在当前目录执行一条命令（默认 120 秒超时）
 *   /run --timeout <秒> <命令>   指定超时（最长 600 秒）
 *
 * 与 `/ls`、`/get` 同属扩展功能：插件自己起进程，不经过宿主的任何能力面。工作
 * 目录是宿主进程的当前目录（三个命令共用同一个基准），与会话的工作区、运行目录都
 * 无关；shell 用操作系统自带的那个，可在 `exec.shell` 里换。命令是用户亲手发起的，
 * 后果由用户承担，不套宿主的沙箱（见 shell/local-exec.ts）。
 *
 * 参数走共用解析器的载荷模式（args.ts 的 `rest`）：开关只认命令前面那段，第一个
 * 词起到行尾原样当命令，命令里的 `-la`、`--json`、管道与 `&&` 都不动。
 *
 * 与 `/ls`、`/get` 同一权限面：能在目标机上执行命令，等于能碰 agent 手里的一切，
 * 只允许唯一绑定用户（`access.owner`）。
 */
import type { CommandDeps, SlashCommand } from './types.ts';
import type { Logger } from '../types.ts';
import { parseArgs } from './args.ts';
import type { ParseSpec } from './args.ts';
import { sendMarkdownChunked } from '../shared/index.ts';
import { sessionAdminAuth } from './sessions.ts';
import { errorMessage } from '../shared/utils.ts';
import {
  execRoot,
  runLocalCommand,
  shellSpecOf,
  type LocalExecResult,
  type LocalExecStream,
  type ShellSpec,
} from '../shell/local-exec.ts';

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

/** 一次执行的入参 */
export interface RunRequest {
  readonly command: string;
  readonly timeoutMs: number;
}

/** 解析结果：要么给出入参，要么给一句可以直接发出去的提示 */
export type RunParse =
  | { ok: true; request: RunRequest }
  | { ok: false; text: string };

/** 缺秒数 / 秒数越界的回执 */
const TIMEOUT_MISSING = '⚠️ --timeout 后要跟秒数 · 用法: /help run';
const TIMEOUT_RANGE = '⚠️ 超时秒数要在 1–600 之间 · 用法: /help run';

/**
 * 只认命令前面的开关：`--timeout`（`-t`）取值，第一个位置参数起到行尾是命令原文。
 * `--` 之后不再解析参数，命令本身以 `-` 开头时用它隔开。
 */
const RUN_SPEC: ParseSpec = {
  command: 'run',
  terminator: true,
  rest: true,
  flags: [{ name: 'timeout', alias: 't', value: true, missing: TIMEOUT_MISSING }],
};

/** /run — 在当前目录执行一条本地命令 */
export function runCommand({ config, logger }: CommandDeps): SlashCommand {
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
      return { kind: 'noop' as const };
    },
  };
}

/** 解析 `/run` 的参数（导出给单测） */
export function parseRunArgs(raw: string): RunParse {
  const parsed = parseArgs(raw, RUN_SPEC);
  if (parsed.error !== undefined) return { ok: false, text: parsed.error };

  // 载荷：第一个位置参数起到行尾，原样交给 shell
  const command = (parsed.rest ?? '').trim();
  if (command === '') return { ok: false, text: '⚠️ 缺少要执行的命令 · 用法: /help run' };

  const seconds = parsed.values.get('timeout');
  if (seconds === undefined) return { ok: true, request: { command, timeoutMs: DEFAULT_TIMEOUT_MS } };

  const timeoutMs = /^\d+$/.test(seconds) ? Number(seconds) * 1_000 : Number.NaN;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
    return { ok: false, text: TIMEOUT_RANGE };
  }
  return { ok: true, request: { command, timeoutMs } };
}

/** 取根目录 → 执行 → 渲染 */
async function execute(config: CommandDeps['config'], request: RunRequest, logger: Logger | undefined): Promise<string> {
  const directory = execRoot();
  const shell = shellSpecOf(config);
  const started = Date.now();
  let result: LocalExecResult;
  try {
    result = await runLocalCommand(shell, {
      command: request.command,
      cwd: directory,
      timeoutMs: request.timeoutMs,
    });
  } catch (err) {
    const message = errorMessage(err);
    logger?.warn(`/run 执行失败: ${message}`);
    return `❌ 执行失败: ${message}`;
  }
  const elapsed = Date.now() - started;

  return renderRun(request.command, directory, shell, elapsed, result);
}

/** 渲染成「首行结论 + 字段行 + 输出块」 */
function renderRun(
  command: string,
  directory: string,
  shell: ShellSpec,
  elapsedMs: number,
  result: LocalExecResult,
): string {
  const head = [
    headline(elapsedMs, result),
    command.includes('\n') ? `**命令**:\n${fence(command)}` : `**命令**: ${inlineCode(command)}`,
    `**目录**: ${inlineCode(directory)}`,
    `**Shell**: ${inlineCode([shell.file, ...shell.args].join(' '))}`,
  ];

  return [head.join('\n'), ...outputBlocks(result)].join('\n\n');
}

/** 首行结论：成功 / 失败 / 超时，都带耗时 */
function headline(elapsedMs: number, result: LocalExecResult): string {
  if (result.timedOut) {
    return `❌ 执行超时 · 已中止 · ${formatDuration(result.timeoutMs || elapsedMs)}`;
  }
  if (result.exitCode === 0) return `✅ 执行完成 · 退出码 0 · ${formatDuration(elapsedMs)}`;
  return `❌ 执行失败 · 退出码 ${result.exitCode ?? '无'} · ${formatDuration(elapsedMs)}`;
}

/** 毫秒 → 人读的耗时（1 秒以下给毫秒，够用且不丢精度） */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

/** 输出块：stdout 有内容就不加标签；两路都有、或只有 stderr 时标明来源 */
function outputBlocks(result: LocalExecResult): string[] {
  const hasStdout = hasBody(result.stdout);
  const hasStderr = hasBody(result.stderr);
  if (!hasStdout && !hasStderr) return ['（没有输出）'];

  const blocks: string[] = [];
  if (hasStdout) {
    const body = renderStream(result.stdout);
    blocks.push(hasStderr ? `**stdout**:\n${body}` : body);
  }
  if (hasStderr) blocks.push(`**stderr**:\n${renderStream(result.stderr)}`);
  return blocks;
}

function hasBody(output: LocalExecStream): boolean {
  return output.text.trim() !== '';
}

/** 一路输出：代码块 + 截断说明 */
function renderStream(output: LocalExecStream): string {
  const text = output.text.replace(/\s+$/, '');
  const clipped = text.length > MAX_OUTPUT_CHARS;
  const body = clipped ? text.slice(-MAX_OUTPUT_CHARS) : text;

  const parts = [fence(body)];
  if (clipped) parts.push('…（已截断 · 只显示末尾）');
  if (output.truncated) parts.push('> 💡 只保留了输出末尾');
  return parts.join('\n');
}

/** 代码块围栏：正文里出现更长的反引号串时自动加长，避免提前闭合 */
function fence(text: string): string {
  let ticks = '```';
  while (text.includes(ticks)) ticks += '`';
  return `${ticks}text\n${text}\n${ticks}`;
}

/** 行内代码：内容里有反引号时用双反引号包住 */
function inlineCode(value: string): string {
  const ticks = value.includes('`') ? '``' : '`';
  return `${ticks}${value}${ticks}`;
}
