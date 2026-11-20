import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOutboundHandler } from '../../src/transport/outbound.ts';
import { sessionTitleOf } from '../../src/transport/session-source.ts';
import type { QQBotSender } from '../../src/transport/outbound.ts';
import type { SessionManager, SessionRecord } from '../../src/session/index.ts';
import type { QQTermConfig } from '../../src/config.ts';
import type { Logger, ReplyTarget } from '../../src/types.ts';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createBot(): QQBotSender {
  return {
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
  };
}

const c2cTarget: ReplyTarget = { scope: 'c2c', targetId: 'user1' };

function createRecord(
  target: ReplyTarget,
  sessionId = 'sess-qq',
  events: readonly { type?: string; data?: { title?: unknown } }[] = [],
): SessionRecord {
  return {
    sessionKey: 'k',
    sessionId,
    replyTarget: target,
    agent: { session: { id: sessionId, snapshotEvents: () => events } },
    handle: {},
    createdAt: 0,
    lastActiveAt: 0,
  } as unknown as SessionRecord;
}

function createConfig(overrides?: Partial<QQTermConfig>): QQTermConfig {
  return {
    textChunkLimit: 4500,
    showToolResults: false,
    ...overrides,
  } as unknown as QQTermConfig;
}

/** 组装 handler：manager 按 sessionId 返回 record（默认 c2c 私聊） */
function setup(opts?: {
  record?: SessionRecord | undefined;
  config?: QQTermConfig;
  deliverer?: { deliver: ReturnType<typeof vi.fn> };
  current?: boolean;
  retryChannel?: { offer: ReturnType<typeof vi.fn> };
  /** 图片转发器（不传则不转发 image 块） */
  images?: { send: ReturnType<typeof vi.fn> };
  /** 会话工作目录（本地文件链接按它解析相对路径） */
  dir?: string;
  /** 渠道级失效回调 */
  onChannelBroken?: (reason: string) => void;
  /** 部署是否有 workspaceRegistry（决定尾部有没有归档入口） */
  archivable?: boolean;
}) {
  const bot = createBot();
  const record = 'record' in (opts ?? {}) ? opts!.record : createRecord(c2cTarget);
  const manager = {
    findBySessionId: vi.fn((id: string) => (id === 'sess-qq' ? record : undefined)),
    isCurrentSession: vi.fn(() => opts?.current ?? true),
    directoryForAgent: vi.fn(() => opts?.dir),
    workspaceRegistryAvailable: vi.fn(() => opts?.archivable ?? false),
    // 真实 SessionManager 的标题来自会话日志；假 manager 也按同一来源给
    sessionTitle: vi.fn((id: string) => (id === 'sess-qq' ? sessionTitleOf(record) : undefined)),
    ...(opts?.retryChannel !== undefined ? { retryChannel: opts.retryChannel } : {}),
  } as unknown as SessionManager;
  const outbound = createOutboundHandler(
    manager, bot, opts?.config ?? createConfig(), createLogger(), undefined, opts?.deliverer,
    opts?.images as never, opts?.onChannelBroken,
  );
  return { outbound, bot, record };
}

