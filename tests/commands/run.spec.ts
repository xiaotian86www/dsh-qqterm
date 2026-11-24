/**
 * /run 命令：取参、根目录来源与结果渲染
 *
 * 执行面（shell/local-exec.ts）用假的 runLocalCommand，不真起进程；execRoot 与
 * shellSpecOf 走真实实现，根目录由 process.cwd() 决定。输出走 markdown 通道，
 * 断言看捕获到的文本。不碰真实 ~/.dsh。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type QQTermConfig } from '../../src/config.ts';
import type { SessionManager } from '../../src/session/index.ts';
import type { Logger } from '../../src/types.ts';
import type { CommandDeps } from '../../src/commands/types.ts';
import { buildCommandList } from '../../src/commands/index.ts';
import { displayArg, parseRunArgs, runCommand } from '../../src/commands/run.ts';
import {
  buildShellArgv,
  runLocalCommand,
  shellSpecOf,
  type LocalExecResult,
} from '../../src/shell/local-exec.ts';

const state = vi.hoisted(() => ({ sent: [] as string[] }));

vi.mock('../../src/shared/send-helper.ts', () => ({
  sendMarkdownChunked: async (_ctx: unknown, content: string): Promise<void> => {
    state.sent.push(content);
  },
}));

// 只换掉真正起进程的那一步：execRoot / shellSpecOf 仍是真实现
vi.mock('../../src/shell/local-exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shell/local-exec.ts')>();
  return { ...actual, runLocalCommand: vi.fn() };
});

const spawn = vi.mocked(runLocalCommand);
const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

let root = '';
let cwdSpy: ReturnType<typeof vi.spyOn>;

/** 命令的根目录就是宿主进程当前目录（与会话无关） */
function makeConfig(): QQTermConfig {
  return ConfigSchema({
    appId: 'app',
    appSecret: 'secret',
    access: { owner: 'user1' },
  } as QQTermConfig);
}

function resultOf(patch: Partial<LocalExecResult> = {}): LocalExecResult {
  return {
    exitCode: 0,
    timedOut: false,
    timeoutMs: 120_000,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    ...patch,
  };
}

function makeCtx(raw: string, senderId = 'user1'): SlashCommandHandlerContext {
  return {
    message: { senderId, kind: 'c2c', messageId: 'm1' },
    command: { raw },
  } as unknown as SlashCommandHandlerContext;
}

/** 跑一次命令，返回真正发出去的文本与交给执行面的入参 */
async function run(raw = '"echo hi"'): Promise<{ text: string; request: Record<string, unknown> | undefined }> {
  state.sent.length = 0;
  spawn.mockClear();
  const command = runCommand({ config: makeConfig(), logger });
  const result = await command.handler(makeCtx(raw));
  expect(result).toEqual({ kind: 'noop' });
  return {
    text: state.sent.at(-1) ?? '',
    request: spawn.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined,
  };
}

/** 回执里「最终真正执行的命令」那一行 */
function invokedOf(command: string): string {
  const shell = shellSpecOf(makeConfig());
  // 与回执同一个显示规则：POSIX shell 的 -c 载荷不带引号，展示时才括起来
  return [shell.file, ...buildShellArgv(shell, command)].map(displayArg).join(' ');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qqterm-run-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root);
  spawn.mockReset();
  spawn.mockResolvedValue(resultOf());
  vi.mocked(logger.warn).mockClear();
  state.sent.length = 0;
});

