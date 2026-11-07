import { describe, it, expect, vi } from 'vitest';
import type { EventOptions } from '@deepseek-ai/cordis';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import {
  ApprovalChannel,
  type ApprovalOutcome,
  type ApprovalRequest,
  type ApprovalSessionRecordLike,
  type ApprovalChannelConfigLike,
  type ApprovalChannelContext,
} from './approval-channel.ts';
import { buildApprovalKeyboard, buildApprovalText } from './approval-renderer.ts';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface SentMessage {
  text: string;
  opts?: { keyboard?: unknown };
}

function createSender(sent: SentMessage[]) {
  return {
    sendMarkdown: vi.fn(async (_target: ReplyTarget, content: string, o?: { keyboard?: unknown }) => {
      sent.push({ text: content, opts: o });
    }),
  };
}

const sessionKey = (scope: ChatScope, peerId: string): string => `qqbot:app:${scope}:${peerId}`;

/** 默认绑定 peer-qq；传空字符串模拟未配置 owner */
function makeConfig(owner = 'peer-qq'): ApprovalChannelConfigLike {
  return { access: { owner } };
}

function makeRecord(key: string, scope: ChatScope = 'c2c'): ApprovalSessionRecordLike {
  return { sessionKey: key, scope, replyTarget: { scope, targetId: 'x', msgId: 'm' } };
}

function createManager(opts?: {
  findBySessionId?: (id: string) => ApprovalSessionRecordLike | undefined;
  getSessionRecord?: (scope: ChatScope, peerId: string) => ApprovalSessionRecordLike | undefined;
}) {
  return {
    findBySessionId: opts?.findBySessionId ?? (() => undefined),
    getSessionRecord: opts?.getSessionRecord ?? ((scope: ChatScope, peerId: string) => makeRecord(sessionKey(scope, peerId), scope)),
  };
}

function makeRequest(opts?: {
  id?: string;
  toolName?: string;
  callId?: string;
  reason?: string;
  events?: ReturnType<NonNullable<ApprovalRequest['agent']['session']>['snapshotEvents']>;
  signal?: AbortSignal;
  /** 模拟拿不到 live session 的审批上下文（跨进程/投影后的 Agent）。 */
  noSession?: boolean;
}): ApprovalRequest {
  return {
    agent: opts?.noSession === true
      ? { id: opts?.id ?? 'sess-qq' }
      : { id: opts?.id ?? 'sess-qq', session: { snapshotEvents: () => opts?.events ?? [] } },
    toolName: opts?.toolName ?? 'bash',
    ...(opts?.callId !== undefined ? { callId: opts.callId } : {}),
    ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
    ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
  };
}

/** 从已发送卡片的 keyboard 提取指定决策的 button_data（含 nonce） */
function extractButtonData(msg: SentMessage, d: 'allow' | 'deny'): string {
  const kb = msg.opts?.keyboard as { content: { rows: Array<{ buttons: Array<{ action: { data: string } }> }> } };
  const button = kb.content.rows[0]!.buttons.find((b) => (JSON.parse(b.action.data) as { d: string }).d === d);
  if (!button) throw new Error(`button ${d} not found`);
  return button.action.data;
}

/** 便捷形式：取最后一张卡片 */
function buttonDataOf(sent: SentMessage[], d: 'allow' | 'deny'): string {
  return extractButtonData(sent[sent.length - 1]!, d);
}

function makeEvent(data: string | undefined, peer: { user?: string }): InteractionEvent {
  return {
    id: 'i1',
    type: 1,
    version: 1,
    ...(peer.user ? { user_openid: peer.user } : {}),
    data: { type: 1, resolved: { ...(data !== undefined ? { button_data: data } : {}) } },
  } as InteractionEvent;
}

