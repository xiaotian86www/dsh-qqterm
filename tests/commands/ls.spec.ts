/**
 * /ls 命令：列子目录与文件、可点击条目
 *
 * 用真实临时目录（不碰真实 ~/.dsh）；根目录由 process.cwd() 决定，与会话无关。
 * 输出走 markdown 通道，断言看捕获到的文本。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type QQTermConfig } from '../../src/config.ts';
import type { Logger } from '../../src/types.ts';
import { lsCommand, resolveLsTarget } from '../../src/commands/ls.ts';

const state = vi.hoisted(() => ({ sent: [] as string[] }));

vi.mock('../../src/shared/send-helper.ts', () => ({
  sendMarkdownChunked: async (_ctx: unknown, content: string): Promise<void> => {
    state.sent.push(content);
  },
}));

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

function makeCtx(raw: string, senderId = 'user1'): SlashCommandHandlerContext {
  return {
    message: { senderId, kind: 'c2c', messageId: 'm1' },
    command: { raw },
  } as unknown as SlashCommandHandlerContext;
}

async function run(raw = '', senderId = 'user1'): Promise<string> {
  state.sent.length = 0;
  const command = lsCommand({ config: makeConfig(), logger });
  const result = await command.handler(makeCtx(raw, senderId));
  expect(result).toEqual({ kind: 'noop' });
  return state.sent.at(-1) ?? '';
}

/** 一个条目的按钮标签 */
function buttonText(command: string, show: string): string {
  return `<qqbot-cmd-input text="${command}" show="${show}"/>`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qqterm-ls-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root);
  for (const name of ['alpha', 'beta', 'zeta']) mkdirSync(join(root, name));
  mkdirSync(join(root, 'alpha', 'inner'));
  writeFileSync(join(root, 'gamma.txt'), 'x');
  state.sent.length = 0;
});

afterEach(() => {
  cwdSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe('/ls 命令声明', () => {
  it('只允许私聊，且要求白名单', () => {
    const command = lsCommand({ config: makeConfig(), logger });
    expect(command.name).toBe('ls');
    expect(command.scope).toBe('c2c');
    const allowed = command.authorized as (ctx: { message: { senderId?: string } }) => boolean | string;
    expect(allowed({ message: { senderId: 'stranger' } })).toBeTypeOf('string');
    expect(allowed({ message: { senderId: 'user1' } })).toBe(true);
  });
});

describe('/ls（当前目录）', () => {
  it('标题带目录名与绝对路径', async () => {
    const text = await run();
    expect(text).toContain(`### 📁 ${basename(root)} · \`${root}\``);
  });

  it('路径带空格时用引号包起来也能解析', async () => {
    const text = await run(`"${join(root, 'alpha')}"`);
    expect(text).toContain(`### 📁 alpha · \`${join(root, 'alpha')}\``);
  });

  it('不显示 `.` 与 `..`（按钮太窄，点起来费劲）', async () => {
    const text = await run();
    expect(text).not.toContain('show="."');
    expect(text).not.toContain('show=".."');
    // 回上一级直接写路径，不再有固定条目
    expect(text).not.toContain(buttonText(`/ls ${dirname(root)}`, '..'));
    expect(text).not.toContain(buttonText(`/ls ${root}`, '.'));
  });

  it('目录在前、文件在后，各按名字排序', async () => {
    const text = await run();
    const alpha = text.indexOf('show="alpha"');
    const beta = text.indexOf('show="beta"');
    const zeta = text.indexOf('show="zeta"');
    const gamma = text.indexOf('show="gamma.txt"');
    expect(alpha).toBeGreaterThan(-1);
    expect(alpha).toBeLessThan(beta);
    expect(beta).toBeLessThan(zeta);
    expect(zeta).toBeLessThan(gamma);
    expect(gamma).toBeGreaterThan(-1);
  });

  it('文件条目点下去填的是 /get', async () => {
    const text = await run();
    expect(text).toContain(buttonText(`/get ${join(root, 'gamma.txt')}`, 'gamma.txt'));
  });

  it('每个条目点下去填的是绝对路径的 /ls', async () => {
    const text = await run();
    expect(text).toContain(buttonText(`/ls ${join(root, 'beta')}`, 'beta'));
  });

  it('空目录明确说明', async () => {
    mkdirSync(join(root, 'empty'));
    const text = await run('empty');
    expect(text).toContain('（这里是空的）');
  });

  it('超过上限时说明还有多少没列', async () => {
    mkdirSync(join(root, 'many'));
    for (let index = 0; index < 42; index += 1) {
      mkdirSync(join(root, 'many', `d${String(index).padStart(2, '0')}`));
    }
    const text = await run('many');
    expect(text).toContain('还有 2 个条目，');
  });
});

describe('/ls <路径>', () => {
  it('相对路径按当前目录解析', async () => {
    const text = await run('alpha');
    expect(text).toContain(`### 📁 alpha · \`${join(root, 'alpha')}\``);
    expect(text).toContain(buttonText(`/ls ${join(root, 'alpha', 'inner')}`, 'inner'));
  });

  it('输出里没有额外的操作提示', async () => {
    const text = await run();
    expect(text).not.toContain('/new');
  });

  it('目录不存在', async () => {
    const text = await run('nope');
    expect(text).toContain(`目录不存在: \`${join(root, 'nope')}\``);
  });

  it('目标是文件时报「不是目录」', async () => {
    const text = await run('gamma.txt');
    expect(text).toContain(`不是目录: \`${join(root, 'gamma.txt')}\``);
  });

  it('绝对路径直接可用', async () => {
    const text = await run(join(root, 'zeta'));
    expect(text).toContain(`### 📁 zeta · \`${join(root, 'zeta')}\``);
  });

  it('当前目录换了，相对路径跟着换', async () => {
    cwdSpy.mockReturnValue(join(root, 'alpha'));
    const text = await run('');
    expect(text).toContain(`### 📁 alpha · \`${join(root, 'alpha')}\``);
    expect(text).toContain(buttonText(`/ls ${join(root, 'alpha', 'inner')}`, 'inner'));
  });
});

describe('resolveLsTarget', () => {
  const base = join(tmpdir(), 'some-root');

  it('空参数回到根目录', () => {
    expect(resolveLsTarget(base, '')).toBe(resolve(base));
  });

  it('相对路径按根目录解析', () => {
    expect(resolveLsTarget(base, 'alpha')).toBe(resolve(base, 'alpha'));
  });

  it('绝对路径原样保留', () => {
    expect(resolveLsTarget(base, root)).toBe(resolve(root));
  });

  it('~ 展开成 home', () => {
    expect(resolveLsTarget(base, '~')).toBe(homedir());
    expect(resolveLsTarget(base, '~/projects')).toBe(resolve(homedir(), 'projects'));
  });
});
