/**
 * 连接可用回调：ready 与 resumed 都要触发恢复流程
 *
 * 热重载后的新实例是 RESUME 接上的，SDK 只发 resumed——只挂 ready 的话，
 * 「补发重载结果」和「接回上次会话」都会静默失效。
 */
import { describe, it, expect, vi } from 'vitest';
import { onGatewayConnected } from '../../src/gateway/bootstrap.ts';

interface FakeBot {
  on: (event: string, listener: () => void) => void;
  emit: (event: string) => void;
}

function fakeBot(): FakeBot {
  const listeners = new Map<string, Array<() => void>>();
  return {
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit: (event) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

describe('onGatewayConnected', () => {
  it('ready 与 resumed 都会回调，并带上事件名', () => {
    const bot = fakeBot();
    const handler = vi.fn();
    onGatewayConnected(bot as unknown as Parameters<typeof onGatewayConnected>[0], handler);

    bot.emit('ready');
    bot.emit('resumed');

    expect(handler.mock.calls).toEqual([['ready'], ['resumed']]);
  });
});
