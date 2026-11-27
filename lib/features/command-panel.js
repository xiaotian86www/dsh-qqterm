import { visibleCommands } from "../commands/availability.js";
import { PANEL_MAX_ITEMS } from "../shared/bind-protocol.js";
/** 面板归属标记：列表里靠它认出「这个面板是本插件建的」 */
export const PANEL_REMARK = 'qqterm:commands';
/** 单个面板最多的元素数（定义在共享协议里，设置页也用它限制勾选） */
export { PANEL_MAX_ITEMS };
/** 元素名宽度上限（汉字按 2 计） */
export const PANEL_NAME_MAX = 14;
/** 元素描述宽度上限（汉字按 2 计） */
export const PANEL_DESC_MAX = 30;
/** 需要同步的场景：只保留私聊（频道/频道私信不在本插件范围） */
export const PANEL_SCOPES = ['c2c'];
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
/**
 * 面板命令目录：按注册顺序列出私聊可见命令（不带斜杠）。
 *
 * 设置页用它给每条命令一个开关；命令可用性在请求时现查。
 */
export function listPanelCommands(commands) {
    const infos = [];
    // 同步发生在连接后：能力可能晚于命令表挂载，这里现取可见命令。
    for (const cmd of visibleCommands(commands)) {
        // SDK 的 scope 还可能有其它场景值，非私聊可见的一律不同步
        if (cmd.scope !== undefined && cmd.scope !== 'c2c' && cmd.scope !== 'all')
            continue;
        const name = Array.isArray(cmd.name) ? cmd.name[0] : cmd.name;
        if (!name)
            continue;
        infos.push({ name, ...(cmd.description ? { description: cmd.description } : {}) });
    }
    return infos;
}
/** 按私聊可见性筛选命令，只保留 shown 中的主名后拼成面板元素；空名单就是空面板 */
export function buildPanelItems(commands, shown = []) {
    const shownNames = new Set(shown);
    const items = [];
    for (const info of listPanelCommands(commands)) {
        if (!shownNames.has(info.name))
            continue;
        items.push({
            type: 'command',
            name: clipPanelText(`/${info.name}`, PANEL_NAME_MAX),
            ...(info.description ? { desc: shortPanelDesc(info.description) } : {}),
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
 * 把命令同步到私聊全局面板
 *
 * 已有面板就覆盖元素（PUT，不影响关联对象），没有才创建（POST）；
 * 总开关关闭或名单为空时删除本插件建的面板。出错直接抛给调用方：
 * 启动时记 warn，`/bot-panel` 回给用户。
 */
export async function syncCommandPanels(api, commands, options = {}) {
    const { enabled = true, shown = [], logger } = options;
    const results = [];
    for (const scope of PANEL_SCOPES) {
        const items = enabled ? buildPanelItems(commands, shown) : [];
        const existing = await findManagedPanel(api, scope);
        if (items.length === 0) {
            // 总开关关闭或一条都没选：面板不该继续展示旧内容，连同归属面板一起删掉。
            if (existing !== undefined) {
                await api.delete(`/v2/panels/${existing}`);
                results.push({ scope, action: 'deleted', panelId: existing, count: 0 });
                logger?.debug?.(`[qqterm] 指令面板已移除: ${scope} ${existing}`);
            }
            continue;
        }
        const panel = { items, remark: PANEL_REMARK };
        if (existing !== undefined) {
            await api.put(`/v2/panels/${existing}`, { panel });
            results.push({ scope, action: 'updated', panelId: existing, count: items.length });
            logger?.debug?.(`[qqterm] 指令面板已更新: ${scope} ${existing} (${items.length} 项)`);
            continue;
        }
        const created = await api.post('/v2/panels', {
            scope,
            target_type: 'all',
            panel,
        });
        const panelId = created?.panel_id ?? '';
        results.push({ scope, action: 'created', panelId, count: items.length });
        logger?.debug?.(`[qqterm] 指令面板已创建: ${scope} ${panelId} (${items.length} 项)`);
    }
    return results;
}
/** 同步结果的一句话摘要：私聊 16 项 / 私聊 已移除 */
export function formatPanelSummary(results) {
    const label = { c2c: '私聊' };
    if (results.length === 0)
        return '未变更';
    return results
        .map((r) => r.action === 'deleted' ? `${label[r.scope]} 已移除` : `${label[r.scope]} ${r.count} 项`)
        .join(' · ');
}
//# sourceMappingURL=command-panel.js.map