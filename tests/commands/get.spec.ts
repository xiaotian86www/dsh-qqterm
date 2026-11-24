/**
 * /get 命令：按扩展名发送文件与失败文案
 *
 * 用真实临时目录（不碰真实 ~/.dsh），根目录由 process.cwd() 决定，bot 只记录调用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type QQTermConfig } from '../../src/config.ts';
import type { Logger } from '../../src/types.ts';
import { getCommand } from '../../src/commands/get.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

let root = '';
let outside = '';
let cwdSpy: ReturnType<typeof vi.spyOn>;

/** 命令的根目录就是宿主进程当前目录（与会话无关） */
function makeConfig(): QQTermConfig {
  return ConfigSchema({
    appId: 'app',
    appSecret: 'secret',
    access: { owner: 'user1' },
  } as QQTermConfig);
}

function makeBot() {
  return {
    sendImage: vi.fn(async () => ({ upload: { file_uuid: 'u1' } })),
    sendVideo: vi.fn(async () => ({ upload: { file_uuid: 'u2' } })),
    sendVoice: vi.fn(async () => ({ upload: { file_uuid: 'u3' } })),
    sendFile: vi.fn(async () => ({ upload: { file_uuid: 'u4' } })),
  };
}

function makeCtx(raw: string): SlashCommandHandlerContext {
  return {
    message: { senderId: 'user1', kind: 'c2c', messageId: 'm1' },
    command: { raw },
    replyTarget: { scope: 'c2c', targetId: 'user1' },
  } as unknown as SlashCommandHandlerContext;
}

async function run(
  bot: ReturnType<typeof makeBot>,
  raw: string,
): Promise<string | { kind: 'noop' }> {
  const command = getCommand({
    config: makeConfig(),
    bot: bot as never,
    logger,
  });
  return (await command.handler(makeCtx(raw))) as string | { kind: 'noop' };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qqterm-get-'));
  outside = mkdtempSync(join(tmpdir(), 'qqterm-get-out-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root);
  writeFileSync(join(root, 'photo.png'), 'png');
  writeFileSync(join(root, 'notes.md'), 'md');
  mkdirSync(join(root, 'docs'));
});

afterEach(() => {
  cwdSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('/get', () => {
  it('图片按图片通道发送', async () => {
    const bot = makeBot();
    const text = await run(bot, 'photo.png');
    expect(text).toEqual({ kind: 'noop' });
    expect(bot.sendImage).toHaveBeenCalledWith(
      { scope: 'c2c', targetId: 'user1' },
      { localPath: join(root, 'photo.png') },
    );
    expect(bot.sendFile).not.toHaveBeenCalled();
  });

  it('其它扩展名走通用文件通道', async () => {
    const bot = makeBot();
    await run(bot, join(root, 'notes.md'));
    expect(bot.sendFile).toHaveBeenCalledWith(
      { scope: 'c2c', targetId: 'user1' },
      { localPath: join(root, 'notes.md') },
      { fileName: 'notes.md' },
    );
  });

  it('缺少参数时给用法', async () => {
    const text = await run(makeBot(), '');
    expect(text).toContain('⚠️ 缺少文件路径');
    expect(text).toContain('/help get');
  });

  it('根目录之外的绝对路径也照常发送', async () => {
    const bot = makeBot();
    const file = join(outside, 'secret.txt');
    writeFileSync(file, 'x');
    const text = await run(bot, file);
    expect(text).toEqual({ kind: 'noop' });
    expect(bot.sendFile).toHaveBeenCalledTimes(1);
  });

  it('文件不存在与目录分别提示', async () => {
    expect(await run(makeBot(), 'missing.txt')).toContain('⚠️ 文件不存在');
    expect(await run(makeBot(), 'docs')).toContain('⚠️ 不是文件');
  });

  it('发送失败时给出原因', async () => {
    const bot = makeBot();
    bot.sendFile.mockRejectedValueOnce(new Error('upload denied'));
    const text = await run(bot, 'notes.md');
    expect(text.startsWith('❌ 发送失败')).toBe(true);
    expect(text).toContain('upload denied');
  });

  it('文件名带空格也能发', async () => {
    writeFileSync(join(root, 'my notes.md'), 'x');
    const bot = makeBot();
    await run(bot, 'my notes.md');
    expect(bot.sendFile).toHaveBeenCalledWith(
      expect.anything(),
      { localPath: join(root, 'my notes.md') },
      { fileName: 'my notes.md' },
    );
  });

  it('用注入的 replyTarget 投递', async () => {
    const bot = makeBot();
    await run(bot, basename(join(root, 'photo.png')));
    expect(bot.sendImage.mock.calls[0]?.[0]).toEqual({ scope: 'c2c', targetId: 'user1' });
  });

  it('相对路径跟着当前目录走', async () => {
    writeFileSync(join(outside, 'shifted.txt'), 'x');
    cwdSpy.mockReturnValue(outside);
    const bot = makeBot();
    await run(bot, 'shifted.txt');
    expect(bot.sendFile).toHaveBeenCalledWith(
      expect.anything(),
      { localPath: join(outside, 'shifted.txt') },
      { fileName: 'shifted.txt' },
    );
  });
});
