/**
 * 未知指令守卫：拼错的 /xxx 在 QQ 侧直接拒绝，不转发给大模型
 *
 * 只测守卫本身（中间件 + 解析/建议的纯函数），不碰真实网关与 profile。
 */
import { describe, it, expect, vi } from 'vitest';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import {
  buildUnknownCommandReply,
  collectCommandNames,
  parseCommandCandidate,
  rejectUnknownCommands,
  suggestCommand,
} from './unknown-command.ts';

/** 与 buildCommandList 一致的名字/别名集合（含别名与隐藏的 /stop） */
const COMMANDS = [
  'new',
  'reset',
  'clear',
  'compact',
  'sessions',
  'session',
  'rename',
  'to',
  'ls',
  'model',
  'reasoning',
  'think',
  'cost',
  'status',
  'preset',
  'permission',
  'stop',
  'bot-ping',
  'bot-version',
  'bot-me',
  'bot-status',
  'bot-help',
];

interface Harness {
  ctx: MiddlewareContext;
  next: ReturnType<typeof vi.fn>;
  markdown: string[];
  text: string[];
  isStopped: () => boolean;
  stopReason: () => string | undefined;
}

interface HarnessOptions {
  markdownFails?: boolean;
  textFails?: boolean;
}

function makeHarness(content: string, options: HarnessOptions = {}): Harness {
  const markdown: string[] = [];
  const text: string[] = [];
  let stopped = false;
  let reason: string | undefined;

  const bot = {
    sendMarkdown: vi.fn(async (_target: unknown, chunk: string) => {
      if (options.markdownFails === true) throw new Error('markdown denied');
      markdown.push(chunk);
      return { id: 'm2' };
    }),
    sendText: vi.fn(async (_target: unknown, chunk: string) => {
      if (options.textFails === true) throw new Error('text denied');
      text.push(chunk);
      return { id: 'm3' };
    }),
  };

  const ctx = {
    bot,
    message: {
      content,
      senderId: 'u1',
      kind: 'c2c',
      messageId: 'm1',
    },
    replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'm1' },
    state: {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    stop: (stopReason?: string) => {
      stopped = true;
      reason = stopReason;
    },
    get stopped() {
      return stopped;
    },
    get stopReason() {
      return reason;
    },
    receivedAt: Date.now(),
  } as unknown as MiddlewareContext;

  return {
    ctx,
    next: vi.fn(async () => undefined),
    markdown,
    text,
    isStopped: () => stopped,
    stopReason: () => reason,
  };
}

async function run(content: string, options: HarnessOptions = {}): Promise<Harness> {
  const harness = makeHarness(content, options);
  const guard = rejectUnknownCommands({ commandNames: COMMANDS });
  await guard(harness.ctx, harness.next);
  return harness;
}

describe('parseCommandCandidate（只把明确的指令形态当指令）', () => {
  it('识别半角与全角前缀', () => {
    expect(parseCommandCandidate('/model')).toEqual({ raw: 'model', name: 'model', prefix: '/' });
    expect(parseCommandCandidate('／bot-help')).toEqual({ raw: 'bot-help', name: 'bot-help', prefix: '／' });
  });

  it('保留大小写与尾部标点用于回显，名字归一化成小写', () => {
    expect(parseCommandCandidate('/Model?')).toEqual({ raw: 'Model?', name: 'model', prefix: '/' });
    expect(parseCommandCandidate('/status。')).toEqual({ raw: 'status。', name: 'status', prefix: '/' });
  });

  it('普通文本不当作指令：路径、中文、纯斜杠、斜杠后空格', () => {
    for (const content of ['/usr/local/bin', '/今天天气怎么样', '/', '/ model', 'hello /model', '// model']) {
      expect(parseCommandCandidate(content), content).toBeUndefined();
    }
  });

  it('忽略 QQ 的 @ 标记后再判定', () => {
    expect(parseCommandCandidate('<@!123456> /modle')).toEqual({
      raw: 'modle',
      name: 'modle',
      prefix: '/',
    });
  });
});

describe('suggestCommand（编辑距离建议）', () => {
  it('给出最接近的指令', () => {
    expect(suggestCommand('modle', COMMANDS)).toBe('model');
    expect(suggestCommand('stp', COMMANDS)).toBe('stop');
    expect(suggestCommand('sesions', COMMANDS)).toBe('sessions');
    expect(suggestCommand('bot-hel', COMMANDS)).toBe('bot-help');
    expect(suggestCommand('model', COMMANDS)).toBe('model');
  });

  it('差得太远就不硬给建议', () => {
    expect(suggestCommand('zzzzzzz', COMMANDS)).toBeUndefined();
    expect(suggestCommand('foo', COMMANDS)).toBeUndefined();
  });

  it('别名也算建议目标', () => {
    expect(suggestCommand('resett', COMMANDS)).toBe('reset');
  });
});