/** 注册 approval/request 监听并捕获 handler，供测试手动触发 */
function installAndCapture(ch: ApprovalChannel, sent: SentMessage[]): {
  handler: (req: unknown, next: unknown) => unknown;
  options?: EventOptions;
} {
  const captured: {
    handler?: (req: unknown, next: unknown) => unknown;
    options?: EventOptions;
  } = {};
  const ctx: ApprovalChannelContext = {
    on: vi.fn((event: string, handler: (req: unknown, next: unknown) => unknown, options?: EventOptions) => {
      if (event === 'approval/request') {
        captured.handler = handler;
        captured.options = options;
      }
      return () => true;
    }),
  };
  ch.install(ctx);
  return { handler: captured.handler!, ...(captured.options !== undefined ? { options: captured.options } : {}) };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('buildApprovalKeyboard', () => {
  it('builds two mutually-exclusive buttons with type-tagged data', () => {
    const kb = buildApprovalKeyboard();
    const buttons = kb.content.rows[0]?.buttons ?? [];
    expect(buttons).toHaveLength(2);

    const allow = buttons[0]!;
    expect(allow.action.type).toBe(1);
    expect(allow.action.click_limit).toBe(1);
    expect(JSON.parse(allow.action.data)).toEqual({ t: 'approval', d: 'allow' });

    const deny = buttons[1]!;
    expect(JSON.parse(deny.action.data)).toEqual({ t: 'approval', d: 'deny' });
  });
});

describe('buildApprovalText', () => {
  it('renders tool name, gated command and reason', () => {
    const req = makeRequest({ toolName: 'bash', reason: '用户要求列出文件' });
    const text = buildApprovalText(req, 'ls -la');
    expect(text).toContain('bash');
    expect(text).toContain('ls -la');
    expect(text).toContain('用户要求列出文件');
  });

  it('非当前会话：首行标来源（id + 标题），不再塞 [#id]', () => {
    const text = buildApprovalText(makeRequest({ toolName: 'bash' }), 'ls', {
      sessionId: 'session-04de1556-9c1f-4d6a-9b0e-1f2a3b4c5d6e',
      isCurrent: false,
      title: '修登录',
    });
    expect(text.startsWith('> `#04de1556` · 修登录\n\n')).toBe(true);
    expect(text).toContain('🔐 **执行审批**');
    expect(text).not.toContain('[#');
  });

  it('当前会话不标来源行', () => {
    const text = buildApprovalText(makeRequest({ toolName: 'bash' }), 'ls', {
      sessionId: 'session-04de1556',
      isCurrent: true,
    });
    expect(text.startsWith('> `#')).toBe(false);
  });
});

describe('ApprovalChannel.install', () => {
  it('routes QQ sessions to park and delegates others to next', async () => {
    const sent: SentMessage[] = [];
    const ch = new ApprovalChannel(
      createManager({ findBySessionId: (id) => (id === 'sess-qq' ? makeRecord(sessionKey('c2c', 'peer-qq')) : undefined) }),
      createSender(sent),
      makeConfig(),
      createLogger(),
    );
    const { handler } = installAndCapture(ch, sent);

    // 非 QQ 会话 → 委托 next
    const delegated = await handler(makeRequest({ id: 'sess-web' }), () => Promise.resolve('unavailable' as ApprovalOutcome));
    expect(delegated).toBe('unavailable');
    expect(sent).toHaveLength(0);

    // QQ 会话 → park（发消息 + 挂起）
    const p = handler(makeRequest({ id: 'sess-qq' }), () => Promise.resolve('unavailable' as ApprovalOutcome));
    await sleep(20);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.opts?.keyboard).toBeDefined();

    // 点击 allow → resolve allowed-once
    expect(ch.handleInteraction(makeEvent(buttonDataOf(sent, 'allow'), { user: 'peer-qq' }))).toBe(true);
    await expect(p).resolves.toBe('allowed-once');
  });

  it('recovers the gated command from the session log', async () => {
    const sent: SentMessage[] = [];
    const ch = new ApprovalChannel(
      createManager({ findBySessionId: (id) => (id === 'sess-qq' ? makeRecord(sessionKey('c2c', 'peer-qq')) : undefined) }),
      createSender(sent),
      makeConfig(),
      createLogger(),
    );
    const { handler } = installAndCapture(ch, sent);

    const events = [{ type: 'tool/call', data: { callId: 'c1', arguments: JSON.stringify({ command: 'ls -la' }) } }];
    const p = handler(makeRequest({ id: 'sess-qq', callId: 'c1', events }), () => Promise.resolve('unavailable' as ApprovalOutcome));
    await sleep(20);
    expect(sent[0]!.text).toContain('ls -la');

    ch.cancelPending(sessionKey('c2c', 'peer-qq'));
    await expect(p).resolves.toBe('cancelled');
  });

  it('registers a global waterfall listener without probing the approval service', () => {
    const ch = new ApprovalChannel(
      createManager({ findBySessionId: () => undefined }),
      createSender([]),
      makeConfig(),
      createLogger(),
    );
    const { handler, options } = installAndCapture(ch, []);
    expect(handler).toBeTypeOf('function');
    expect(options).toEqual({ global: true, prepend: true });
  });

  it('旧卡片（nonce 不匹配）点击不 settle，仅当前审批的 nonce 生效（#94-3）', async () => {
    const sent: SentMessage[] = [];
    const ch = new ApprovalChannel(
      createManager({
        findBySessionId: (id) => (id === 'sess-qq' ? makeRecord(sessionKey('c2c', 'peer-qq')) : undefined),
      }),
      createSender(sent),
      makeConfig('peer-qq'),
      createLogger(),
    );
    const { handler } = installAndCapture(ch, sent);

    const first = handler(makeRequest({ id: 'sess-qq' }), () => Promise.resolve('unavailable' as ApprovalOutcome));
    await sleep(20);
    // 第一张卡片作废（cancel）
    ch.cancelPending(sessionKey('c2c', 'peer-qq'));
    await expect(first).resolves.toBe('cancelled');

    // 第二次审批 → 新卡片（新 nonce）
    const second = handler(makeRequest({ id: 'sess-qq' }), () => Promise.resolve('unavailable' as ApprovalOutcome));
    await sleep(20);
    expect(sent).toHaveLength(2);

    // 用第一张卡片的 data（旧 nonce）点击 → 拒绝，审批保持挂起
    const staleData = extractButtonData(sent[0]!, 'allow');
    expect(ch.handleInteraction(makeEvent(staleData, { user: 'peer-qq' }))).toBe(false);

    // 新卡片 nonce 点击 → 放行
    expect(ch.handleInteraction(makeEvent(buttonDataOf(sent, 'allow'), { user: 'peer-qq' }))).toBe(true);
    await expect(second).resolves.toBe('allowed-once');
  });

  it('绑定用户：点击者身份缺失（无 user_openid）拒绝（fail-closed）', async () => {
    const sent: SentMessage[] = [];
    const ch = new ApprovalChannel(
      createManager({
        findBySessionId: (id) => (id === 'sess-qq' ? makeRecord(sessionKey('c2c', 'peer-qq')) : undefined),
      }),
      createSender(sent),
      makeConfig('peer-qq'),
      createLogger(),
    );
    const { handler } = installAndCapture(ch, sent);

    const p = handler(makeRequest({ id: 'sess-qq' }), () => Promise.resolve('unavailable' as ApprovalOutcome));
    await sleep(20);

    // 事件不带点击者标识 → 拒绝
    expect(ch.handleInteraction(makeEvent(buttonDataOf(sent, 'allow'), {}))).toBe(false);

    ch.cancelPending(sessionKey('c2c', 'peer-qq'));
    await expect(p).resolves.toBe('cancelled');
  });

  it('绑定用户：私聊卡片转发给他人点击无效', async () => {
    const sent: SentMessage[] = [];
    const ch = new ApprovalChannel(
      createManager({
        findBySessionId: (id) => (id === 'sess-qq' ? makeRecord(sessionKey('c2c', 'peer-qq')) : undefined),
      }),
      createSender(sent),
      makeConfig('peer-qq'),
      createLogger(),
    );
    const { handler } = installAndCapture(ch, sent);

    const p = handler(makeRequest({ id: 'sess-qq' }), () => Promise.resolve('unavailable' as ApprovalOutcome));
    await sleep(20);

    // 转发场景：点击者 user_openid ≠ 名单成员 → 无效
    expect(ch.handleInteraction(makeEvent(buttonDataOf(sent, 'allow'), { user: 'forwarded-user' }))).toBe(false);

    ch.cancelPending(sessionKey('c2c', 'peer-qq'));
    await expect(p).resolves.toBe('cancelled');
  });

  it('still sends the prompt when the session log is unavailable', async () => {
    const sent: SentMessage[] = [];
    const ch = new ApprovalChannel(
      createManager({ findBySessionId: (id) => (id === 'sess-qq' ? makeRecord(sessionKey('c2c', 'peer-qq')) : undefined) }),
      createSender(sent),
      makeConfig(),
      createLogger(),
    );
    const { handler } = installAndCapture(ch, sent);

    const p = handler(makeRequest({ id: 'sess-qq', noSession: true }), () => Promise.resolve('unavailable' as ApprovalOutcome));
    await sleep(20);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('bash');

    ch.cancelPending(sessionKey('c2c', 'peer-qq'));
    await expect(p).resolves.toBe('cancelled');
  });
});

