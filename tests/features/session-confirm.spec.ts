/**
 * 「重置会话」的二次确认卡片。
 *
 * 命令层把动作包成闭包交给这里，只有点了「确认」才执行；卡片过期、旧卡片、
 * 会话在点击前被换掉，都不能把动作跑掉。
 */
import { describe, it, expect, vi } from 'vitest';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import {
  SessionConfirmChannel,
  buildConfirmKeyboard,
  type SessionConfirmRequest,
} from '../../src/features/session-confirm.ts';
import { decodeButtonData } from '../../src/features/button-utils.ts';
import type { Logger, ReplyTarget } from '../../src/types.ts';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface SentMessage {
  text: string;
  opts?: { keyboard?: unknown };
}

function createSender(sent: SentMessage[], opts?: { fail?: boolean }) {
  const deliver = vi.fn(async (_target: ReplyTarget, content: string, o?: { keyboard?: unknown }) => {
    if (opts?.fail) throw new Error('send failed');
    sent.push({ text: content, opts: o });
  });
  return {
    text: vi.fn(async (target: ReplyTarget, content: string) => deliver(target, content)),
    card: vi.fn(async (target: ReplyTarget, content: string, keyboard?: unknown) => {
      await deliver(target, content, { keyboard });
    }),
  };
}

const target: ReplyTarget = { scope: 'c2c', targetId: 'U1' };

function createChannel(
  sent: SentMessage[],
  opts?: { fail?: boolean; currentId?: string | undefined; logger?: Logger },
) {
  const sender = createSender(sent, { fail: opts?.fail });
  const manager = { currentSessionId: () => opts?.currentId };
  const logger = opts?.logger ?? createLogger();
  const channel = new SessionConfirmChannel(manager, sender, { access: { owner: 'U1' } }, logger);
  return { channel, sender, logger };
}

function request(action: SessionConfirmRequest['action'] = 'reset', currentId?: string): SessionConfirmRequest {
  return {
    action,
    ...(currentId === undefined ? {} : { currentId }),
    target,
    run: vi.fn(async () => '✅ 已执行'),
  };
}

function makeEvent(data?: string, user: string | null | undefined = 'U1'): InteractionEvent {
  return {
    id: 'i1',
    type: 1,
    version: 1,
    ...(user !== undefined && user !== null ? { user_openid: user } : {}),
    data: { type: 1, resolved: { ...(data !== undefined ? { button_data: data } : {}) } },
  } as InteractionEvent;
}