describe('buildUnknownCommandReply', () => {
  const base = { raw: 'modle', name: 'modle', prefix: '/' };

  it('有建议时带可点击指令按钮', () => {
    const reply = buildUnknownCommandReply(base, 'model');
    expect(reply.markdown).toContain('没有 `/modle` 这个指令');
    expect(reply.markdown).toContain('text="/model"');
    // 建议本身就是下一步：不再追加通用的 /bot-help 提示
    expect(reply.markdown.split('\n')).toHaveLength(2);
    expect(reply.text).toContain('你想用的是不是 /model？');
    expect(reply.text).not.toContain('<qqbot-cmd-input');
  });

  it('没有建议时提示去掉斜杠再发', () => {
    const reply = buildUnknownCommandReply({ raw: 'zzzzzzz', name: 'zzzzzzz', prefix: '/' }, undefined);
    expect(reply.markdown).toContain('如果只是普通文本');
    expect(reply.markdown).toContain('/bot-help');
    expect(reply.markdown).not.toContain('qqbot-cmd-input');
  });

  it('全角前缀额外提示用半角', () => {
    const reply = buildUnknownCommandReply({ raw: 'sesions', name: 'sesions', prefix: '／' }, 'sessions');
    expect(reply.markdown).toContain('半角');
    expect(reply.markdown).toContain('没有 `／sesions` 这个指令');
  });
});

describe('collectCommandNames', () => {
  it('展平别名且保留顺序', () => {
    expect(collectCommandNames([{ name: 'new' }, { name: ['sessions', 'session'] }])).toEqual([
      'new',
      'sessions',
      'session',
    ]);
  });
});

describe('rejectUnknownCommands（中间件行为）', () => {
  it('拼错的指令：回复建议并中止链路，不进大模型', async () => {
    const h = await run('/modle');
    expect(h.next).not.toHaveBeenCalled();
    expect(h.isStopped()).toBe(true);
    expect(h.stopReason()).toBe('command:unknown:modle');
    expect(h.markdown).toHaveLength(1);
    expect(h.markdown[0]).toContain('没有 `/modle`');
    expect(h.markdown[0]).toContain('text="/model"');
  });

  it('已注册指令不拦截（正常由 slashCommand 提前短路）', async () => {
    for (const content of ['/model', '/bot-help', '/new', '/sessions 2']) {
      const h = await run(content);
      expect(h.next, content).toHaveBeenCalledTimes(1);
      expect(h.isStopped(), content).toBe(false);
      expect(h.markdown, content).toHaveLength(0);
    }
  });

  it('普通文本与路径照旧转发', async () => {
    for (const content of ['帮我看看 /etc/hosts', '/usr/local/bin', '/']) {
      const h = await run(content);
      expect(h.next, content).toHaveBeenCalledTimes(1);
      expect(h.isStopped(), content).toBe(false);
    }
  });

  it('markdown 发不出去时退纯文本，仍然拦截', async () => {
    const h = await run('/modle', { markdownFails: true });
    expect(h.isStopped()).toBe(true);
    expect(h.text).toHaveLength(1);
    expect(h.text[0]).toContain('没有 /modle');
    expect(h.text[0]).toContain('/model');
  });

  it('两种发送都失败时退回正常转发，不静默丢消息', async () => {
    const h = await run('/modle', { markdownFails: true, textFails: true });
    expect(h.isStopped()).toBe(false);
    expect(h.next).toHaveBeenCalledTimes(1);
    expect(h.ctx.log.error).toHaveBeenCalled();
  });

  it('全角前缀的拼错指令也能识别', async () => {
    const h = await run('／sesions');
    expect(h.isStopped()).toBe(true);
    expect(h.markdown[0]).toContain('半角');
    expect(h.markdown[0]).toContain('text="/sessions"');
  });

  it('尾部带标点的手滑（/model?）按拼错处理并给出建议', async () => {
    const h = await run('/model?');
    expect(h.isStopped()).toBe(true);
    expect(h.markdown[0]).toContain('`/model?`');
    expect(h.markdown[0]).toContain('text="/model"');
  });
});
