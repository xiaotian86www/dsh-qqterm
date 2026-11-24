/**
 * 本地执行面：根目录、shell 选择、参数拼装与真起进程
 *
 * 拼装部分是纯函数；执行部分用 node 自己当 shell（`-e {command}`），跑的是当前
 * 解释器，不碰真实 ~/.dsh、不联网。
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
const nodeShell = { file: process.execPath, args: ['-e', '{command}'] } as const;

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
    // 默认值由 Schema 写进配置，这里只是读它，不在运行期另算一份。
    const shell = shellSpecOf(cfg());
    if (isWindows) {
      expect(shell.file.toLowerCase()).toContain('cmd');
      expect(shell.args).toEqual(['/d', '/s', '/c']);
    } else {
      expect(shell).toEqual({ file: '/bin/sh', args: ['-c', 'exec "$@"', 'sh'] });
    }
  });

  it('配置了 shell 就用它，参数按配置字面用', () => {
    expect(shellSpecOf(cfg({ shell: '/bin/zsh', shellArgs: ['-c'] }))).toEqual({
      file: '/bin/zsh',
      args: ['-c'],
    });
  });

  it('把 shell 清空就是空，不回落到平台默认值', () => {
    expect(shellSpecOf(cfg({ shell: '' })).file).toBe('');
    // 参数同样只读配置：空也是空，不按 shell 推导。
    expect(shellSpecOf(cfg({ shell: '', shellArgs: [] })).args).toEqual([]);
  });

  it('换 shell 不改参数：配置里是哪组就用哪组', () => {
    expect(shellSpecOf(cfg({ shell: '/bin/bash' })).args).toEqual(isWindows ? ['/d', '/s', '/c'] : ['-c', 'exec "$@"', 'sh']);
    expect(shellSpecOf(cfg({ shell: '/bin/bash', shellArgs: [] })).args).toEqual([]);
  });

  it('配置了参数模板就原样用', () => {
    expect(shellSpecOf(cfg({ shell: '/bin/zsh', shellArgs: ['-l', '-c', '{command}'] }))).toEqual({
      file: '/bin/zsh',
      args: ['-l', '-c', '{command}'],
    });
  });

  it('空字符串参数也照原样传，不被悄悄丢掉', () => {
    expect(shellSpecOf(cfg({ shell: '/bin/zsh', shellArgs: ['', '-c'] })).args).toEqual(['', '-c']);
  });

  it('换成 cmd 时也只读配置：不再自动判它要不要加引号', () => {
    expect(shellSpecOf(cfg({ shell: 'cmd.exe', shellArgs: ['/d', '/s', '/c'] }))).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c'],
    });
  });
});

describe('buildShellArgv', () => {
  it('没有占位符时命令词追加在末尾，一个词一个参数', () => {
    expect(buildShellArgv({ file: '/bin/sh', args: ['-c'] }, ['echo', 'hi'])).toEqual(['-c', 'echo', 'hi']);
  });

  it('{command} 独占一个参数时，原位展开成命令词', () => {
    expect(buildShellArgv({ file: process.execPath, args: ['-e', '{command}'] }, ['x'])).toEqual(['-e', 'x']);
  });

  it('{command} 嵌在参数里时，原位换成用空格连起来的命令词', () => {
    expect(buildShellArgv({ file: 'zsh', args: ['--cmd={command}'] }, ['echo', 'hi'])).toEqual(['--cmd=echo hi']);
  });

  it('cmd 不额外加引号：每个词照旧是一个参数', () => {
    expect(buildShellArgv({ file: 'cmd.exe', args: ['/d', '/s', '/c'] }, ['echo', 'hi'])).toEqual([
      '/d',
      '/s',
      '/c',
      'echo',
      'hi',
    ]);
  });

  it('没有命令词时只剩模板', () => {
    expect(buildShellArgv({ file: 'cmd.exe', args: ['/c'] }, [])).toEqual(['/c']);
  });
});

describe('runLocalCommand（真起进程）', () => {
  it('收集 stdout 与退出码', async () => {
    const result = await runLocalCommand(nodeShell, {
      argv: ["process.stdout.write('hi')"],
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
      argv: ['process.exit(3)'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(3);
  });

  it('stderr 单独收集', async () => {
    const result = await runLocalCommand(nodeShell, {
      argv: ["process.stderr.write('bad')"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(result.stderr.text).toBe('bad');
  });

  it('超时中止进程并标注', async () => {
    const result = await runLocalCommand(nodeShell, {
      argv: ['setTimeout(() => {}, 60_000)'],
      cwd: process.cwd(),
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  });

  it('超过上限只留末尾并标注截断', async () => {
    const result = await runLocalCommand(nodeShell, {
      argv: ["process.stdout.write('x'.repeat(100_000))"],
      cwd: process.cwd(),
      timeoutMs: 20_000,
    });
    expect(result.stdout.truncated).toBe(true);
    expect(result.stdout.text.length).toBeLessThanOrEqual(64 * 1024);
    expect(result.stdout.text).toMatch(/^x+$/);
  });

  it('shell 没配置时直接报错，不猜一个默认 shell 出来', async () => {
    await expect(
      runLocalCommand({ file: '', args: [] }, { argv: ['echo', 'hi'], cwd: process.cwd(), timeoutMs: 5_000 }),
    ).rejects.toThrow('没有配置 shell');
  });

  it('shell 起不来时抛错，交给调用方兜', async () => {
    await expect(
      runLocalCommand(
        { file: 'qqterm-no-such-shell-xyz', args: [] },
        { argv: ['echo', 'hi'], cwd: process.cwd(), timeoutMs: 5_000 },
      ),
    ).rejects.toBeTruthy();
  });
});
