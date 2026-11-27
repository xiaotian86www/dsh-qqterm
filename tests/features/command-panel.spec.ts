/**
 * 指令面板同步：元素构造（宽度/截断/场景筛选）与创建/更新语义
 */
import { describe, it, expect, vi } from 'vitest';
import type { SlashCommand } from '../../src/commands/types.ts';
import type { OpenApiLike } from '../../src/types.ts';
import {
  PANEL_DESC_MAX,
  PANEL_MAX_ITEMS,
  PANEL_NAME_MAX,
  PANEL_REMARK,
  buildPanelItems,
  clipPanelText,
  displayWidth,
  formatPanelSummary,
  listPanelCommands,
  syncCommandPanels,
} from '../../src/features/command-panel.ts';

function cmd(
  name: string | string[],
  description?: string,
  scope: 'c2c' | 'all' = 'all',
): SlashCommand {
  return { name, description, scope, handler: () => 'ok' } as SlashCommand;
}

describe('buildPanelItems（能力门控）', () => {
  it('不可用的命令不进面板，能力翻转后重新同步可见', () => {
    let available = false;
    const gated = { ...cmd('steer', '插话排队消息'), available: () => available } as SlashCommand;
    const names = (): string[] =>
      buildPanelItems([cmd('new', '新建会话'), gated], ['new', 'steer']).map((item) => item.name);

    expect(names()).not.toContain('/steer');
    available = true;
    expect(names()).toContain('/steer');
  });
});
interface Call {
  method: 'get' | 'post' | 'put' | 'delete';
  path: string;
  body?: unknown;
}

function makeApi(records: Array<{ panel_id: string; panel?: { remark?: string } }> = []) {
  const calls: Call[] = [];
  const api = {
    get: async (path: string, query?: Record<string, string | number | boolean>) => {
      calls.push({ method: 'get', path, body: query });
      return { records, is_end: true, next_cursor: '' };
    },
    post: async (path: string, body?: unknown) => {
      calls.push({ method: 'post', path, body });
      return { panel_id: 'p_new' };
    },
    put: async (path: string, body?: unknown) => {
      calls.push({ method: 'put', path, body });
      return { version: 2 };
    },
    delete: async (path: string) => {
      calls.push({ method: 'delete', path });
      return {};
    },
  } as unknown as OpenApiLike;
  return { api, calls };
}

describe('displayWidth / clipPanelText（平台口径：汉字算 2）', () => {
  it('ASCII 与中文的宽度', () => {
    expect(displayWidth('/help')).toBe(5);
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('a中')).toBe(3);
  });

  it('未超限原样返回，空白折叠成一个空格', () => {
    expect(clipPanelText('  查看  版本  ', 30)).toBe('查看 版本');
  });

  it('超限截断补省略号，且总宽度不超过上限', () => {
    const long = '测试当前 dsh 与 QQ 连接的网络延迟';
    const clipped = clipPanelText(long, PANEL_DESC_MAX);
    expect(clipped.endsWith('…')).toBe(true);
    expect(displayWidth(clipped)).toBeLessThanOrEqual(PANEL_DESC_MAX);
    expect(long).toContain(clipped.slice(0, -1).trim());
  });
});

