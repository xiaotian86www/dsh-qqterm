/** 面板归属标记：列表里靠它认出「这个面板是本插件建的」 */
export const PANEL_REMARK = 'im-qqbot:commands';
/** 单个面板最多的元素数 */
export const PANEL_MAX_ITEMS = 20;
/** 元素名宽度上限（汉字按 2 计） */
export const PANEL_NAME_MAX = 14;
/** 元素描述宽度上限（汉字按 2 计） */
export const PANEL_DESC_MAX = 30;
/** 需要同步的场景：私聊 + 群聊（频道/频道私信不在本插件范围） */
export const PANEL_SCOPES = ['c2c', 'group'];
/** 宽字符区间：CJK、假名、全角符号、emoji */
const WIDE_RANGES = [
    [0x1100, 0x115f],
    [0x2e80, 0xa4cf],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xfe10, 0xfe19],
    [0xfe30, 0xfe6f],
    [0xff00, 0xff60],
    [0xffe0, 0xffe6],
    [0x1f300, 0x1faff],
    [0x20000, 0x2fffd],
];
/** 单个字符的显示宽度：CJK / emoji 算 2，其余算 1 */
function charWidth(ch) {
    const cp = ch.codePointAt(0) ?? 0;
    for (const [start, end] of WIDE_RANGES) {
        if (cp >= start && cp <= end)
            return 2;
    }
    return 1;
}
/** 文本显示宽度（与平台「14 字符≈7 汉字」的口径一致） */
export function displayWidth(text) {
    let width = 0;
    for (const ch of text)
        width += charWidth(ch);
    return width;
}
/**
 * 按显示宽度截断，超长补 `…`（省略号按 2 宽预留，避免截完仍超限）
 */
export function clipPanelText(text, maxWidth) {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (displayWidth(flat) <= maxWidth)
        return flat;
    let out = '';
    let width = 0;
    for (const ch of flat) {
        const w = charWidth(ch);
        if (width + w + 2 > maxWidth)
            break;
        out += ch;
        width += w;
    }
    return `${out.trimEnd()}…`;
}
/** 面板说明只留一行短句：命令自带的用法括号在输入框里没有意义，先去掉 */
function shortPanelDesc(text) {
    const short = text
        .replace(/（[^）]*）/g, '')
        .replace(/\([^)]*\)/g, '')
        .trim();
    return clipPanelText(short || text, PANEL_DESC_MAX);
}
/** 按场景筛选命令，拼成面板元素（c2c / group 各一份） */
export function buildPanelItems(commands, scope) {
    const items = [];
    for (const cmd of commands) {
        if (cmd.scope === 'c2c' && scope !== 'c2c')
            continue;
        if (cmd.scope === 'group' && scope !== 'group')
            continue;
        const name = Array.isArray(cmd.name) ? cmd.name[0] : cmd.name;
        if (!name)
            continue;
        const desc = cmd.panelDesc ?? cmd.description;
        items.push({
            type: 'command',
            name: clipPanelText(`/${name}`, PANEL_NAME_MAX),
            ...(desc ? { desc: shortPanelDesc(desc) } : {}),
        });
        if (items.length >= PANEL_MAX_ITEMS)
            break;
    }
    return items;
}
/** 找本插件建的面板（按 remark 认领；面板总数上限 20，一页 50 足够） */
async function findManagedPanel(api, scope) {
    const list = await api.get('/v2/panels', { scope, limit: 50 });
    return list.records?.find((record) => record.panel?.remark === PANEL_REMARK)?.panel_id;
}
/**
 * 把命令同步到 c2c / group 两个全局面板
 *
 * 已有面板就覆盖元素（PUT，不影响关联对象），没有才创建（POST）。
 * 出错直接抛给调用方：启动时记 warn，`/bot-panel` 回给用户。
 */
export async function syncCommandPanels(api, commands, logger) {
    const results = [];
    for (const scope of PANEL_SCOPES) {
        const items = buildPanelItems(commands, scope);
        if (items.length === 0)
            continue;
        const panel = { items, remark: PANEL_REMARK };
        const existing = await findManagedPanel(api, scope);
        if (existing !== undefined) {
            await api.put(`/v2/panels/${existing}`, { panel });
            results.push({ scope, action: 'updated', panelId: existing, count: items.length });
            logger?.debug?.(`[im-qqbot] 指令面板已更新: ${scope} ${existing} (${items.length} 项)`);
            continue;
        }
        const created = await api.post('/v2/panels', {
            scope,
            target_type: 'all',
            panel,
        });
        const panelId = created?.panel_id ?? '';
        results.push({ scope, action: 'created', panelId, count: items.length });
        logger?.debug?.(`[im-qqbot] 指令面板已创建: ${scope} ${panelId} (${items.length} 项)`);
    }
    return results;
}
/** 同步结果的一句话摘要：私聊 16 项 · 群聊 16 项 */
export function formatPanelSummary(results) {
    const label = { c2c: '私聊', group: '群聊' };
    return results.map((r) => `${label[r.scope]} ${r.count} 项`).join(' · ');
}
//# sourceMappingURL=command-panel.js.map