afterEach(() => {
  cwdSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe('/run 命令声明', () => {
  it('只允许私聊，且要求白名单', () => {
    const command = runCommand({ config: makeConfig(), logger });
    expect(command.name).toBe('run');
    expect(command.scope).toBe('c2c');
    const allowed = command.authorized as (ctx: { message: { senderId?: string } }) => boolean | string;
    expect(allowed({ message: { senderId: 'stranger' } })).toBeTypeOf('string');
    expect(allowed({ message: { senderId: 'user1' } })).toBe(true);
  });
});

describe('/run 注册条件', () => {
  it('不依赖宿主能力：没有 shell 服务也照常注册', () => {
    /** 只要属性够读，不关心真实行为 */
    const stubManager = new Proxy({}, { get: () => vi.fn() }) as unknown as SessionManager;
    const deps: CommandDeps = { manager: stubManager, config: makeConfig(), logger };
    expect(buildCommandList(deps).map((command) => command.name)).toContain('run');
  });
});

describe('/run 执行', () => {
  it('成功：首行给退出码与耗时，正文给命令、目录与输出', async () => {
    spawn.mockResolvedValue(resultOf({ stdout: { text: 'hello\nworld\n', truncated: false } }));
    const { text, request } = await run('"echo hello"');

    expect(text.startsWith('✅ 执行完成 · 退出码 0 · ')).toBe(true);
    // 命令与 shell 合成一条：这行就是最终真正执行的命令
    expect(text).toContain('**命令**: `' + invokedOf('echo hello') + '`');
    expect(text).toContain(`**目录**: \`${root}\``);
    expect(text).not.toContain('**Shell**');
    expect(text).toContain('```text');
    expect(text).toContain('hello\nworld');
    expect(text).not.toContain('**stderr**');
    expect(request).toMatchObject({ command: 'echo hello', cwd: root, timeoutMs: 120_000 });
  });

  it('引号里的整条命令原样交给 shell：管道与 && 不被拆开', async () => {
    const { text, request } = await run('"echo a b && ls | wc -l"');

    expect(request).toMatchObject({ command: 'echo a b && ls | wc -l' });
    expect(text).toContain(invokedOf('echo a b && ls | wc -l'));
  });

  it('单引号包住的命令可带双引号，整段仍是命令的一部分', async () => {
    const { request } = await run("'echo \"a b\"'");

    expect(request).toMatchObject({ command: 'echo "a b"' });
  });

  it('多给一个词按参数格式错误回绝，不执行也不拼回字符串', async () => {
    const { text } = await run('echo hello');

    expect(text).toContain('只能给一条命令');
    expect(text).toContain('用法: /help run');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('失败：退出码非 0，stderr 单独标注', async () => {
    spawn.mockResolvedValue(resultOf({ exitCode: 2, stderr: { text: 'boom\n', truncated: false } }));
    const { text } = await run('"false"');

    expect(text.startsWith('❌ 执行失败 · 退出码 2 · ')).toBe(true);
    expect(text).toContain('**stderr**:');
    expect(text).toContain('boom');
  });

  it('超时：按执行面给的超时时间标注已中止', async () => {
    spawn.mockResolvedValue(resultOf({ timedOut: true, exitCode: null, timeoutMs: 5_000 }));
    const { text } = await run('"sleep 100"');

    expect(text.startsWith('❌ 执行超时 · 已中止 · 5.0s')).toBe(true);
  });

  it('没有输出时写明', async () => {
    const { text } = await run('"true"');
    expect(text).toContain('（没有输出）');
  });

  it('超长输出只显示末尾 3000 字符并标明截断', async () => {
    spawn.mockResolvedValue(resultOf({ stdout: { text: 'a'.repeat(4_000), truncated: false } }));
    const { text } = await run('"true"');

    expect(text).toContain('…（已截断 · 只显示末尾）');
    expect(text).not.toContain('a'.repeat(4_001));
    expect(text).toContain('a'.repeat(3_000));
  });

  it('执行面先截断时说明只留了末尾', async () => {
    spawn.mockResolvedValue(resultOf({ stdout: { text: 'tail', truncated: true } }));
    const { text } = await run('"true"');

    expect(text).toContain('> 💡 只保留了输出末尾');
  });

  it('起不了进程时如实说失败并 warn', async () => {
    spawn.mockRejectedValue(new Error('spawn EPERM'));
    const { text } = await run('"ls"');

    expect(text).toContain('❌ 执行失败: spawn EPERM');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('--timeout 改超时并传给执行面', async () => {
    const { request } = await run('--timeout 30 "npm test"');

    expect(request).toMatchObject({ command: 'npm test', timeoutMs: 30_000 });
  });

  it('命令写在 -- 之后：整段原样交给 shell，- 开头的参数也不当参数', async () => {
    const { request } = await run('-- ls -la');

    expect(request).toMatchObject({ command: 'ls -la' });
  });

  it('-- 之后整段是命令：管道与 && 不用再包一层引号', async () => {
    const { request } = await run('-- echo "a b" && ls | wc -l');

    expect(request).toMatchObject({ command: 'echo "a b" && ls | wc -l' });
  });

  it('命令前写错参数时不执行，回未知参数', async () => {
    const { text } = await run('--nope "ls"');

    expect(text).toContain('未知参数: --nope');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('没加引号的 - 开头命令按参数识别，报未知参数', async () => {
    const { text } = await run('-la');

    expect(text).toContain('未知参数: -la');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('渲染里的命令由配置那把 shell 拼出来，没有额外的沙箱行', async () => {
    const config = makeConfig();
    state.sent.length = 0;
    const command = runCommand({ config, logger });
    await command.handler(makeCtx('"true"'));
    const text = state.sent.at(-1) ?? '';
    expect(text).toContain(invokedOf('true'));
    expect(text).not.toContain('**沙箱**');
  });
});

describe('parseRunArgs', () => {
  function rejectText(raw: string): string {
    const parsed = parseRunArgs(raw);
    expect(parsed.ok).toBe(false);
    return (parsed as { text: string }).text;
  }

  it('整条命令是一个位置参数，默认 120 秒', () => {
    expect(parseRunArgs('"ls -la"')).toEqual({
      ok: true,
      request: { command: 'ls -la', timeoutMs: 120_000 },
    });
  });

  it('一个词不加引号也行', () => {
    expect(parseRunArgs('dir')).toEqual({ ok: true, request: { command: 'dir', timeoutMs: 120_000 } });
  });

  it('多出来的词按参数格式错误回绝，不重拼', () => {
    expect(rejectText('ls foo')).toContain('只能给一条命令');
    expect(rejectText('echo "a b"')).toContain('只能给一条命令');
  });

  it('--timeout 的几种写法都认，且不留在命令里', () => {
    for (const raw of ['--timeout=30 "npm test"', '--timeout 30 "npm test"', '-t 30 "npm test"']) {
      expect(parseRunArgs(raw)).toEqual({
        ok: true,
        request: { command: 'npm test', timeoutMs: 30_000 },
      });
    }
  });

  it('命令里的 --timeout 属于命令本身：整段用引号包住即可', () => {
    expect(parseRunArgs('"ls --timeout 30"')).toEqual({
      ok: true,
      request: { command: 'ls --timeout 30', timeoutMs: 120_000 },
    });
  });

  it('-- 之后整段是命令：多词、管道、- 开头的参数都原样', () => {
    expect(parseRunArgs('-- -la')).toEqual({ ok: true, request: { command: '-la', timeoutMs: 120_000 } });
    expect(parseRunArgs('-- echo hi')).toEqual({ ok: true, request: { command: 'echo hi', timeoutMs: 120_000 } });
    expect(parseRunArgs('-- ls -la | sort')).toEqual({
      ok: true,
      request: { command: 'ls -la | sort', timeoutMs: 120_000 },
    });
    expect(parseRunArgs('--timeout 30 -- npm test -- --watch')).toEqual({
      ok: true,
      request: { command: 'npm test -- --watch', timeoutMs: 30_000 },
    });
  });

  it('-- 之后整段被一对引号包住时去掉这对引号，中间的引号原样', () => {
    expect(parseRunArgs('--timeout 30 -- "npm test"')).toEqual({
      ok: true,
      request: { command: 'npm test', timeoutMs: 30_000 },
    });
    expect(parseRunArgs('-- echo "a b"')).toEqual({
      ok: true,
      request: { command: 'echo "a b"', timeoutMs: 120_000 },
    });
    expect(parseRunArgs('-- "a" "b"')).toEqual({
      ok: true,
      request: { command: '"a" "b"', timeoutMs: 120_000 },
    });
  });

  it('-- 之前再给词是写错，不静默丢弃', () => {
    expect(rejectText('echo hi -- echo there')).toBe('⚠️ 只能给一条命令 · 有空格就用引号包起来，或写到 -- 之后 · 用法: /help run');
  });

  it('-- 之后为空回缺命令', () => {
    expect(rejectText('-- ')).toContain('缺少要执行的命令');
    expect(rejectText('--timeout 30 --')).toContain('缺少要执行的命令');
  });

  it('命令前认不出的参数回未知参数', () => {
    expect(rejectText('--nope "ls"')).toContain('未知参数: --nope');
    expect(rejectText('-la')).toContain('未知参数: -la');
  });

  it('空命令回用法', () => {
    expect(rejectText('')).toContain('缺少要执行的命令');
    expect(rejectText('   ')).toContain('缺少要执行的命令');
    expect(rejectText('--')).toContain('缺少要执行的命令');
  });

  it('秒数不对时回取值范围', () => {
    expect(rejectText('--timeout abc "ls"')).toContain('1–600');
    expect(rejectText('--timeout 0 "ls"')).toContain('1–600');
    expect(rejectText('--timeout 601 "ls"')).toContain('1–600');
  });

  it('缺秒数回用法，只有开关没命令另说', () => {
    expect(rejectText('--timeout')).toContain('要跟秒数');
    expect(rejectText('--timeout=')).toContain('要跟秒数');
    expect(rejectText('--timeout 30')).toContain('缺少要执行的命令');
  });

  it('最长 600 秒可用', () => {
    expect(parseRunArgs('--timeout 600 dir')).toEqual({
      ok: true,
      request: { command: 'dir', timeoutMs: 600_000 },
    });
  });
});
