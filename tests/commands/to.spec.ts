/**
 * `/to` 命令：目标解析、四条结果分支与「不改 current」的调用约定。
 *
 * manager 用替身，只验证命令层拼装；会话获取与答案通道的细节由
 * session-admin.spec.ts / question-channel.spec.ts 覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type QQTermConfig } from '../../src/config.ts';
import type { SessionManager, SessionRecord, WorkspaceGroup, WorkspaceSession } from '../../src/session/index.ts';
import type { Logger } from '../../src/types.ts';
import { toCommand } from '../../src/commands/to.ts';
import type { InboundQuoteState } from '../../src/transport/inbound-state.ts';

const state = vi.hoisted(() => ({ sent: [] as string[] }));

vi.mock('../../src/shared/send-helper.ts', () => ({
  sendMarkdownChunked: async (_ctx: unknown, content: string): Promise<void> => {
    state.sent.push(content);
  },
}));

const config = ConfigSchema({ appId: 'app', appSecret: 'secret' } as QQTermConfig);
const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const TARGET = 'session-3f2a9b1c-1111-1111-1111-111111111111';
const CURRENT = 'session-9d2c4410-2222-2222-2222-222222222222';

function entry(over: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    id: TARGET,
    title: '目标会话',
    createdAt: 1,
    updatedAt: 1,
    current: false,
    live: true,
    held: false,
    running: false,
    isSeeded: false,
    archived: false,
    ...over,
  };
}

function groups(sessions: WorkspaceSession[] = [entry()]): WorkspaceGroup[] {
  return [{ id: 'ws', title: 'repo', path: '/repo', missing: false, sessions }];
}

type SendToResult = Awaited<ReturnType<SessionManager['sendTo']>>;

function makeManager(over: {
  groups?: WorkspaceGroup[];
  sendTo?: SendToResult;
  live?: boolean;
  record?: SessionRecord;
  current?: boolean;
  canSteer?: boolean;
  awaiting?: boolean;
} = {}) {
  return {
    listWorkspaceGroups: vi.fn(async () => over.groups ?? groups()),
    fillSessionTitles: vi.fn(async () => {}),
    hasLiveSession: vi.fn(() => over.live ?? true),
    findBySessionId: vi.fn(() => over.record),
    isCurrentSession: vi.fn(() => over.current ?? false),
    canSteer: vi.fn(() => over.canSteer ?? true),
    isAwaitingAnswer: vi.fn(() => over.awaiting ?? false),
    sendTo: vi.fn(async () => over.sendTo ?? { ok: true, kind: 'sent', sessionId: TARGET }),
  } as unknown as SessionManager;
}

function makeCtx(raw: string, quote?: InboundQuoteState): SlashCommandHandlerContext {
  return {
    message: { senderId: 'user1', kind: 'c2c', messageId: 'm1' },
    command: { raw },
    state: quote === undefined ? {} : { quote },
  } as unknown as SlashCommandHandlerContext;
}

async function run(manager: SessionManager, raw: string, quote?: InboundQuoteState): Promise<string> {
  state.sent.length = 0;
  const command = toCommand({ manager, config, logger });
  const result = await command.handler(makeCtx(raw, quote));
  return typeof result === 'string' ? result : state.sent.at(-1) ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/to', () => {
  it('不带 -- 的旧写法按参数错误回绝，不发送', async () => {
    const manager = makeManager();

    const text = await run(manager, '#3f2a9b1c 旧写法正文');

    expect(text).toBe('⚠️ 正文要写在 -- 之后 · 用法: /help to');
    expect(manager.sendTo).not.toHaveBeenCalled();
  });

  it('按短 id 找到目标，-- 之后整段是正文，且不改 current', async () => {
    const manager = makeManager();

    const text = await run(manager, '#3f2a9b1c -- 继续修登录');

    expect(text).toBe('✅ 已发送到「目标会话」 · `#3f2a9b1c`');
    expect(manager.sendTo).toHaveBeenCalledWith(
      'c2c',
      'user1',
      'user1',
      TARGET,
      '继续修登录',
      { scope: 'c2c', targetId: 'user1' },
    );
  });

  it('-- 后面的正文不必包引号：dash 开头的词照原样发', async () => {
    const manager = makeManager();

    await run(manager, '#3f2a9b1c -- --foo bar');

    expect(manager.sendTo).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), TARGET, '--foo bar',
      expect.anything(),
    );
  });

  it('只有 -- 时正文为空，与不带正文同一条路', async () => {
    const manager = makeManager({ sendTo: { ok: false, reason: 'empty', sessionId: TARGET } });

    expect(await run(manager, '#3f2a9b1c --')).toContain('缺少文本');
    expect(manager.sendTo).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), TARGET, '',
      expect.anything(),
    );
  });

  it('--foo 不是分隔符，同样按旧写法回绝', async () => {
    const manager = makeManager();

    expect(await run(manager, '#3f2a9b1c --foo')).toBe('⚠️ 正文要写在 -- 之后 · 用法: /help to');
    expect(manager.sendTo).not.toHaveBeenCalled();
  });

  it('没有正文时 -- 可省：只给目标就是空正文', async () => {
    const manager = makeManager({ sendTo: { ok: true, kind: 'answer-mode', sessionId: TARGET } });

    expect(await run(manager, '#3f2a9b1c')).toBe('💡 请发送回答: 「目标会话」 · `#3f2a9b1c`');
    expect(manager.sendTo).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), TARGET, '',
      expect.anything(),
    );
  });

  it('目标正在生成时按排队回执，带这条消息的插话入口', async () => {
    const manager = makeManager({
      current: true,
      sendTo: { ok: true, kind: 'queued', sessionId: TARGET, messageId: 'm-1' },
    });

    const text = await run(manager, '#3f2a9b1c -- 继续修登录');

    expect(text).toContain('✅ 已排队 · 本轮结束后发送');
    expect(text).toContain('/steer #3f2a9b1c m-1');
    expect(text).toContain('插话');
    // 命令的纯文本回复不渲染标签，排队回执必须走 markdown
    expect(state.sent.at(-1)).toBe(text);
  });

  it('目标正在生成且核心设为插话：回执说已插话，不给入口', async () => {
    const manager = makeManager({
      current: true,
      sendTo: { ok: true, kind: 'steered', sessionId: TARGET, messageId: 'm-1' },
    });

    const text = await run(manager, '#3f2a9b1c -- 继续修登录');

    expect(text).toBe('✅ 已插话 · 下一步生效');
    expect(text).not.toContain('/steer');
    expect(state.sent.at(-1)).toBe(text);
  });

  it('别的会话排队：回执带标题与短 id，不冒充当前会话', async () => {
    const manager = makeManager({
      canSteer: false,
      sendTo: { ok: true, kind: 'queued', sessionId: TARGET, messageId: 'm-1' },
    });

    expect(await run(manager, '#3f2a9b1c -- hi'))
      .toBe('✅ 已排队 · 「目标会话」 · `#3f2a9b1c`');
  });

  it('目标在等答案时回「已回答」，不冒充新 prompt', async () => {
    const manager = makeManager({ sendTo: { ok: true, kind: 'answered', sessionId: TARGET } });
    expect(await run(manager, `#3f2a9b1c -- 2`)).toBe('✅ 已回答「目标会话」 · `#3f2a9b1c`');
  });

  it('空文本 + 有待答问题时进入回答模式', async () => {
    const manager = makeManager({ sendTo: { ok: true, kind: 'answer-mode', sessionId: TARGET } });
    expect(await run(manager, '#3f2a9b1c --')).toBe('💡 请发送回答: 「目标会话」 · `#3f2a9b1c`');
    expect(manager.sendTo).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), TARGET, '',
      expect.anything(),
    );
  });

  it('没有这个会话时给短 id 提示，不再让人先 resume', async () => {
    const manager = makeManager({ sendTo: { ok: false, reason: 'not-found', sessionId: TARGET } });
    const text = await run(manager, `#3f2a9b1c -- hi`);
    expect(text).toContain('没有这个会话');
    expect(text).toContain('「目标会话」 · `#3f2a9b1c`');
    expect(text).not.toContain('/sessions resume');
  });

  it('目标被别的客户端占着时给原因与下一步', async () => {
    const manager = makeManager({ sendTo: { ok: false, reason: 'locked', sessionId: TARGET } });
    const text = await run(manager, `#3f2a9b1c -- hi`);
    expect(text).toContain('正在别处使用');
    expect(text).toContain('等它释放后再发一次');
  });

  it('列表里没有、但有 live 会话时，名字从会话日志的标题取', async () => {
    const manager = makeManager({
      groups: groups([entry({ id: CURRENT })]),
      record: {
        sessionId: TARGET,
        agent: { session: { snapshotEvents: () => [{ type: 'session/title', data: { title: '日志标题' } }] } },
      } as unknown as SessionRecord,
    });
    const text = await run(manager, `${TARGET} -- hi`);
    expect(text).toBe('✅ 已发送到「日志标题」 · `#3f2a9b1c`');
  });

  it('空文本且没有待答问题时提示用法', async () => {
    const manager = makeManager({ sendTo: { ok: false, reason: 'empty', sessionId: TARGET } });
    expect(await run(manager, '#3f2a9b1c --')).toContain('缺少文本');
  });

  it('已归档的目标拒绝，并给取消归档入口', async () => {
    const manager = makeManager({ sendTo: { ok: false, reason: 'archived', sessionId: TARGET } });
    const text = await run(manager, '#3f2a9b1c -- hi');
    expect(text).toContain('该会话已归档');
    expect(text).toContain('/sessions unarchive #3f2a9b1c');
    // 归档与否由会话层判定，命令层不预读
    expect(manager.sendTo).toHaveBeenCalledTimes(1);
  });

  it('列表里没有、也没有 live agent 时给短 id 提示', async () => {
    const manager = makeManager({ groups: groups([entry({ id: CURRENT })]), live: false });
    const text = await run(manager, '#3f2a9b1c -- hi');
    expect(text).toContain('没有匹配的会话');
  });

  it('缺少会话参数时给用法', async () => {
    const manager = makeManager();
    expect(await run(manager, '')).toContain('缺少会话');
    expect(manager.sendTo).not.toHaveBeenCalled();
  });

  it('带引用时把引用块拼在正文前面，回执贴 📎', async () => {
    const manager = makeManager();

    const text = await run(manager, '#3f2a9b1c -- 继续修登录', {
      source: 'msg_elements',
      text: '上次的报错栈',
    });

    expect(manager.sendTo).toHaveBeenCalledWith(
      'c2c',
      'user1',
      'user1',
      TARGET,
      '[Quoted message begins]\n上次的报错栈\n[Quoted message ends]\n[Current message]\n继续修登录',
      { scope: 'c2c', targetId: 'user1' },
    );
    expect(text).toBe('✅ 已发送到「目标会话」 · `#3f2a9b1c`\n📎 已带上引用');
  });

  it('只有引用没有正文时，整条消息就是引用块', async () => {
    const manager = makeManager();

    await run(manager, '#3f2a9b1c --', { source: 'msg_elements', text: '只有引用' });

    expect(manager.sendTo).toHaveBeenCalledWith(
      'c2c',
      'user1',
      'user1',
      TARGET,
      '[Quoted message begins]\n只有引用\n[Quoted message ends]',
      { scope: 'c2c', targetId: 'user1' },
    );
  });

  it('目标在等回答时不带引用，回执说明为什么', async () => {
    const manager = makeManager({
      awaiting: true,
      sendTo: { ok: true, kind: 'answered', sessionId: TARGET },
    });

    const text = await run(manager, '#3f2a9b1c -- 2', { source: 'msg_elements', text: '引用原文' });

    expect(manager.sendTo).toHaveBeenCalledWith(
      'c2c', 'user1', 'user1', TARGET, '2', { scope: 'c2c', targetId: 'user1' },
    );
    expect(text).toBe('✅ 已回答「目标会话」 · `#3f2a9b1c`\n💡 目标在等回答，引用这次没有一起发送');
  });

  it('引用取不到时什么都不发', async () => {
    const manager = makeManager();

    const text = await run(manager, '#3f2a9b1c -- hi', { source: 'none' });

    expect(text).toBe('❌ 引用内容取不到，没有执行');
    expect(manager.sendTo).not.toHaveBeenCalled();
  });
});