describe('ApprovalChannel.handleInteraction', () => {
  it('settles deny as rejected and ignores unknown buttons', async () => {
    const sent: SentMessage[] = [];
    const ch = new ApprovalChannel(
      createManager({ findBySessionId: (id) => (id === 'sess-qq' ? makeRecord(sessionKey('c2c', 'peer-qq')) : undefined) }),
      createSender(sent),
      makeConfig(),
      createLogger(),
    );
    const { handler } = installAndCapture(ch, sent);

    const p = handler(makeRequest({ id: 'sess-qq' }), () => Promise.resolve('unavailable' as ApprovalOutcome));
    await sleep(20);

    // 非审批按钮 → false，不消费
    expect(ch.handleInteraction(makeEvent(JSON.stringify({ t: 'question', q: 'x', i: 0 }), { user: 'peer-qq' }))).toBe(false);
    // 拒绝 → rejected
    expect(ch.handleInteraction(makeEvent(buttonDataOf(sent, 'deny'), { user: 'peer-qq' }))).toBe(true);
    await expect(p).resolves.toBe('rejected');
  });
});

describe('ApprovalChannel.cancelPending', () => {
  it('cancels a pending approval on session eviction', async () => {
    const sent: SentMessage[] = [];
    const ch = new ApprovalChannel(
      createManager({ findBySessionId: (id) => (id === 'sess-qq' ? makeRecord(sessionKey('c2c', 'peer-qq')) : undefined) }),
      createSender(sent),
      makeConfig(),
      createLogger(),
    );
    const { handler } = installAndCapture(ch, sent);

    const p = handler(makeRequest({ id: 'sess-qq' }), () => Promise.resolve('unavailable' as ApprovalOutcome));
    await sleep(20);

    ch.cancelPending(sessionKey('c2c', 'peer-qq'));
    await expect(p).resolves.toBe('cancelled');
  });

  it('QQ 投递失败时把审批交回链上其他通道，不吞掉请求', async () => {
    const ch = new ApprovalChannel(
      createManager({ findBySessionId: (id) => (id === 'sess-qq' ? makeRecord(sessionKey('c2c', 'peer-qq')) : undefined) }),
      { sendMarkdown: vi.fn(async () => { throw new Error('network down'); }) },
      makeConfig(),
      createLogger(),
    );
    const { handler } = installAndCapture(ch, []);

    const delegated = vi.fn(async () => 'allowed-once' as ApprovalOutcome);
    await expect(handler(makeRequest({ id: 'sess-qq' }), delegated)).resolves.toBe('allowed-once');
    expect(delegated).toHaveBeenCalledTimes(1);
  });
});
