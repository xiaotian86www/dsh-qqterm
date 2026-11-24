/**
 * 本地命令执行面：`/run` 用，插件自己起进程
 *
 * `/run`、`/ls`、`/get` 是同一组扩展功能——在 QQ 里远程操作这台电脑——因此
 * 不经过宿主的能力面：工作目录是宿主进程的当前目录，shell 默认操作系统自带的那个，
 * 可以在配置里换。执行环境与宿主无关，也不受宿主沙箱与权限策略影响：命令是用户亲手
 * 打出来的，后果由用户承担。
 *
 * 命令按命令行约定切成词（args.ts 的 tokenize），词数组原样交给 shell（Linux 的
 * argv 语义）：插件不把词拼回一条字符串，也不预先解释管道与 `&&`——那是 shell 的
 * 事，由它在自己的命令行里解释。
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { QQTermConfig } from '../config.ts';

/** 每路输出最多收集多少字节（只留末尾：几万字符在手机上翻不完） */
const MAX_STREAM_BYTES = 64 * 1024;

/** 一路输出 */
export interface LocalExecStream {
  readonly text: string;
  readonly truncated: boolean;
}

/** 一次执行的完整结果 */
export interface LocalExecResult {
  /** 退出码（null = 没等到正常退出：超时、信号终止或启动失败） */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** 生效的超时毫秒数 */
  readonly timeoutMs: number;
  readonly stdout: LocalExecStream;
  readonly stderr: LocalExecStream;
}

/** 这次执行用的 shell：可执行文件 + 参数模板（命令词接在模板后面） */
export interface ShellSpec {
  readonly file: string;
  /** 参数模板；命令词要么原位展开到 `{command}`，要么追加在末尾 */
  readonly args: readonly string[];
}

/** 参数模板里的命令占位符 */
const COMMAND_PLACEHOLDER = '{command}';

/**
 * 根目录：`/run` 的工作目录，`/ls`、`/get` 的相对路径基准。
 *
 * 就是宿主进程的当前目录——三个命令共用这一个事实，不配置、也不跟会话的工作区或
 * 运行目录走：远程操作这台电脑时，人期望的基准是「dsh 启动时所在的位置」。
 */
export function execRoot(): string {
  return resolve(process.cwd());
}

/**
 * 这次执行用哪个 shell：完全按配置来，不在运行期补默认值。
 *
 * 平台默认值由 Schema 写进配置（看得见、改得动）；用户把它清空就是清空——这里不
 * 私自回落到平台默认，也不替用户推导参数。空 shell 在起进程前按配置错误报出来。
 */
export function shellSpecOf(config: QQTermConfig): ShellSpec {
  return { file: config.exec?.shell ?? '', args: config.exec?.shellArgs ?? [] };
}

/**
 * 拼出真正交给 spawn 的参数：模板在前，命令词原样接在后面（或原位展开 `{command}`）。
 *
 * 每个命令词始终是一个独立的参数，插件不做引号包装与转义——需要的话由 node 的
 * spawn 在系统边界上按平台规则处理，比插件自己拼一条字符串更不容易出错。
 */
export function buildShellArgv(shell: ShellSpec, argv: readonly string[]): string[] {
  const hasPlaceholder = shell.args.some((arg) => arg.includes(COMMAND_PLACEHOLDER));
  const expanded = shell.args.flatMap((arg) =>
    arg === COMMAND_PLACEHOLDER ? [...argv] : [arg.split(COMMAND_PLACEHOLDER).join(argv.join(' '))],
  );
  return hasPlaceholder ? expanded : [...expanded, ...argv];
}

/** 跑一条命令：不抛错的路只有「进程跑起来了」，起不来按异常交给调用方 */
export function runLocalCommand(
  shell: ShellSpec,
  request: { readonly argv: readonly string[]; readonly cwd: string; readonly timeoutMs: number },
): Promise<LocalExecResult> {
  // 配置清空就是清空：不回落默认值，也不猜一个 shell 出来
  if (shell.file === '') return Promise.reject(new Error('没有配置 shell'));

  return new Promise<LocalExecResult>((resolveResult, rejectResult) => {
    const stdout = createStream();
    const stderr = createStream();
    let timedOut = false;
    let settled = false;

    const child = spawn(shell.file, buildShellArgv(shell, request.argv), {
      cwd: request.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // POSIX 上单独成组：超时才能把整棵进程树一起杀掉
      detached: process.platform !== 'win32',
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, request.timeoutMs);

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        exitCode,
        timedOut,
        timeoutMs: request.timeoutMs,
        stdout: stdout.read(),
        stderr: stderr.read(),
      });
    };

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectResult(err);
    });
    child.on('close', (code) => finish(code));
  });
}

/** 超时中止：Windows 上没有进程组，只能让 taskkill 按树杀 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // 进程可能已经自己退出了
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 同上
    }
  }
}

/** 收集一路输出：只留末尾 MAX_STREAM_BYTES 字节 */
function createStream(): { push(chunk: Buffer): void; read(): LocalExecStream } {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;

  return {
    push(chunk) {
      chunks.push(chunk);
      size += chunk.length;
      while (size > MAX_STREAM_BYTES && chunks.length > 0) {
        const head = chunks[0];
        if (head === undefined) break;
        const excess = size - MAX_STREAM_BYTES;
        if (head.length <= excess) {
          chunks.shift();
          size -= head.length;
        } else {
          chunks[0] = head.subarray(excess);
          size -= excess;
        }
        truncated = true;
      }
    },
    read() {
      return { text: decodeOutput(Buffer.concat(chunks)), truncated };
    },
  };
}

/**
 * 字节 → 文本。
 *
 * Windows 控制台按 OEM 代码页输出（中文是 GBK），直接当 UTF-8 读会出一串 U+FFFD；
 * 先按 UTF-8 解，出现替换字符再试 GBK，能解就用 GBK 的。
 */
function decodeOutput(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  if (!text.includes('\uFFFD')) return text;
  return decodeWith('gbk', bytes) ?? text;
}

function decodeWith(label: string, bytes: Buffer): string | undefined {
  try {
    const text = new TextDecoder(label).decode(bytes);
    return text.includes('\uFFFD') ? undefined : text;
  } catch {
    return undefined;
  }
}