describe('OutboundRouter: 多会话标记', () => {
  const sourceOf = (id: string, title = '未命名会话'): string => `> \`#${id}\` · ${title}`;
  const footerOf = (id: string): string =>
    `<qqbot-cmd-input text="/to #${id} " show="回复"/>`
    + ` · <qqbot-cmd-input text="/sessions resume #${id}" show="恢复"/>`;

  it('非当前会话：来源头 + 正文 + 动作链接行', async () => {
    const { outbound, bot } = setup({ current: false });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'hello' }] } },
    });
    await Promise.resolve();

    expect(bot.sendMarkdown).toHaveBeenCalledWith(
      c2cTarget,
      `${sourceOf('sess-qq')}\n\nhello\n\n${footerOf('sess-qq')}`,
    );
  });

  it('有归档能力时尾部多一个归档入口', async () => {
    const { outbound, bot } = setup({ current: false, archivable: true });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'hello' }] } },
    });
    await Promise.resolve();

    expect(bot.sendMarkdown).toHaveBeenCalledWith(
      c2cTarget,
      `${sourceOf('sess-qq')}\n\nhello\n\n${footerOf('sess-qq')}`
        + ' · <qqbot-cmd-input text="/sessions archive #sess-qq" show="归档"/>',
    );
  });

  it('来源头带会话标题（取日志里最新的 session/title）', async () => {
    const record = createRecord(c2cTarget, 'sess-qq', [
      { type: 'session/title', data: { title: '旧标题' } },
      { type: 'assistant/message', data: {} },
      { type: 'session/title', data: { title: '修登录' } },
    ]);
    const { outbound, bot } = setup({ current: false, record });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'hello' }] } },
    });
    await Promise.resolve();

    expect(bot.sendMarkdown).toHaveBeenCalledWith(
      c2cTarget,
      `${sourceOf('sess-qq', '修登录')}\n\nhello\n\n${footerOf('sess-qq')}`,
    );
  });

  it('当前会话不加标记', async () => {
    const { outbound, bot } = setup({ current: true });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'hello' }] } },
    });
    await Promise.resolve();

    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, 'hello');
  });
});