describe('buildPanelItems（按私聊可见性取命令）', () => {
  const commands = [
    cmd('new', '开始新会话（清空上下文，可指定工作区）'),
    cmd(['sessions', 'session'], '列出、恢复、归档会话'),
    cmd('ls', '列出子目录（点条目进下一层）', 'c2c'),
  ];

  it('命令名带 / 前缀，别名取第一个，括号用法去掉', () => {
    const items = buildPanelItems(commands, ['new', 'sessions', 'ls']);
    expect(items[0]).toEqual({ type: 'command', name: '/new', desc: '开始新会话' });
    expect(items[1]).toEqual({ type: 'command', name: '/sessions', desc: '列出、恢复、归档会话' });
  });

  it('all 与 c2c 指令都进入面板', () => {
    expect(buildPanelItems(commands, ['new', 'sessions', 'ls']).map((i) => i.name)).toEqual(['/new', '/sessions', '/ls']);
  });

  it('最多 20 项，超出截断', () => {
    const many = Array.from({ length: 25 }, (_, i) => cmd(`cmd-${i}`, '说明'));
    const names = Array.from({ length: 25 }, (_, i) => `cmd-${i}`);
    expect(buildPanelItems(many, names)).toHaveLength(PANEL_MAX_ITEMS);
  });

  it('name 超宽截断到上限内', () => {
    const items = buildPanelItems([cmd('very-long-command-name')], ['very-long-command-name']);
    expect(displayWidth(items[0]!.name)).toBeLessThanOrEqual(PANEL_NAME_MAX);
  });
});

describe('buildPanelItems（面板展示配置）', () => {
  const commands = [cmd('new', '新建会话'), cmd('plugins', '插件'), cmd('help', '帮助')];

  it('只展示 commands 中的主名，保持注册顺序', () => {
    expect(buildPanelItems(commands, ['help', 'new']).map((i) => i.name)).toEqual(['/new', '/help']);
  });

  it('没有名单时一条都不展示', () => {
    expect(buildPanelItems(commands)).toEqual([]);
  });

  it('空数组表示一条都不展示', () => {
    expect(buildPanelItems(commands, [])).toEqual([]);
  });

  it('别名命令按主名匹配，写别名不生效', () => {
    const sessions = [cmd(['sessions', 'session'], '会话')];
    expect(buildPanelItems(sessions, ['sessions']).map((i) => i.name)).toEqual(['/sessions']);
    expect(buildPanelItems(sessions, ['session'])).toEqual([]);
  });

  it('勾选后仍不超过 20 项上限', () => {
    const many = Array.from({ length: 25 }, (_, i) => cmd('cmd-' + i, '说明'));
    const names = Array.from({ length: 25 }, (_, i) => 'cmd-' + i);
    expect(buildPanelItems(many, names)).toHaveLength(PANEL_MAX_ITEMS);
  });
});

describe('listPanelCommands（设置页目录）', () => {
  it('按注册顺序返回主名与说明，不带斜杠', () => {
    expect(listPanelCommands([cmd('new', '新建会话'), cmd(['sessions', 'session'], '会话')]))
      .toEqual([
        { name: 'new', description: '新建会话' },
        { name: 'sessions', description: '会话' },
      ]);
  });

  it('与面板一致排除不可用命令，并在能力翻转后现查', () => {
    let available = false;
    const gated = { ...cmd('steer', '插话排队消息'), available: () => available } as SlashCommand;
    expect(listPanelCommands([gated])).toEqual([]);
    available = true;
    expect(listPanelCommands([gated])).toEqual([{ name: 'steer', description: '插话排队消息' }]);
  });
});

