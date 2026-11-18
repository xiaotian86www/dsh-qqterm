/** 顶层菜单最多 10 项 */
export const MENU_MAX_ITEMS = 10;
/** 一个折叠项最多 5 个子菜单 */
export const MENU_MAX_CHILDREN = 5;
function isSubmenu(entry) {
    return 'children' in entry;
}
/** 本插件固定的七个入口：五个平铺按钮 + 权限预设 / 思考强度两个折叠项 */
export const MENU_ENTRIES = [
    { name: '会话状态', command: '/status' },
    { name: '会话列表', command: '/sessions' },
    { name: '重置会话', command: '/reset' },
    { name: '压缩会话', command: '/compact' },
    { name: '长期目标', command: '/goal' },
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
            { name: '查看强度', command: '/reasoning' },
            { name: '关闭', command: '/reasoning off' },
            { name: '低', command: '/reasoning low' },
            { name: '高', command: '/reasoning high' },
            { name: '最高', command: '/reasoning max' },
        ],
    },
];
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
function sameMenu(existing, ours) {
    if (existing.length !== ours.length)
        return false;
    return ours.every((item, index) => sameItem(existing[index], item));
}
/**
 * 把固定入口同步进全局菜单
 *
 * 整表覆盖：菜单是插件加载时就能确定的静态内容，不需要命令触发，也不保留
 * 其它按钮。完全一致时不发 PUT（省配额，也避免无意义覆盖）。
 */
export async function syncCommandMenu(api, logger) {
    const current = await api.get('/v2/menu');
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
//# sourceMappingURL=command-menu.js.map