describe('OutboundRouter: 工具结果开关', () => {
  const toolCall = (callId: string, name: string, args: unknown) => ({
    type: 'tool/call',
    data: { callId, name, arguments: JSON.stringify(args) },
  });
  const okResult = (callId: string, text: string) => ({
    type: 'tool/result',
    data: {
      message: {
        source: { callId },
        content: [{ type: 'tool-result', content: [{ type: 'text', text }] }],
      },
    },
  });
  const errorResult = (callId: string, code: string, detail: string) => ({
    type: 'tool/result',
    data: {
      message: {
        source: { callId },
        content: [{ type: 'tool-result', content: [{ type: 'text', text: `Error: ${detail}` }], isError: true }],
      },
      error: { name: 'FsError', code },
    },
  });
  const session = { header: { id: 'sess-qq' } };

  it('开关关闭：成功与失败都不发', async () => {
    const { outbound, bot } = setup();

    outbound.routeSessionEvent(session, toolCall('c1', 'read', { file_path: 'a.ts' }));
    outbound.routeSessionEvent(session, okResult('c1', 'hello'));
    outbound.routeSessionEvent(session, toolCall('c2', 'edit', { file_path: 'a.ts' }));
    outbound.routeSessionEvent(session, errorResult('c2', 'FS_AMBIGUOUS_EDIT', 'matched 2 times'));
    await Promise.resolve();
    await Promise.resolve();

    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('开关打开：失败带工具、目标与原因', async () => {
    const { outbound, bot } = setup({ config: createConfig({ showToolResults: true }) });

    outbound.routeSessionEvent(session, toolCall('c1', 'edit', { file_path: 'a.ts' }));
    outbound.routeSessionEvent(session, errorResult('c1', 'FS_AMBIGUOUS_EDIT', 'matched 2 times'));
    await Promise.resolve();
    await Promise.resolve();

    expect(bot.sendMarkdown).toHaveBeenCalledWith(
      c2cTarget,
      '❌ 工具 `edit` 执行失败: `a.ts`\n原因: `FsError: FS_AMBIGUOUS_EDIT` · matched 2 times',
    );
  });

  it('开关打开：成功结果照旧展示', async () => {
    const { outbound, bot } = setup({ config: createConfig({ showToolResults: true }) });

    outbound.routeSessionEvent(session, toolCall('c1', 'read', { file_path: 'a.ts' }));
    outbound.routeSessionEvent(session, okResult('c1', 'hello'));
    await Promise.resolve();
    await Promise.resolve();

    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, '🔧 `read` 完成\nhello');
  });

  it('没记录到 tool/call 的结果直接丢弃（不猜工具名）', async () => {
    const { outbound, bot } = setup({ config: createConfig({ showToolResults: true }) });

    outbound.routeSessionEvent(session, errorResult('ghost', 'FS_AMBIGUOUS_EDIT', 'matched 2 times'));
    await Promise.resolve();
    await Promise.resolve();

    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });
});

describe('OutboundRouter: deliverables/presented', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const presentedEvent = (callId: string, files: Array<{ path: string; description?: string }>) => ({
    type: 'deliverables/presented',
    data: { turn: 1, callId, files },
  });
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'stop' } } };

  it('轮末投递声明的文件，且在文本之后', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { outbound, bot, record } = setup({ deliverer: { deliver } });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, presentedEvent('c1', [{ path: '/tmp/report.xlsx' }]));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'final reply' }] } },
    });
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, turnEnd);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(record, [{ path: '/tmp/report.xlsx' }]);
    // 文本先于文件：markdown 发送的调用序在 deliver 之前
    const textOrder = (bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(textOrder).toBeLessThan(deliver.mock.invocationCallOrder[0]);
  });

  it('同 callId 去重：事件重放不重复投递', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { outbound, record } = setup({ deliverer: { deliver } });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, presentedEvent('c2', [{ path: '/tmp/b.png' }]));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, turnEnd);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(record, [{ path: '/tmp/a.png' }, { path: '/tmp/b.png' }]);
  });

  it('assistant/message 在途文本未送达前不投递文件（等待 pending 发送完成）', async () => {
    let resolveText: (() => void) | undefined;
    const textTask = new Promise<void>((resolve) => { resolveText = resolve; });
    const bot: QQBotSender = {
      sendMarkdown: vi.fn(() => textTask),
    };
    const record = createRecord(c2cTarget);
    const manager = {
      findBySessionId: vi.fn(() => record),
      isCurrentSession: vi.fn(() => true),
      directoryForAgent: vi.fn(() => undefined),
      workspaceRegistryAvailable: vi.fn(() => false),
    } as unknown as SessionManager;
    const deliver = vi.fn().mockResolvedValue(undefined);
    const outbound = createOutboundHandler(manager, bot, createConfig(), createLogger(), undefined, { deliver });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'reply' }] } },
    });
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, turnEnd);
    await Promise.resolve();
    await Promise.resolve();
    expect(deliver).not.toHaveBeenCalled(); // 文本仍在途

    resolveText?.();
    for (let i = 0; i < 10; i++) await Promise.resolve(); // 冲刷 catch 派生 + Promise.all 的微任务链
    expect(deliver).toHaveBeenCalledTimes(1); // 文本送达后才投递
  });

  it('配置关闭时不投递', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { outbound } = setup({
      config: createConfig({ sendFile: { sendPresentedFiles: false, maxFiles: 4 } as QQTermConfig['sendFile'] }),
      deliverer: { deliver },
    });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, turnEnd);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(deliver).not.toHaveBeenCalled();
  });

  it('异常结束的轮次仍投递已声明的文件（宿主契约：失败不撤销声明）', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { outbound, bot } = setup({ deliverer: { deliver } });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'E_BROKEN', message: 'boom' } } },
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, expect.stringContaining('❌ 本轮失败'));
    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, expect.stringContaining('E_BROKEN'));
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('可重试失败交给重发通道，不再直出原始 code + JSON', async () => {
    const offer = vi.fn().mockResolvedValue(true);
    const record = { ...createRecord(c2cTarget), lastPrompt: '原文' } as unknown as SessionRecord;
    const { outbound, bot } = setup({ record, retryChannel: { offer } });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429: {"type":"server_error"}' } } },
    });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(offer).toHaveBeenCalledWith(record, { code: 'RATE_LIMIT', message: '429: {"type":"server_error"}' }, 0);
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('llm/retry 的次数带进失败告知', async () => {
    const offer = vi.fn().mockResolvedValue(true);
    const record = { ...createRecord(c2cTarget), lastPrompt: '原文' } as unknown as SessionRecord;
    const { outbound } = setup({ record, retryChannel: { offer } });
    const session = { header: { id: 'sess-qq' } };

    outbound.routeSessionEvent(session, { type: 'llm/retry', data: { retry: 1, provider: 'opencode-go' } });
    outbound.routeSessionEvent(session, { type: 'llm/retry', data: { retry: 3, provider: 'opencode-go' } });
    outbound.routeSessionEvent(session, {
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429: boom' } } },
    });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(offer.mock.calls[0]?.[2]).toBe(3);
  });

  it('第 4 次起每次重试都提示，前三次静默', async () => {
    const record = { ...createRecord(c2cTarget), lastPrompt: '原文' } as unknown as SessionRecord;
    const { outbound, bot } = setup({ record });
    const session = { header: { id: 'sess-qq' } };
    const retryEvent = (retry: number) => ({
      type: 'llm/retry',
      data: {
        retry,
        maxRetries: 10,
        delayMs: 4000,
        provider: 'opencode-go',
        failure: { code: 'RATE_LIMIT', message: '429: {"type":"server_error"}' },
      },
    });

    outbound.routeSessionEvent(session, retryEvent(3));
    await vi.advanceTimersByTimeAsync(0);
    expect(bot.sendMarkdown).not.toHaveBeenCalled();

    outbound.routeSessionEvent(session, retryEvent(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, expect.stringContaining('⏳ 第 4/10 次重试 · 4.0s 后发起'));
    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, expect.stringContaining('429: {"type":"server_error"}'));
  });

  it('配置类失败只给原因，不再指向 /retry', async () => {
    const offer = vi.fn().mockResolvedValue(true);
    const record = { ...createRecord(c2cTarget), lastPrompt: '原文' } as unknown as SessionRecord;
    const { outbound, bot } = setup({ record, retryChannel: { offer } });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'turn/end',
      data: {
        reason: {
          kind: 'error',
          error: { code: 'NO_ADAPTER', message: 'no adapter registered for provider "opencode-go"' },
        },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(offer).not.toHaveBeenCalled();
    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, expect.stringContaining('❌ 本轮失败'));
    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, expect.stringContaining('原因: `NO_ADAPTER` · no adapter'));
    expect(bot.sendMarkdown).not.toHaveBeenCalledWith(c2cTarget, expect.stringContaining('/retry'));
  });

  it('未提供投递器时静默跳过（老环境降级）', async () => {
    const { outbound, bot } = setup();

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, turnEnd);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });
});

