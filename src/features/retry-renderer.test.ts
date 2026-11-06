/**
 * 轮次失败文案：先把宿主原文收敛成「原因 + 下一步」，再由通道决定挂不挂按钮。
 */
import { describe, it, expect } from 'vitest';
import {
  RETRYABLE_FAILURE_CODES,
  buildRetryKeyboard,
  formatReason,
  formatRetryNotice,
  formatRetryOffer,
  formatTurnFailure,
} from './retry-renderer.ts';

const rateLimited = {
  code: 'RATE_LIMIT',
  message: '429: {"type":"server_error","message":"Upstream request failed: [overloaded]"}',
};

describe('RETRYABLE_FAILURE_CODES', () => {
  it('只把瞬时故障算作可重试，鉴权类错误不在其中', () => {
    expect(RETRYABLE_FAILURE_CODES.has('RATE_LIMIT')).toBe(true);
    expect(RETRYABLE_FAILURE_CODES.has('SERVER')).toBe(true);
    expect(RETRYABLE_FAILURE_CODES.has('EMPTY_RESPONSE')).toBe(true);
    expect(RETRYABLE_FAILURE_CODES.has('AUTH')).toBe(false);
    expect(RETRYABLE_FAILURE_CODES.has('INVALID_REQUEST')).toBe(false);
  });
});

describe('formatReason', () => {
  it('保留上游原文（完整 JSON 不删）', () => {
    expect(formatReason(rateLimited.code, rateLimited.message)).toBe(
      '原因: `RATE_LIMIT` · 429: {"type":"server_error","message":"Upstream request failed: [overloaded]"}',
    );
  });

  it('没有消息时只留错误码', () => {
    expect(formatReason('SERVER', '   ')).toBe('原因: `SERVER`');
  });

  it('换行折成空格，长文本截断并标注', () => {
    expect(formatReason('SERVER', '\n\nupstream 502\n')).toBe('原因: `SERVER` · upstream 502');
    const long = formatReason('SERVER', 'x'.repeat(2000));
    expect(long.endsWith('…（已截断）')).toBe(true);
    expect(long.length).toBeLessThan(1600);
  });
});

describe('formatRetryNotice', () => {
  it('给出第几次重试、等多久、上游原文', () => {
    const text = formatRetryNotice({
      retry: 4,
      maxRetries: 10,
      delayMs: 4000,
      failure: rateLimited,
    });
    expect(text.split('\n')[0]).toBe('⏳ 第 4/10 次重试 · 4.0s 后发起');
    expect(text).toContain('原因: `RATE_LIMIT` · 429: {"type":"server_error"');
  });

  it('always 模式没有配额、短退避用 ms', () => {
    const text = formatRetryNotice({ retry: 5, delayMs: 500, failure: rateLimited });
    expect(text.split('\n')[0]).toBe('⏳ 第 5 次重试 · 500ms 后发起');
  });

  it('没有 failure 时只发一行', () => {
    expect(formatRetryNotice({ retry: 4 })).toBe('⏳ 第 4 次重试');
  });
});

describe('formatTurnFailure', () => {
  it('可重试失败降级文本时补一行 /retry', () => {
    const text = formatTurnFailure({ code: 'RATE_LIMIT', message: '429: boom' }, true);
    expect(text.split('\n')[0]).toBe('❌ 本轮失败');
    expect(text).toContain('原因: `RATE_LIMIT` · 429: boom');
    expect(text).toContain('> 💡 发送 `/retry` 重跑上一条消息');
  });

  it('没有可重试原文时只给原因', () => {
    const text = formatTurnFailure({ code: 'NO_ADAPTER', message: 'no adapter registered' }, false);
    expect(text).not.toContain('/retry');
    expect(text).toBe('❌ 本轮失败\n原因: `NO_ADAPTER` · no adapter registered');
  });
});

describe('formatRetryOffer', () => {
  it('带真实重试次数', () => {
    const text = formatRetryOffer(rateLimited, 5, true);
    expect(text.split('\n')[0]).toBe('⚠️ 上游服务异常，重试 5 次未成功');
    expect(text).toContain('原因: `RATE_LIMIT` · 429');
    expect(text).toContain('> 👇 点「重发」重跑上一条消息');
  });

  it('一次都没重试（如 Retry-After 超限）时不提次数', () => {
    expect(formatRetryOffer(rateLimited, 0, true).split('\n')[0]).toBe('⚠️ 上游服务异常');
  });

  it('键盘不可用时改成 /retry 提示，事实不变', () => {
    const text = formatRetryOffer(rateLimited, 3, false);
    expect(text).toContain('⚠️ 上游服务异常，重试 3 次未成功');
    expect(text).toContain('> 💡 发送 `/retry` 重跑上一条消息');
    expect(text).not.toContain('点「重发」');
  });
});

describe('buildRetryKeyboard', () => {
  it('一行两个按钮，label 与 visited_label 成对', () => {
    const keyboard = buildRetryKeyboard('sess-1') as {
      content: { rows: Array<{ buttons: Array<Record<string, unknown>> }> };
    };
    const buttons = keyboard.content.rows[0]?.buttons ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.render_data).toMatchObject({ label: '🔁 重发', visited_label: '✓ 已重发' });
    expect(buttons[1]?.render_data).toMatchObject({ label: '❌ 放弃', visited_label: '✓ 已放弃' });

    const resend = JSON.parse(String((buttons[0]?.action as { data: string }).data));
    const discard = JSON.parse(String((buttons[1]?.action as { data: string }).data));
    expect(resend).toEqual({ t: 'retry', s: 'sess-1', d: 'resend' });
    expect(discard).toEqual({ t: 'retry', s: 'sess-1', d: 'discard' });
  });

  it('没有会话 id 时不带 s', () => {
    const keyboard = buildRetryKeyboard() as {
      content: { rows: Array<{ buttons: Array<Record<string, unknown>> }> };
    };
    const data = (keyboard.content.rows[0]?.buttons[0]?.action as { data: string }).data;
    expect(JSON.parse(String(data))).toEqual({ t: 'retry', d: 'resend' });
  });
});
