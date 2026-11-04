/**
 * 自定义菜单同步：四个固定按钮、认领已有按钮、保留手工按钮、超限截断
 */
import { describe, it, expect } from 'vitest';
import type { OpenApiLike } from '../types.ts';
import { MENU_BUTTONS, MENU_MAX_ITEMS, syncCommandMenu } from './command-menu.ts';

interface Call {
  method: 'get' | 'put';
  path: string;
  body?: unknown;
}

function makeApi(items?: Array<Record<string, unknown>>) {
  const calls: Call[] = [];
  const api = {
    get: async (path: string) => {
      calls.push({ method: 'get', path });
      return items === undefined ? { version: 1 } : { version: 1, menu: { items } };
    },
    post: async () => ({}),
    put: async (path: string, body?: unknown) => {
      calls.push({ method: 'put', path, body });
      return { version: 2 };
    },
  } as unknown as OpenApiLike;
  return { api, calls };
}

const OUR_ITEMS = MENU_BUTTONS.map((button) => ({
  type: 'send_message',
  name: button.name,
  send_message: button.command,
}));

describe('syncCommandMenu', () => {
  it('空菜单时写入四个固定按钮', async () => {
    const { api, calls } = makeApi();
    const result = await syncCommandMenu(api);

    expect(result).toEqual({ action: 'updated', count: 4 });
    const put = calls.find((c) => c.method === 'put');
    expect(put?.path).toBe('/v2/menu');
    expect(put?.body).toEqual({ menu: { items: OUR_ITEMS } });
    expect(OUR_ITEMS.map((i) => i.name)).toEqual(['会话状态', '会话列表', '创建会话', '压缩会话']);
  });

  it('菜单已是目标状态时不再 PUT', async () => {
    const { api, calls } = makeApi(OUR_ITEMS);
    const result = await syncCommandMenu(api);

    expect(result).toEqual({ action: 'unchanged', count: 4 });
    expect(calls.some((c) => c.method === 'put')).toBe(false);
  });

  it('服务端补了 icon 之类字段时仍判定为一致', async () => {
    const withIcon = OUR_ITEMS.map((item) => ({ ...item, icon: 'https://example.com/a.png' }));
    const { api, calls } = makeApi(withIcon);
    const result = await syncCommandMenu(api);

    expect(result).toEqual({ action: 'unchanged', count: 4 });
    expect(calls.some((c) => c.method === 'put')).toBe(false);
  });

  it('保留用户手工加的按钮，接在四个固定按钮之后', async () => {
    const manual = { type: 'link', name: '官网', link: 'https://example.com' };
    const { api, calls } = makeApi([manual]);
    await syncCommandMenu(api);

    const put = calls.find((c) => c.method === 'put');
    const items = (put?.body as { menu: { items: unknown[] } }).menu.items;
    expect(items).toEqual([...OUR_ITEMS, manual]);
  });

  it('本插件的按钮被改名也按 send_message 认领，不重复追加', async () => {
    const renamed = { type: 'send_message', name: '看状态', send_message: '/status' };
    const { api, calls } = makeApi([renamed]);
    const result = await syncCommandMenu(api);

    expect(result.count).toBe(4);
    const items = (calls.find((c) => c.method === 'put')?.body as { menu: { items: unknown[] } }).menu.items;
    expect(items).toEqual(OUR_ITEMS);
  });

  it('总数超过 10 项时截断', async () => {
    const manual = Array.from({ length: 12 }, (_, i) => ({
      type: 'send_message',
      name: `m${i}`,
      send_message: `/m${i}`,
    }));
    const { api, calls } = makeApi(manual);
    const result = await syncCommandMenu(api);

    expect(result.count).toBe(MENU_MAX_ITEMS);
    const items = (calls.find((c) => c.method === 'put')?.body as { menu: { items: unknown[] } }).menu.items;
    expect(items).toHaveLength(MENU_MAX_ITEMS);
  });
});
