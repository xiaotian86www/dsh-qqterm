/**
 * 本地执行面：根目录、shell 选择、参数拼装与真起进程
 *
 * 拼装部分是纯函数；执行部分用 node 自己当 shell（`-e {command}`），跑的是当前
 * 解释器，不碰真实 ~/.dsh、不联网。cmd 的 verbatim 分支在 Windows 上用真 cmd 验证。
 */
import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { buildShellArgv, execRoot, runLocalCommand, shellSpecOf } from '../../src/shell/local-exec.ts';
import { ConfigSchema } from '../../src/config.ts';

/** 只关心 exec 段，其余走默认 */
function cfg(exec: Record<string, unknown> = {}) {
  return ConfigSchema({ exec });
}

/** 拿 node 当 shell：命令是一段 JS，作为 `-e` 的值 */
const nodeShell = { file: process.execPath, args: ['-e', '{command}'], verbatim: false } as const;

const isWindows = process.platform === 'win32';

describe('execRoot', () => {
  it('就是宿主进程的当前目录', () => {
    expect(execRoot()).toBe(resolve(process.cwd()));
  });

  it('每次现读，不缓存启动时的值', () => {
    const spy = vi.spyOn(process, 'cwd').mockReturnValue('/some/where');
    try {
      expect(execRoot()).toBe(resolve('/some/where'));
    } finally {
      spy.mockRestore();
    }
  });
});

describe('shellSpecOf', () => {
  it('没写 exec 时按配置里的平台默认值用', () => {
    const shell = shellSpecOf(cfg());
    if (isWindows) {
      expect(shell.file.toLowerCase()).toContain('cmd');
      expect(shell.args).toEqual(['/d', '/s', '/c']);
      expect(shell.verbatim).toBe(true);
    } else {
      expect(shell).toEqual({ file: '/bin/sh', args: ['-c'], verbatim: false });
    }
  });

  it('配置了 shell 就用它，参数按配置字面用', () => {
    expect(shellSpecOf(cfg({ shell: '/bin/zsh', shellArgs: ['-c'] }))).toEqual({
      file: '/bin/zsh',
      args: ['-c'],
      verbatim: false,
    });
  });

  it('把 shell 清空就是空，不回落到平台默认值', () => {
    expect(shellSpecOf(cfg({ shell: '' })).file).toBe('');
    expect(shellSpecOf(cfg({ shell: '' })).verbatim).toBe(false);
    expect(shellSpecOf(cfg({ shell: '', shellArgs: [] })).args).toEqual([]);
  });

  it('换 shell 不改参数：配置里是哪组就用哪组', () => {
    const args = shellSpecOf(cfg({ shell: '/bin/bash' })).args;
    expect(args).toEqual(isWindows ? ['/d', '/s', '/c'] : ['-c']);
    expect(shellSpecOf(cfg({ shell: '/bin/bash', shellArgs: [] })).args).toEqual([]);
  });

  it('配置了参数模板就原样用', () => {
    expect(shellSpecOf(cfg({ shell: '/bin/zsh', shellArgs: ['-l', '-c', '{command}'] }))).toEqual({
      file: '/bin/zsh',
      args: ['-l', '-c', '{command}'],
      verbatim: false,
    });
  });

  it('空字符串参数也照原样传，不被悄悄丢掉', () => {
    expect(shellSpecOf(cfg({ shell: '/bin/zsh', shellArgs: ['', '-c'] })).args).toEqual(['', '-c']);
  });

  it('命令行解释器要按原样传参：cmd 判成 verbatim', () => {
    expect(shellSpecOf(cfg({ shell: 'cmd.exe', shellArgs: ['/d', '/s', '/c'] }))).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c'],
      verbatim: true,
    });
    expect(shellSpecOf(cfg({ shell: 'C:\\Windows\\System32\\cmd.exe' })).verbatim).toBe(true);
  });

  it('bash 这类 shell 不按 verbatim 传：命令就是一个普通参数', () => {
    expect(shellSpecOf(cfg({ shell: 'C:\\Program Files\\Git\\bin\\bash.exe' })).verbatim).toBe(false);
  });
});

