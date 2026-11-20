/**
 * 端到端（进程内）：QQ 入站 → SessionManager → agent.followup → session/event →
 * 出站路由 → QQ 发送。
 *
 * 这条链路此前没有任何用例覆盖（单测都停在本模块边界）。这里走真实的 SessionManager、
 * 出站路由、分片与非当前会话装饰，只把 QQ 网关与模型换成替身：真网关（WebSocket +
 * 被动回复凭证）与真模型调用不能自动化，见 AGENTS `5。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 插件数据目录（隔离 PrefsStore 写盘） */
const env = vi.hoisted(() => ({ home: '' }));

vi.mock('../../src/shared/dirs.ts', () => ({
  get PLUGIN_HOME() { return env.home; },
  resolveAgentCwd: (cwd: string | undefined) => cwd || `${env.home}/workspace`,
}));

// 真实 ~/.dsh/settings.yaml 不在测试范围内：默认模型走宿主服务（fixture 提供）
vi.mock('../../src/model/settings-reader.ts', () => ({
  SettingsReader: class {
    readDefaultRoute(): undefined { return undefined; }
  },
}));

const { SessionManager } = await import('../../src/session/session-manager.ts');
const { handleInbound } = await import('../../src/transport/inbound.ts');
const { createOutboundHandler } = await import('../../src/transport/outbound.ts');
const { createHostFixture, fakeAgent, OWNER } = await import('../fixtures/host.ts');
const { fakeQQBot } = await import('../fixtures/qq.ts');

type Host = ReturnType<typeof createHostFixture>;
type Manager = InstanceType<typeof SessionManager>;
type Bot = ReturnType<typeof fakeQQBot>;
type Agent = ReturnType<typeof fakeAgent>;
type RawEvent = Parameters<ReturnType<typeof createOutboundHandler>['routeSessionEvent']>[1];

/** 让出站发送链（fire-and-forget 的 Promise 链）跑完 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve));
}

/** 组装与 gateway/bootstrap.ts 相同的出站注册：global 监听所有已获取会话 */
function setup(): { host: Host; bot: Bot; manager: Manager } {
  const host = createHostFixture({ home: env.home });
  const bot = fakeQQBot();
  const manager = new SessionManager(host.ctx, host.agents, host.config, host.logger);
  const outbound = createOutboundHandler(manager, bot, host.config, host.logger);
  const bus = host.ctx as unknown as {
    on(name: string, handler: (...args: unknown[]) => void, options?: { global?: boolean }): void;
  };
  bus.on('session/event', ((session: Parameters<typeof outbound.routeSessionEvent>[0], event: RawEvent): void => {
    outbound.routeSessionEvent(session, event);
  }) as (...args: unknown[]) => void, { global: true });
  return { host, bot, manager };
}

/** 模拟 SDK 中间件链处理完之后交给插件的那条消息 */
async function inbound(host: Host, manager: Manager, bot: Bot, text: string): Promise<void> {
  const mCtx = {
    bot,
    message: {
      senderId: OWNER,
      content: text,
      messageId: `msg-${text.length}`,
      timestamp: '0',
      rawEventType: 'C2C_MESSAGE_CREATE',
    },
    state: {},
  } as unknown as Parameters<typeof handleInbound>[0];
  await handleInbound(mCtx, manager, host.logger, async (target, body) => {
    await bot.sendMarkdown(target as never, body);
  });
}

/** 宿主 assistant/message 事件（正文是一个 text 内容块） */
function assistant(text: string): RawEvent {
  return { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } };
}

/** 正常结束的一轮 */
const TURN_END: RawEvent = { type: 'turn/end', data: { reason: { kind: 'stop' } } };

let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'qqterm-e2e-'));
  env.home = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});