describe('OutboundRouter assistant/message 图片', () => {
  const imageMessage = (content: unknown[]) => ({
    session: { header: { id: 'sess-qq' } },
    event: { type: 'assistant/message', data: { message: { content } } },
  });

  it('文本发完后才把 image 块交给图片转发器', async () => {
    const images = { send: vi.fn().mockResolvedValue(undefined) };
    const { outbound, bot } = setup({ images });
    const { session, event } = imageMessage([
      { type: 'text', text: '看图' },
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
    ]);

    outbound.routeSessionEvent(session, event);
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, '看图');
    expect(images.send).toHaveBeenCalledTimes(1);
    expect(images.send.mock.calls[0]?.[1]).toEqual([{ attachmentId: 'a1', mediaType: 'image/png' }]);
    const sendOrder = (bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(images.send.mock.invocationCallOrder[0]).toBeGreaterThan(sendOrder!);
  });

  it('只有图片没有文本也发送', async () => {
    const images = { send: vi.fn().mockResolvedValue(undefined) };
    const { outbound, bot } = setup({ images });
    const { session, event } = imageMessage([
      { type: 'image', attachment: { attachmentId: 'a2', mediaType: 'image/jpeg' } },
    ]);

    outbound.routeSessionEvent(session, event);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(bot.sendMarkdown).not.toHaveBeenCalled();
    expect(images.send).toHaveBeenCalledTimes(1);
  });

  it('文本与图片按内容块顺序交替发送', async () => {
    const images = { send: vi.fn().mockResolvedValue(undefined) };
    const { outbound, bot } = setup({ images, config: createConfig() });
    const { session, event } = imageMessage([
      { type: 'text', text: '先看图' },
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
      { type: 'text', text: '图后还有话' },
    ]);

    outbound.routeSessionEvent(session, event);
    for (let i = 0; i < 30; i++) await Promise.resolve();

    const markdown = (bot.sendMarkdown as ReturnType<typeof vi.fn>).mock;
    expect(markdown.calls.map((call) => call[1])).toEqual(['先看图', '图后还有话']);
    expect(images.send).toHaveBeenCalledTimes(1);
    expect(images.send.mock.invocationCallOrder[0]).toBeGreaterThan(markdown.invocationCallOrder[0]!);
    expect(images.send.mock.invocationCallOrder[0]).toBeLessThan(markdown.invocationCallOrder[1]!);
  });

  it('未注入图片转发器时忽略 image 块', async () => {
    const { outbound, bot } = setup();
    const { session, event } = imageMessage([
      { type: 'image', attachment: { attachmentId: 'a3', mediaType: 'image/png' } },
    ]);

    outbound.routeSessionEvent(session, event);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });
});

