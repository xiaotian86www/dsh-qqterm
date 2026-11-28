/**
 * 自定义菜单同步 — 单聊窗口底部的固定入口（`/v2/menu`）
 *
 * 菜单是机器人级全局配置，仅 C2C 生效：所有用户看到同一份，改完要退出对话框
 * 再进来才看得到新内容，所以不做按会话变化的动态文案——只写静态动作。
 *
 * 结构：四个平铺按钮（会话状态 / 会话列表 / 重置会话 / 压缩会话）+ 两个
 * 含子菜单的折叠项（权限预设 / 思考强度）。折叠项的子菜单只能是 send_message 或 link，
 * 不支持再嵌套。
 *
 * 平台限制：顶层最多 10 项，按钮名最多 10 字符（一个汉字算 2）；子菜单最多
 * 5 项，子项名最多 14 字符。
 * 同步策略：菜单接口是整体覆盖，每次 PUT 本插件固定这一份（用户手工加的
 * 其它按钮会被覆盖）；内容一致时不发 PUT。
 */
import type { Logger, OpenApiLike } from '../types.ts';

/** 顶层菜单最多 10 项 */
export const MENU_MAX_ITEMS = 10;

/** 一个折叠项最多 5 个子菜单 */
export const MENU_MAX_CHILDREN = 5;

/** 一个菜单按钮：点击后把命令填进聊天输入框 */
export interface MenuButton {
  /** 按钮文案（顶层 ≤10 字符、子菜单 ≤14 字符，一个汉字算 2） */
  name: string;
  /** 点击后填入输入框的命令 */
  command: string;
}

/** 一个含子菜单的折叠项（`type=menu`，只有一层） */
export interface MenuSubmenu {
  /** 折叠项文案（≤10 字符） */
  name: string;
  /** 子菜单项（1–5 个） */
  children: readonly MenuButton[];
}

export type MenuEntry = MenuButton | MenuSubmenu;

function isSubmenu(entry: MenuEntry): entry is MenuSubmenu {
  return 'children' in entry;
}

/** 本插件固定的六个入口：四个平铺按钮 + 权限预设 / 思考强度两个折叠项 */
export const MENU_ENTRIES: readonly MenuEntry[] = [
  { name: '会话状态', command: '/status' },
  { name: '会话列表', command: '/sessions' },
  { name: '重置会话', command: '/reset' },
  { name: '压缩会话', command: '/compact' },
  {
    name: '权限预设',
    children: [
      { name: '查看权限', command: '/permission' },
      { name: '仅可查看', command: '/permission read-only' },
      { name: '工作区内修改', command: '/permission workspace-write' },
      { name: '完全权限', command: '/permission danger-full-access' },
      { name: '自动审查', command: '/permission auto' },
    ],
  },
  {
    name: '思考强度',
    children: [
      { name: '跟随模型', command: '/reasoning default' },
      { name: '关闭', command: '/reasoning off' },
      { name: '低', command: '/reasoning low' },
      { name: '高', command: '/reasoning high' },
      { name: '最高', command: '/reasoning max' },
    ],
  },
];

export interface MenuSyncResult {
  action: 'updated' | 'unchanged';
  /** 同步后菜单里的顶层项数 */
  count: number;
}

/** `PUT /v2/menu` 里的一项（折叠项带 `sub_menu_items`） */
export interface MenuItemPayload {
  type: 'send_message' | 'menu';
  name: string;
  send_message?: string;
  sub_menu_items?: MenuItemPayload[];
  /** 服务端补的字段（icon 等） */
  [key: string]: unknown;
}

type RawMenuItem = MenuItemPayload & { [key: string]: unknown };

interface MenuResponse {
  version?: number;
  menu?: { items?: RawMenuItem[] };
}

function toMenuItem(entry: MenuEntry): MenuItemPayload {
  if (isSubmenu(entry)) {
    return {
      type: 'menu',
      name: entry.name,
      sub_menu_items: entry.children.map((child) => toMenuItem(child)),
    };
  }
  return { type: 'send_message', name: entry.name, send_message: entry.command };
}

/** 本插件要写入的菜单项（测试直接比对这份结构） */
export function menuItems(): MenuItemPayload[] {
  return MENU_ENTRIES.map(toMenuItem);
}

/** 比较一个菜单项：本插件写的字段一致即视为等价（服务端会补 icon 等） */
function sameItem(current: RawMenuItem, item: RawMenuItem): boolean {
  if (current.type !== item.type || current.name !== item.name) return false;
  if (item.type !== 'menu') return current.send_message === item.send_message;

  const currentChildren = current.sub_menu_items ?? [];
  const children = item.sub_menu_items ?? [];
  if (currentChildren.length !== children.length) return false;
  return children.every((child, index) => {
    const existing = currentChildren[index];
    return existing !== undefined && sameItem(existing, child);
  });
}

/** 按字段判断两个菜单是否等价 */
function sameMenu(existing: RawMenuItem[], ours: RawMenuItem[]): boolean {
  if (existing.length !== ours.length) return false;
  return ours.every((item, index) => sameItem(existing[index]!, item));
}

/**
 * 把固定入口同步进全局菜单
 *
 * 整表覆盖：菜单是插件加载时就能确定的静态内容，不需要命令触发，也不保留
 * 其它按钮。完全一致时不发 PUT（省配额，也避免无意义覆盖）。
 */
export async function syncCommandMenu(
  api: OpenApiLike,
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<MenuSyncResult> {
  const current = await api.get<MenuResponse>('/v2/menu');
  const existing = current.menu?.items ?? [];

  const ours = menuItems();

  if (sameMenu(existing, ours)) {
    logger?.debug?.(`[qqterm] 自定义菜单已是最新: ${ours.length} 项`);
    return { action: 'unchanged', count: ours.length };
  }

  await api.put('/v2/menu', { menu: { items: ours } });
  logger?.debug?.(`[qqterm] 自定义菜单已更新: ${ours.length} 项`);
  return { action: 'updated', count: ours.length };
}