describe('syncCommandPanels（有则更新，无则创建）', () => {
  const commands = [cmd('new', '开始新会话'), cmd('ls', '列出子目录', 'c2c')];

  it('没有本插件的面板时创建私聊全局面板', async () => {
    const { api, calls } = makeApi([]);
    const results = await syncCommandPanels(api, commands, { shown: ['new', 'ls'] });

    expect(results.map((r) => r.action)).toEqual(['created']);
    const posts = calls.filter((c) => c.method === 'post');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({
      scope: 'c2c',
      target_type: 'all',
      panel: { remark: PANEL_REMARK },
    });
  });

  it('已有 remark 匹配的面板时原地 PUT，不再创建', async () => {
    const { api, calls } = makeApi([{ panel_id: 'p_9', panel: { remark: PANEL_REMARK } }]);
    const results = await syncCommandPanels(api, commands, { shown: ['new', 'ls'] });

    expect(results.map((r) => r.action)).toEqual(['updated']);
    expect(results.map((r) => r.panelId)).toEqual(['p_9']);
    const puts = calls.filter((c) => c.method === 'put');
    expect(puts.map((c) => c.path)).toEqual(['/v2/panels/p_9']);
    expect(calls.some((c) => c.method === 'post')).toBe(false);
  });

  it('别人建的面板不动（remark 不匹配）', async () => {
    const { api, calls } = makeApi([{ panel_id: 'p_other', panel: { remark: 'manual' } }]);
    await syncCommandPanels(api, commands, { shown: ['new', 'ls'] });
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(1);
  });

  it('接口报错向上抛，由调用方转成用户文案', async () => {
    const api = {
      get: async () => ({ records: [] }),
      post: async () => {
        throw new Error('40030020 内容存在安全风险');
      },
      put: vi.fn(),
    } as unknown as OpenApiLike;

    await expect(syncCommandPanels(api, commands, { shown: ['new', 'ls'] })).rejects.toThrow('40030020');
  });

  it('按 commands 过滤同步内容', async () => {
    const { api, calls } = makeApi([]);
    await syncCommandPanels(api, commands, { shown: ['new'] });
    const post = calls.find((c) => c.method === 'post');
    expect(post).toBeDefined();
    const body = post!.body as { panel: { items: Array<{ name: string }> } };
    expect(body.panel.items.map((item) => item.name)).toEqual(['/new']);
  });

  it('没有选中命令且没有归属面板时不创建', async () => {
    const { api, calls } = makeApi([]);
    const results = await syncCommandPanels(api, commands);
    expect(results).toEqual([]);
    expect(calls.filter((c) => c.method !== 'get')).toEqual([]);
  });

  it('未配置命令时删除归属面板', async () => {
    const { api, calls } = makeApi([{ panel_id: 'p_9', panel: { remark: PANEL_REMARK } }]);
    const results = await syncCommandPanels(api, commands);
    expect(results.map((r) => r.action)).toEqual(['deleted']);
    expect(calls.filter((c) => c.method === 'delete').map((c) => c.path)).toEqual(['/v2/panels/p_9']);
  });

  it('名单为空时删除归属面板', async () => {
    const { api, calls } = makeApi([{ panel_id: 'p_9', panel: { remark: PANEL_REMARK } }]);
    const results = await syncCommandPanels(api, commands, { shown: [] });
    expect(results.map((r) => r.action)).toEqual(['deleted']);
    expect(calls.filter((c) => c.method === 'delete').map((c) => c.path)).toEqual(['/v2/panels/p_9']);
    expect(calls.some((c) => c.method === 'put' || c.method === 'post')).toBe(false);
  });

  it('总开关关闭时删除归属面板', async () => {
    const { api, calls } = makeApi([{ panel_id: 'p_9', panel: { remark: PANEL_REMARK } }]);
    const results = await syncCommandPanels(api, commands, { enabled: false });
    expect(results.map((r) => r.action)).toEqual(['deleted']);
    expect(calls.some((c) => c.method === 'delete')).toBe(true);
  });

  it('总开关关闭且没有归属面板时不创建', async () => {
    const { api, calls } = makeApi([]);
    const results = await syncCommandPanels(api, commands, { enabled: false });
    expect(results).toEqual([]);
    expect(calls.some((c) => c.method === 'post' || c.method === 'put' || c.method === 'delete')).toBe(false);
  });
});

describe('formatPanelSummary', () => {
  it('拼成私聊一项', () => {
    expect(
      formatPanelSummary([
        { scope: 'c2c', action: 'created', panelId: 'p1', count: 16 },
      ]),
    ).toBe('私聊 16 项');
  });

  it('移除写「已移除」，无变化写「未变更」', () => {
    expect(formatPanelSummary([
      { scope: 'c2c', action: 'deleted', panelId: 'p1', count: 0 },
    ])).toBe('私聊 已移除');
    expect(formatPanelSummary([])).toBe('未变更');
  });
});