describe('OutboundRouter 本地文件链接', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qqterm-link-out-'));
    writeFileSync(join(dir, 'notes.md'), 'x');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('发送前把本地文件链接换成 /get 命令', async () => {
    const { outbound, bot } = setup({ dir });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '看[notes.md](notes.md)' }] } },
    });
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const sent = (bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(sent).toContain('<qqbot-cmd-input');
    expect(sent).toContain(`text="/get ${join(dir, 'notes.md')}"`);
    expect(sent).toContain('show="notes.md"');
  });

  it('正文里的 markdown 图片换成图片消息，文本里不留 ![]()', async () => {
    writeFileSync(join(dir, 'path.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const images = { send: vi.fn(), sendPaths: vi.fn().mockResolvedValue(undefined) };
    const { outbound, bot } = setup({ dir, images, config: createConfig() });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: {
        message: {
          content: [{ type: 'text', text: '图与数据\n\n![价格路径](<path.png>)\n\n后面还有话' }],
        },
      },
    });
    for (let i = 0; i < 30; i++) await Promise.resolve();

    expect(images.sendPaths).toHaveBeenCalledTimes(1);
    expect(images.sendPaths.mock.calls[0]?.[1]).toEqual([join(dir, 'path.png')]);
    const sent = (bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1] as string);
    expect(sent.map((text) => text.trim())).toEqual(['图与数据', '后面还有话']);
    expect(sent.join('')).not.toContain('![');
  });
});

