/**
 * QQ 用户消息的来源标记
 *
 * 回归点：`source.kind` 曾经写成 `'qqbot'`，宿主的会话标题服务只对
 * `kind === 'user'` 的消息排期，导致所有新建 QQ 会话都显示「未命名会话」。
 */
import { describe, expect, it } from 'vitest';
import { createQQUserMessage } from './user-message.ts';

describe('createQQUserMessage', () => {
  it('source.kind 是 user，宿主才会把它当人类消息（标题 / 大纲 / 最近提问）', () => {
    const message = createQQUserMessage('你好') as {
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
      source?: { kind?: string };
    };

    expect(message.role).toBe('user');
    expect(message.source?.kind).toBe('user');
    expect(message.content).toEqual([{ type: 'text', text: '你好' }]);
  });
});