describe('QQ 消息全链路', () => {
  it('入站消息进 agent，助手回复原样发回 QQ', async () => {
    const { host, bot, manager } = setup();

    await inbound(host, manager, bot, '你好');

    const record = manager.getSessionRecord('c2c', OWNER);
    expect(record).toBeDefined();
    expect(manager.isCurrentSession(record!.sessionId)).toBe(true);
    // 原文留档（轮次失败后的「重发」靠它）
    expect(record!.lastPrompt).toBe('你好');

    const agent = record!.agent as Agent;
    expect(agent.followups).toHaveLength(1);
    const message = agent.followups[0] as {
      content: Array<{ type: string; text?: string }>;
      source?: { kind?: string };
    };
    // source.kind 必须是 user：宿主的人类消息能力都以它为触发条件
    expect(message.source?.kind).toBe('user');
    expect(message.content[0]?.text).toBe('你好');

    host.sessionEvent(agent, assistant('你好，我是助手'));
    host.sessionEvent(agent, TURN_END);
    await settle();

    expect(bot.texts()).toEqual(['你好，我是助手']);
    // 发给说话的人，且当前会话不加来源头
    expect(bot.sent[0]!.target).toEqual({ scope: 'c2c', targetId: OWNER });
  });

  it('长回复按 textChunkLimit 分片，内容不丢', async () => {
    const { host, bot, manager } = setup();
    await inbound(host, manager, bot, '讲个长故事');
    const agent = manager.getSessionRecord('c2c', OWNER)!.agent as Agent;

    const text = `${'A'.repeat(4500)}\n${'B'.repeat(1000)}`;
    host.sessionEvent(agent, assistant(text));
    host.sessionEvent(agent, TURN_END);
    await settle();

    const texts = bot.texts();
    expect(texts.length).toBeGreaterThan(1);
    for (const chunk of texts) expect(chunk.length).toBeLessThanOrEqual(host.config.textChunkLimit);

    const joined = texts.join('');
    expect([...joined].filter(char => char === 'A')).toHaveLength(4500);
    expect([...joined].filter(char => char === 'B')).toHaveLength(1000);
  });

  it('非当前会话的回复带来源头与「回复 / 恢复」链接', async () => {
    const { host, bot, manager } = setup();
    await inbound(host, manager, bot, '你好');

    // Web 端已经开着的会话：registry 里有 live agent，`/to` 借来一条记录
    const other = fakeAgent('session-abcdef123456');
    host.agents.add(other);
    other.pushEvent({ type: 'session/title', data: { title: '后台任务' } });

    const outcome = await manager.sendTo('c2c', OWNER, OWNER, other.id, '在吗', { scope: 'c2c', targetId: OWNER });
    expect(outcome.ok).toBe(true);
    expect(manager.isCurrentSession(other.id)).toBe(false);

    host.sessionEvent(other, assistant('这条来自另一个会话'));
    host.sessionEvent(other, TURN_END);
    await settle();

    const [text] = bot.texts();
    expect(text).toBeDefined();
    expect(text!.split('\n')[0]).toBe('> `#abcdef12` · 后台任务');
    expect(text).toContain('这条来自另一个会话');
    expect(text).toContain('/to #abcdef12 ');
    expect(text).toContain('/sessions resume #abcdef12');
  });

  it('sendMarkdown 偶发失败先重试一次：这一条不丢，下一条照常', async () => {
    const { host, bot, manager } = setup();
    await inbound(host, manager, bot, '你好');
    const record = manager.getSessionRecord('c2c', OWNER)!;
    const agent = record.agent as Agent;

    bot.failNext(1);
    host.sessionEvent(agent, assistant('第一条重试后送达'));
    await settle();

    expect(bot.texts()).toEqual(['第一条重试后送达']);

    host.sessionEvent(agent, assistant('第二条正常'));
    host.sessionEvent(agent, TURN_END);
    await settle();

    expect(bot.texts()).toEqual(['第一条重试后送达', '第二条正常']);
    expect(manager.currentSessionId()).toBe(record.sessionId);
    host.dispose();
  });

  it('连续失败不中断会话：消息挂起等恢复，会话仍可继续', async () => {
    const { host, bot, manager } = setup();
    await inbound(host, manager, bot, '你好');
    const record = manager.getSessionRecord('c2c', OWNER)!;
    const agent = record.agent as Agent;

    bot.failNext(10);
    host.sessionEvent(agent, assistant('这条会挂起'));
    await settle();

    // 两次都失败：不丢弃也不重放，进待投队列等网络恢复
    expect(bot.texts()).toEqual([]);
    expect(manager.currentSessionId()).toBe(record.sessionId);
    host.dispose();
  });
});
