/**
 * /get 命令：按扩展名发送文件与失败文案
 *
 * 用真实临时目录（不碰真实 ~/.dsh），bot 只记录调用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type QQTermConfig } from '../../src/config.ts';
import type { SessionManager } from '../../src/session/index.ts';
import type { Logger } from '../../src/types.ts';
import { getCommand } from '../../src/commands/get.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const config = ConfigSchema({
  appId: 'app',
  appSecret: 'secret',
  access: { owner: 'user1' },
} as QQTermConfig);

let root = '';
let outside = '';

function makeManager(path = root) {
  return {
    currentWorkspaceInfo: vi.fn(async () => ({ title: 'root', path, missing: false })),
  };
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
  manager: ReturnType<typeof makeManager>,
  bot: ReturnType<typeof makeBot>,
  raw: string,
): Promise<string | { kind: 'noop' }> {
  const command = getCommand({
    manager: manager as unknown as SessionManager,
    config,
    bot: bot as never,
    logger,
  });
  return (await command.handler(makeCtx(raw))) as string | { kind: 'noop' };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qqterm-get-'));
  outside = mkdtempSync(join(tmpdir(), 'qqterm-get-out-'));
  writeFileSync(join(root, 'photo.png'), 'png');
  writeFileSync(join(root, 'notes.md'), 'md');
  mkdirSync(join(root, 'docs'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('/get', () => {
  it('图片按图片通道发送', async () => {
    const bot = makeBot();
    const text = await run(makeManager(), bot, 'photo.png');
    expect(text).toEqual({ kind: 'noop' });
    expect(bot.sendImage).toHaveBeenCalledWith(
      { scope: 'c2c', targetId: 'user1' },
      { localPath: join(root, 'photo.png') },
    );
    expect(bot.sendFile).not.toHaveBeenCalled();
  });

  it('其它扩展名走通用文件通道', async () => {
    const bot = makeBot();
    await run(makeManager(), bot, join(root, 'notes.md'));
    expect(bot.sendFile).toHaveBeenCalledWith(
      { scope: 'c2c', targetId: 'user1' },
      { localPath: join(root, 'notes.md') },
      { fileName: 'notes.md' },
    );
  });

  it('缺少参数时给用法', async () => {
    const text = await run(makeManager(), makeBot(), '');
    expect(text).toContain('⚠️ 缺少文件路径');
    expect(text).toContain('/help get');
  });

  it('工作区外的绝对路径也照常发送', async () => {
    const bot = makeBot();
    const file = join(outside, 'secret.txt');
    writeFileSync(file, 'x');
    const text = await run(makeManager(), bot, file);
    expect(text).toEqual({ kind: 'noop' });
    expect(bot.sendFile).toHaveBeenCalledTimes(1);
  });

  it('文件不存在与目录分别提示', async () => {
    expect(await run(makeManager(), makeBot(), 'missing.txt')).toContain('⚠️ 文件不存在');
    expect(await run(makeManager(), makeBot(), 'docs')).toContain('⚠️ 不是文件');
  });

  it('发送失败时给出原因', async () => {
    const bot = makeBot();
    bot.sendFile.mockRejectedValueOnce(new Error('upload denied'));
    const text = await run(makeManager(), bot, 'notes.md');
    expect(text.startsWith('❌ 发送失败')).toBe(true);
    expect(text).toContain('upload denied');
  });

  it('文件名带空格也能发', async () => {
    writeFileSync(join(root, 'my notes.md'), 'x');
    const bot = makeBot();
    await run(makeManager(), bot, 'my notes.md');
    expect(bot.sendFile).toHaveBeenCalledWith(
      expect.anything(),
      { localPath: join(root, 'my notes.md') },
      { fileName: 'my notes.md' },
    );
  });

  it('用注入的 replyTarget 投递', async () => {
    const bot = makeBot();
    await run(makeManager(), bot, basename(join(root, 'photo.png')));
    expect(bot.sendImage.mock.calls[0]?.[0]).toEqual({ scope: 'c2c', targetId: 'user1' });
  });
});
