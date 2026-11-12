import { describe, it, expect, vi } from 'vitest';
import { collectImageBlocks, OutboundImages, segmentMessageContent } from './outbound-images.ts';
import type { SessionRecord } from '../session/index.ts';
import type { Logger } from '../types.ts';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createRecord(): SessionRecord {
  return { replyTarget: { scope: 'c2c', targetId: 'user1' } } as unknown as SessionRecord;
}

const ref = { attachmentId: 'a1', mediaType: 'image/png' };

describe('collectImageBlocks', () => {
  it('只取 image 块并去掉重复引用', () => {
    const blocks = [
      { type: 'text', text: 'hi' },
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', width: 10, height: 20 } },
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
      { type: 'image', attachment: { attachmentId: 'a2', mediaType: 'image/jpeg', name: 'x.jpg' } },
    ];

    expect(collectImageBlocks(blocks)).toEqual([
      { attachmentId: 'a1', mediaType: 'image/png', width: 10, height: 20 },
      { attachmentId: 'a2', mediaType: 'image/jpeg', name: 'x.jpg' },
    ]);
  });

  it('跳过 offloaded 与引用不完整的块', () => {
    const blocks = [
      { type: 'image', offloaded: true, attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
      { type: 'image' },
      { type: 'image', attachment: { mediaType: 'image/png' } },
      { type: 'image', attachment: { attachmentId: '', mediaType: 'image/png' } },
    ];

    expect(collectImageBlocks(blocks)).toEqual([]);
  });
});

describe('segmentMessageContent', () => {
  it('按内容块顺序保留图片位置，相邻图片归一组', () => {
    const blocks = [
      { type: 'text', text: '第一段' },
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
      { type: 'image', attachment: { attachmentId: 'a2', mediaType: 'image/png' } },
      { type: 'text', text: '第二段' },
    ];

    expect(segmentMessageContent(blocks)).toEqual([
      { kind: 'text', text: '第一段' },
      {
        kind: 'image',
        refs: [
          { attachmentId: 'a1', mediaType: 'image/png' },
          { attachmentId: 'a2', mediaType: 'image/png' },
        ],
      },
      { kind: 'text', text: '第二段' },
    ]);
  });

  it('重复引用只在第一次出现的位置发一次', () => {
    const blocks = [
      { type: 'text', text: 'a' },
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
      { type: 'text', text: 'b' },
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
    ];

    expect(segmentMessageContent(blocks).map((segment) => segment.kind)).toEqual(['text', 'image', 'text']);
  });
});

describe('OutboundImages.send', () => {
  it('优先用宿主文件路径发图', async () => {
    const bot = { sendImage: vi.fn().mockResolvedValue({}) };
    const images = new OutboundImages(
      bot,
      { imageHostPath: () => '/tmp/a.png' },
      createLogger(),
    );

    await images.send(createRecord(), [ref]);

    expect(bot.sendImage).toHaveBeenCalledWith(
      { scope: 'c2c', targetId: 'user1' },
      { localPath: '/tmp/a.png' },
    );
  });

  it('无宿主路径时退回附件字节', async () => {
    const bot = { sendImage: vi.fn().mockResolvedValue({}) };
    const images = new OutboundImages(
      bot,
      {
        imageHostPath: () => undefined,
        readImage: vi.fn().mockResolvedValue({ data: new Uint8Array([1, 2, 3]) }),
      },
      createLogger(),
    );

    await images.send(createRecord(), [ref]);

    const source = bot.sendImage.mock.calls[0]?.[1] as { buffer?: Buffer };
    expect(source.buffer?.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it('单张失败只记日志，后续图片继续发', async () => {
    const logger = createLogger();
    const bot = {
      sendImage: vi.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({}),
    };
    const images = new OutboundImages(bot, { imageHostPath: () => '/tmp/a.png' }, logger);

    await images.send(createRecord(), [ref, { ...ref, attachmentId: 'a2' }]);

    expect(bot.sendImage).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('图片发送失败 attachmentId=a1: boom'));
  });

  it('没有附件服务或定位不到附件时跳过', async () => {
    const bot = { sendImage: vi.fn().mockResolvedValue({}) };
    const noStore = new OutboundImages(bot, undefined, createLogger());
    const noPath = new OutboundImages(bot, { imageHostPath: () => undefined }, createLogger());

    await noStore.send(createRecord(), [ref]);
    await noPath.send(createRecord(), [ref]);

    expect(bot.sendImage).not.toHaveBeenCalled();
  });
});
