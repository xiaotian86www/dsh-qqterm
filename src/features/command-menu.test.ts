/**
 * 自定义菜单同步：四个平铺按钮 + 权限 / 思考两个折叠项、认领已有按钮、
 * 保留手工按钮、超限截断
 */
import { describe, it, expect } from 'vitest';
import type { OpenApiLike } from '../types.ts';
import {
  MENU_ENTRIES,
  MENU_MAX_CHILDREN,
  MENU_MAX_ITEMS,
  menuItems,
  syncCommandMenu,
  type MenuItemPayload,
} from './command-menu.ts';

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

const OUR_ITEMS = menuItems();

function putItems(calls: Call[]): MenuItemPayload[] {
  const put = calls.find((c) => c.method === 'put');
  return (put?.body as { menu: { items: MenuItemPayload[] } }).menu.items;
}

describe('MENU_ENTRIES', () => {
  it('四个平铺按钮 + 权限 / 思考两个折叠项', () => {
    expect(OUR_ITEMS.map((item) => item.name)).toEqual([
      '会话状态', '会话列表', '创建会话', '压缩会话', '权限', '思考',
    ]);
    expect(OUR_ITEMS.filter((item) => item.type === 'menu').map((item) => item.name)).toEqual(['权限', '思考']);
  });

  it('权限子菜单列出查看与四个预设', () => {
    const permission = OUR_ITEMS.find((item) => item.name === '权限');
    expect(permission?.sub_menu_items?.map((child) => child.send_message)).toEqual([
      '/permission',
      '/permission read-only',
      '/permission workspace-write',
      '/permission danger-full-access',
      '/permission auto',
    ]);
  });

  it('思考子菜单列出查看与四个档位', () => {
    const reasoning = OUR_ITEMS.find((item) => item.name === '思考');
    expect(reasoning?.sub_menu_items?.map((child) => child.send_message)).toEqual([
      '/reasoning',
      '/reasoning off',
      '/reasoning low',
      '/reasoning high',
      '/reasoning max',
    ]);
  });

  it('符合平台限制：顶层 ≤10 项、折叠项 1–5 个子菜单、名字长度', () => {
    expect(MENU_ENTRIES.length).toBeLessThanOrEqual(MENU_MAX_ITEMS);
    for (const item of OUR_ITEMS) {
      // 一个汉字算 2 个字符
      expect(item.name.length * 2).toBeLessThanOrEqual(10);
      if (item.type === 'menu') {
        const children = item.sub_menu_items ?? [];
        expect(children.length).toBeGreaterThan(0);
        expect(children.length).toBeLessThanOrEqual(MENU_MAX_CHILDREN);
        for (const child of children) {
          expect(child.type).toBe('send_message');
          expect(child.name.length * 2).toBeLessThanOrEqual(14);
        }
      }
    }
  });
});

describe('syncCommandMenu', () => {
  it('空菜单时写入固定入口', async () => {
    const { api, calls } = makeApi();
    const result = await syncCommandMenu(api);

    expect(result).toEqual({ action: 'updated', count: 6 });
    const put = calls.find((c) => c.method === 'put');
    expect(put?.path).toBe('/v2/menu');
    expect(put?.body).toEqual({ menu: { items: OUR_ITEMS } });
  });

  it('菜单已是目标状态时不再 PUT', async () => {
    const { api, calls } = makeApi(OUR_ITEMS);
    const result = await syncCommandMenu(api);

    expect(result).toEqual({ action: 'unchanged', count: 6 });
    expect(calls.some((c) => c.method === 'put')).toBe(false);
  });

  it('服务端补了 icon 之类字段时仍判定为一致', async () => {
    const withIcon = OUR_ITEMS.map((item) => ({
      ...item,
      icon: 'https://example.com/a.png',
      ...(item.sub_menu_items
        ? { sub_menu_items: item.sub_menu_items.map((child) => ({ ...child, icon: 'https://example.com/b.png' })) }
        : {}),
    }));
    const { api, calls } = makeApi(withIcon);
    const result = await syncCommandMenu(api);

    expect(result).toEqual({ action: 'unchanged', count: 6 });
    expect(calls.some((c) => c.method === 'put')).toBe(false);
  });

  it('保留用户手工加的按钮，接在固定入口之后', async () => {
    const manual = { type: 'link', name: '官网', link: 'https://example.com' };
    const { api, calls } = makeApi([manual]);
    await syncCommandMenu(api);

    expect(putItems(calls)).toEqual([...OUR_ITEMS, manual]);
  });

  it('本插件的按钮被改名也按 send_message 认领，不重复追加', async () => {
    const renamed = { type: 'send_message', name: '看状态', send_message: '/status' };
    const { api, calls } = makeApi([renamed]);
    const result = await syncCommandMenu(api);

    expect(result.count).toBe(6);
    expect(putItems(calls)).toEqual(OUR_ITEMS);
  });

  it('折叠项被改名也按子菜单命令认领，不重复追加', async () => {
    const renamed = {
      type: 'menu',
      name: '我的权限',
      sub_menu_items: OUR_ITEMS.find((item) => item.name === '权限')!.sub_menu_items,
    };
    const { api, calls } = makeApi([renamed]);
    await syncCommandMenu(api);

    expect(putItems(calls)).toEqual(OUR_ITEMS);
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
    expect(putItems(calls)).toHaveLength(MENU_MAX_ITEMS);
  });
});
