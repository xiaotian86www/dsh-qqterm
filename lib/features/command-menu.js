/** 菜单最多 10 项 */
export const MENU_MAX_ITEMS = 10;
/** 本插件固定的三个按钮（四个汉字的动作名） */
export const MENU_BUTTONS = [
    { name: '会话状态', command: '/status' },
    { name: '创建会话', command: '/new' },
    { name: '压缩会话', command: '/compact' },
];
const OUR_COMMANDS = new Set(MENU_BUTTONS.map((button) => button.command));
function toMenuItem(button) {
    return { type: 'send_message', name: button.name, send_message: button.command };
}
/** 按 send_message 认领：用户把按钮改名的，还是认作本插件的 */
function isOurs(item) {
    return item.type === 'send_message'
        && typeof item.send_message === 'string'
        && OUR_COMMANDS.has(item.send_message);
}
/** 按字段判断两个菜单是否等价：本插件按钮只比我们写的字段（服务端会补 icon 等） */
function sameMenu(existing, merged) {
    if (existing.length !== merged.length)
        return false;
    return merged.every((item, index) => {
        const current = existing[index];
        if (isOurs(item)) {
            return current.type === item.type
                && current.name === item.name
                && current.send_message === item.send_message;
        }
        return JSON.stringify(current) === JSON.stringify(item);
    });
}
/**
 * 把三个固定按钮同步进全局菜单
 *
 * 已有菜单里的其它按钮（link / switch / 自定义指令）保持原样追加在后面；
 * 完全一致时不发 PUT（省配额，也避免无意义覆盖）。
 */
export async function syncCommandMenu(api, logger) {
    const current = await api.get('/v2/menu');
    const existing = current.menu?.items ?? [];
    const ours = MENU_BUTTONS.map(toMenuItem);
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