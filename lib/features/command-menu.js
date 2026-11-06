/** 顶层菜单最多 10 项 */
export const MENU_MAX_ITEMS = 10;
/** 一个折叠项最多 5 个子菜单 */
export const MENU_MAX_CHILDREN = 5;
function isSubmenu(entry) {
    return 'children' in entry;
}
/** 本插件固定的六个入口：四个平铺按钮 + 权限 / 思考两个折叠项 */
export const MENU_ENTRIES = [
    { name: '会话状态', command: '/status' },
    { name: '会话列表', command: '/sessions' },
    { name: '创建会话', command: '/new' },
    { name: '压缩会话', command: '/compact' },
    {
        name: '权限',
        children: [
            { name: '查看权限', command: '/permission' },
            { name: '仅可查看', command: '/permission read-only' },
            { name: '工作区内修改', command: '/permission workspace-write' },
            { name: '完全权限', command: '/permission danger-full-access' },
            { name: '自动审查', command: '/permission auto' },
        ],
    },
    {
        name: '思考',
        children: [
            { name: '查看思考', command: '/reasoning' },
            { name: '关闭', command: '/reasoning off' },
            { name: '低', command: '/reasoning low' },
            { name: '高', command: '/reasoning high' },
            { name: '最高', command: '/reasoning max' },
        ],
    },
];
/** 本插件写过的全部命令（顶层按钮 + 子菜单） */
const OUR_COMMANDS = new Set(MENU_ENTRIES.flatMap((entry) => (isSubmenu(entry) ? entry.children.map((child) => child.command) : [entry.command])));
/** 本插件的折叠项名字 */
const OUR_SUBMENU_NAMES = new Set(MENU_ENTRIES.filter(isSubmenu).map((entry) => entry.name));
function toMenuItem(entry) {
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
export function menuItems() {
    return MENU_ENTRIES.map(toMenuItem);
}
/**
 * 按 send_message 认领：用户把按钮改名的，还是认作本插件的。
 * 折叠项按名字认领；名字也被改过时，看子菜单命令是否全是我们的。
 */
function isOurs(item) {
    if (item.type === 'send_message') {
        return typeof item.send_message === 'string' && OUR_COMMANDS.has(item.send_message);
    }
    if (item.type === 'menu') {
        if (typeof item.name === 'string' && OUR_SUBMENU_NAMES.has(item.name))
            return true;
        const children = item.sub_menu_items ?? [];
        return children.length > 0
            && children.every((child) => typeof child.send_message === 'string' && OUR_COMMANDS.has(child.send_message));
    }
    return false;
}
/** 比较一个菜单项：本插件写的字段一致即视为等价（服务端会补 icon 等） */
function sameItem(current, item) {
    if (current.type !== item.type || current.name !== item.name)
        return false;
    if (item.type !== 'menu')
        return current.send_message === item.send_message;
    const currentChildren = current.sub_menu_items ?? [];
    const children = item.sub_menu_items ?? [];
    if (currentChildren.length !== children.length)
        return false;
    return children.every((child, index) => {
        const existing = currentChildren[index];
        return existing !== undefined && sameItem(existing, child);
    });
}
/** 按字段判断两个菜单是否等价 */
function sameMenu(existing, merged) {
    if (existing.length !== merged.length)
        return false;
    return merged.every((item, index) => sameItem(existing[index], item));
}
/**
 * 把固定入口同步进全局菜单
 *
 * 已有菜单里的其它按钮（link / switch / 自定义指令）保持原样追加在后面；
 * 完全一致时不发 PUT（省配额，也避免无意义覆盖）。
 */
export async function syncCommandMenu(api, logger) {
    const current = await api.get('/v2/menu');
    const existing = current.menu?.items ?? [];
    const ours = menuItems();
    const foreign = existing.filter((item) => !isOurs(item));
    const merged = [...ours, ...foreign].slice(0, MENU_MAX_ITEMS);
    if (sameMenu(existing, merged)) {
        logger?.debug?.(`[im-qqbot] 自定义菜单已是最新: ${merged.length} 项`);
        return { action: 'unchanged', count: merged.length };
    }
    if (ours.length + foreign.length > MENU_MAX_ITEMS) {
        logger?.warn(`[im-qqbot] 自定义菜单超出 ${MENU_MAX_ITEMS} 项，只保留前 ${MENU_MAX_ITEMS} 项`);
    }
    await api.put('/v2/menu', { menu: { items: merged } });
    logger?.debug?.(`[im-qqbot] 自定义菜单已更新: ${merged.length} 项`);
    return { action: 'updated', count: merged.length };
}
//# sourceMappingURL=command-menu.js.map