describe('OutboundRouter 投递失败', () => {
  const event = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '你好' }] } } };

  async function drain(): Promise<void> {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }

  function httpError(status: number, message = 'send failed'): Error {
    return Object.assign(new Error(message), { status });
  }

  it('暂不可用先重试一次，第二次成功就不排队', async () => {
    const { outbound, bot } = setup();
    (bot.sendMarkdown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(undefined);

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, event);
    await drain();

    expect(bot.sendMarkdown).toHaveBeenCalledTimes(2);
    expect(outbound.hasPendingDelivery()).toBe(false);
    expect((bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]).toBe('你好');
  });

  it('两次都失败就整条挂起，网络恢复后 flush 补发', async () => {
    const { outbound, bot } = setup();
    const send = bot.sendMarkdown as ReturnType<typeof vi.fn>;
    send.mockRejectedValue(new Error('timeout'));

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, event);
    await drain();

    expect(send).toHaveBeenCalledTimes(2);
    expect(outbound.hasPendingDelivery('sess-qq')).toBe(true);

    send.mockResolvedValue(undefined);
    await outbound.flushPending();

    expect(outbound.hasPendingDelivery()).toBe(false);
    expect(send.mock.calls.at(-1)?.[1]).toBe('你好');
  });

  it('超长按一半重切，切到能发为止', async () => {
    const { outbound, bot } = setup();
    const send = bot.sendMarkdown as ReturnType<typeof vi.fn>;
    send.mockImplementation(async (_target: unknown, text: string) => {
      if (text.length > 1200) throw httpError(40054007, 'message too long');
    });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'a'.repeat(9000) }] } },
    });
    await drain();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const lengths = send.mock.calls.map((call) => String(call[1]).length);
    expect(lengths.some((len) => len > 1200)).toBe(true);
    expect(lengths.filter((len) => len <= 1200).length).toBeGreaterThan(0);
    expect(send.mock.calls.every((call) => !String(call[1]).includes('拦截'))).toBe(true);
  });

  it('非当前会话超长重切：来源头只出现一次，正文不重发', async () => {
    const { outbound, bot } = setup({ current: false });
    const accepted: string[] = [];
    (bot.sendMarkdown as ReturnType<typeof vi.fn>).mockImplementation(async (_target: unknown, text: string) => {
      if (text.length > 4000) throw httpError(40054007, 'message too long');
      accepted.push(text);
    });
    const body = Array.from({ length: 200 }, (_, i) => `段落 ${i} 内容内容内容内容内容内容`).join('\n\n');

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: body }] } },
    });
    await drain();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(accepted.length).toBeGreaterThan(1);
    for (const text of accepted) {
      expect(text.length).toBeLessThanOrEqual(4000);
      // 同一片里出现两次来源头，就是「对已装饰文本再切」的老 bug
      expect(text.split('> `#sess-qq` · 未命名会话').length - 1).toBeLessThanOrEqual(1);
    }
    const joined = accepted.join('\n');
    for (let i = 0; i < 200; i++) {
      expect(joined.split(`段落 ${i} 内容`).length - 1).toBe(1);
    }
    expect(joined.split('show="恢复"').length - 1).toBe(1);
  });

  it('单行超长正文按字符重切：装饰只加一次，正文不丢', async () => {
    const { outbound, bot } = setup({ current: false });
    const accepted: string[] = [];
    (bot.sendMarkdown as ReturnType<typeof vi.fn>).mockImplementation(async (_target: unknown, text: string) => {
      if (text.length > 1200) throw httpError(40054007, 'message too long');
      accepted.push(text);
    });

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'a'.repeat(9000) }] } },
    });
    await drain();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(accepted.length).toBeGreaterThan(1);
    for (const text of accepted) expect(text.length).toBeLessThanOrEqual(1200);
    expect(accepted.join('').split('a').length - 1).toBe(9000);
    expect(accepted.join('\n').split('> `#sess-qq` · 未命名会话').length - 1).toBe(1);
  });

  it('被风控拦截时只补一条替代消息', async () => {
    const { outbound, bot } = setup();
    const send = bot.sendMarkdown as ReturnType<typeof vi.fn>;
    send.mockRejectedValue(new Error('sensitive content detected'));

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, event);
    await drain();

    expect(send).toHaveBeenCalledTimes(2);
    expect(String(send.mock.calls[1]?.[1])).toContain('上一条消息被 QQ 拦截');
    expect(outbound.hasPendingDelivery()).toBe(false);
  });

  it('鉴权失败判渠道失效，通知调用方', async () => {
    const onChannelBroken = vi.fn();
    const { outbound, bot } = setup({ onChannelBroken });
    (bot.sendMarkdown as ReturnType<typeof vi.fn>).mockRejectedValue(httpError(401, 'unauthorized'));

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, event);
    await drain();

    expect(onChannelBroken).toHaveBeenCalledTimes(1);
    expect(outbound.hasPendingDelivery()).toBe(false);
  });
});