/** 从卡片上取某个按钮的 button_data */
function buttonDataOf(keyboard: unknown, decision: 'yes' | 'no'): string {
  const rows = (keyboard as { content: { rows: { buttons: { action: { data: string } }[] }[] } }).content.rows;
  const buttons = rows[0]!.buttons;
  return decision === 'yes' ? buttons[0]!.action.data : buttons[1]!.action.data;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('buildConfirmKeyboard', () => {
  it('两个按钮都带 confirm 判别字段，确认是 primary、取消是 default', () => {
    const keyboard = buildConfirmKeyboard('n1');
    const yes = decodeButtonData(buttonDataOf(keyboard, 'yes'));
    const no = decodeButtonData(buttonDataOf(keyboard, 'no'));

    expect(yes).toEqual({ t: 'confirm', n: 'n1', d: 'yes' });
    expect(no).toEqual({ t: 'confirm', n: 'n1', d: 'no' });

    const buttons = keyboard.content.rows[0]!.buttons;
    expect(buttons[0]!.render_data.label).toBe('✅ 确认');
    expect(buttons[0]!.render_data.style).toBe(1);
    expect(buttons[1]!.render_data.label).toBe('❌ 取消');
    expect(buttons[1]!.render_data.style).toBe(0);
  });

  it('按钮只写「确认」，重置范围由正文交代', () => {
    expect(buildConfirmKeyboard('n2').content.rows[0]!.buttons[0]!.render_data.label).toBe('✅ 确认');
  });
});

describe('SessionConfirmChannel.offer', () => {
  it('重置发一张带键盘的卡片，正文点明会停掉当前会话', async () => {
    const sent: SentMessage[] = [];
    const { channel } = createChannel(sent);

    expect(await channel.offer(request('reset'))).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe(
      [
        '**⚠️ 确认重置会话**',
        '',
        '当前会话会停止。',
        '',
        '> 👇 点「确认」继续',
      ].join('\n'),
    );
    expect(sent[0]!.opts?.keyboard).toBeDefined();
  });

  it('/clear all 的正文点明全部会话都会停止', async () => {
    const sent: SentMessage[] = [];
    const { channel } = createChannel(sent);

    await channel.offer(request('reset-all'));

    expect(sent[0]!.text).toContain('**⚠️ 确认重置全部会话**');
    expect(sent[0]!.text).toContain('全部会话都会停止。');
    expect(sent[0]!.text).toContain('> 👇 点「确认」继续');
  });

  it('发送失败返回 false，调用方应放弃本次动作', async () => {
    const sent: SentMessage[] = [];
    const logger = createLogger();
    const { channel } = createChannel(sent, { fail: true, logger });

    expect(await channel.offer(request('reset'))).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('新卡片作废旧卡片：旧 nonce 点了没有反应', async () => {
    const sent: SentMessage[] = [];
    const { channel } = createChannel(sent);

    await channel.offer(request('reset'));
    const stale = buttonDataOf(sent[0]!.opts?.keyboard, 'yes');
    await channel.offer(request('reset'));

    expect(channel.handleInteraction(makeEvent(stale))).toBe(false);
    expect(sent).toHaveLength(2);
  });
});

describe('SessionConfirmChannel.handleInteraction', () => {
  it('非 owner 点击不执行闭包，缺身份同样拒绝', async () => {
    const sent: SentMessage[] = [];
    const { channel } = createChannel(sent);
    const req = request('reset');
    await channel.offer(req);
    const yes = buttonDataOf(sent[0]!.opts?.keyboard, 'yes');

    expect(channel.handleInteraction(makeEvent(yes, 'U2'))).toBe(false);
    expect(channel.handleInteraction(makeEvent(yes, null))).toBe(false);
    expect(req.run).not.toHaveBeenCalled();
  });

  it('点确认：执行闭包并把回执发回聊天', async () => {
    const sent: SentMessage[] = [];
    const { channel } = createChannel(sent);
    const req = request('reset');
    await channel.offer(req);

    expect(channel.handleInteraction(makeEvent(buttonDataOf(sent[0]!.opts?.keyboard, 'yes')))).toBe(true);
    await sleep(0);

    expect(req.run).toHaveBeenCalledTimes(1);
    expect(sent[1]!.text).toBe('✅ 已执行');
  });

  it('点取消：只回「已取消」，不执行', async () => {
    const sent: SentMessage[] = [];
    const { channel } = createChannel(sent);
    const req = request('reset');
    await channel.offer(req);

    expect(channel.handleInteraction(makeEvent(buttonDataOf(sent[0]!.opts?.keyboard, 'no')))).toBe(true);
    await sleep(0);

    expect(req.run).not.toHaveBeenCalled();
    expect(sent[1]!.text).toBe('✅ 已取消');
  });

  it('卡片发出后会话被换掉：拒绝执行，提示重新发命令', async () => {
    const sent: SentMessage[] = [];
    const { channel } = createChannel(sent, { currentId: 'sess-2' });
    const req = request('reset', 'sess-1');
    await channel.offer(req);

    channel.handleInteraction(makeEvent(buttonDataOf(sent[0]!.opts?.keyboard, 'yes')));
    await sleep(0);

    expect(req.run).not.toHaveBeenCalled();
    expect(sent[1]!.text).toBe('⚠️ 当前会话已变化，重新发一次命令。');
  });

  it('执行抛错时回原因，不让异常冒到网关', async () => {
    const sent: SentMessage[] = [];
    const { channel } = createChannel(sent);
    const req: SessionConfirmRequest = {
      action: 'reset',
      target,
      run: vi.fn(async () => {
        throw new Error('db locked');
      }),
    };
    await channel.offer(req);

    channel.handleInteraction(makeEvent(buttonDataOf(sent[0]!.opts?.keyboard, 'yes')));
    await sleep(0);

    expect(sent[1]!.text).toBe('❌ 操作失败: db locked\n稍等片刻再试一次。');
  });

  it('不是 confirm 的按钮 / 没有 nonce 一律忽略', async () => {
    const { channel } = createChannel([]);
    expect(channel.handleInteraction(makeEvent(JSON.stringify({ t: 'retry', s: 'x', d: 'resend' })))).toBe(false);
    expect(channel.handleInteraction(makeEvent())).toBe(false);
  });

  it('cancelPending 之后卡片失效', async () => {
    const sent: SentMessage[] = [];
    const { channel } = createChannel(sent);
    const req = request('reset');
    await channel.offer(req);

    channel.cancelPending();
    expect(channel.handleInteraction(makeEvent(buttonDataOf(sent[0]!.opts?.keyboard, 'yes')))).toBe(false);
    expect(req.run).not.toHaveBeenCalled();
  });
});