describe('buildShellArgv', () => {
  it('没有占位符时整条命令追加在末尾，是一个参数', () => {
    expect(buildShellArgv({ file: '/bin/sh', args: ['-c'], verbatim: false }, 'echo hi && ls')).toEqual([
      '-c',
      'echo hi && ls',
    ]);
  });

  it('{command} 独占一个参数时，原位换成整条命令', () => {
    expect(buildShellArgv({ file: process.execPath, args: ['-e', '{command}'], verbatim: false }, 'x')).toEqual([
      '-e',
      'x',
    ]);
  });

  it('{command} 嵌在参数里时，原位换成整条命令', () => {
    expect(buildShellArgv({ file: 'zsh', args: ['--cmd={command}'], verbatim: false }, 'echo hi')).toEqual([
      '--cmd=echo hi',
    ]);
  });

  it('cmd 的命令先包一层引号再原样传：/s /c 只吃一整段', () => {
    expect(buildShellArgv({ file: 'cmd.exe', args: ['/d', '/s', '/c'], verbatim: true }, 'echo "a b" && dir')).toEqual([
      '/d',
      '/s',
      '/c',
      '"echo "a b" && dir"',
    ]);
  });
});

describe('runLocalCommand（真起进程）', () => {
  it('收集 stdout 与退出码', async () => {
    const result = await runLocalCommand(nodeShell, {
      command: "process.stdout.write('hi')",
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toEqual({ text: 'hi', truncated: false });
    expect(result.stderr).toEqual({ text: '', truncated: false });
  });

  it('退出码原样带回', async () => {
    const result = await runLocalCommand(nodeShell, {
      command: 'process.exit(3)',
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(3);
  });

  it('stderr 单独收集', async () => {
    const result = await runLocalCommand(nodeShell, {
      command: "process.stderr.write('bad')",
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(result.stderr.text).toBe('bad');
  });

  it('超时中止进程并标注', async () => {
    const result = await runLocalCommand(nodeShell, {
      command: 'setTimeout(() => {}, 60_000)',
      cwd: process.cwd(),
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  });

  it('超过上限只留末尾并标注截断', async () => {
    const result = await runLocalCommand(nodeShell, {
      command: "process.stdout.write('x'.repeat(100_000))",
      cwd: process.cwd(),
      timeoutMs: 20_000,
    });
    expect(result.stdout.truncated).toBe(true);
    expect(result.stdout.text.length).toBeLessThanOrEqual(64 * 1024);
    expect(result.stdout.text).toMatch(/^x+$/);
  });

  it('shell 没配置时直接报错，不猜一个默认 shell 出来', async () => {
    await expect(
      runLocalCommand({ file: '', args: [], verbatim: false }, { command: 'echo hi', cwd: process.cwd(), timeoutMs: 5_000 }),
    ).rejects.toThrow('没有配置 shell');
  });

  it('shell 起不来时抛错，交给调用方兜', async () => {
    await expect(
      runLocalCommand(
        { file: 'qqterm-no-such-shell-xyz', args: [], verbatim: false },
        { command: 'echo hi', cwd: process.cwd(), timeoutMs: 5_000 },
      ),
    ).rejects.toBeTruthy();
  });

  it.runIf(isWindows)('cmd 按 verbatim 收一整段命令：管道、引号与退出码都对', async () => {
    const shell = { file: process.env.ComSpec?.trim() || 'cmd.exe', args: ['/d', '/s', '/c'], verbatim: true };
    const quoted = await runLocalCommand(shell, {
      command: 'echo "a b" && echo done',
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(quoted.exitCode).toBe(0);
    expect(quoted.stdout.text).toContain('"a b"');
    expect(quoted.stdout.text).toContain('done');

    const failed = await runLocalCommand(shell, { command: 'exit 3', cwd: process.cwd(), timeoutMs: 10_000 });
    expect(failed.exitCode).toBe(3);
  });
});
