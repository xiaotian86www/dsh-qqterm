/**
 * 指令面板同步 — 把插件当前注册的斜杠命令写进 QQ 指令面板
 *
 * 面板是机器人级配置（`/v2/panels`），没有按会话写入的语义：
 *   - 只为私聊维护一个 target_type=all 的面板
 *   - 用 panel.remark 标记归属，重复同步原地更新，不会重复创建
 *
 * 平台限制：每机器人最多 20 个面板、每面板最多 20 项；
 * name 最多 14 字符（约 7 个汉字）、desc 最多 30 字符（约 15 个汉字）。
 */
import type { SlashCommand } from '../commands/types.ts';
import { visibleCommands } from '../commands/availability.ts';
import type { Logger, OpenApiLike } from '../types.ts';
import { PANEL_MAX_ITEMS, type PanelCommandWire } from '../shared/bind-protocol.ts';

/** 面板归属标记：列表里靠它认出「这个面板是本插件建的」 */
export const PANEL_REMARK = 'qqterm:commands';

/** 单个面板最多的元素数（定义在共享协议里，设置页也用它限制勾选） */
export { PANEL_MAX_ITEMS };

/** 元素名宽度上限（汉字按 2 计） */
export const PANEL_NAME_MAX = 14;

/** 元素描述宽度上限（汉字按 2 计） */
export const PANEL_DESC_MAX = 30;

/** 需要同步的场景：只保留私聊（频道/频道私信不在本插件范围） */
export const PANEL_SCOPES = ['c2c'] as const;

export type PanelScope = (typeof PANEL_SCOPES)[number];

/**
 * 设置页的命令分组：组的先后与组内命令的先后都由这张表决定。
 *
 * 分组只是展示结构，不改变命令注册表；新命令忘了归组会落到「其他」，
 * 排在所有分组之后，不会从面板消失。
 */
export const PANEL_GROUPS: ReadonlyArray<{ label: string; names: readonly string[] }> = [
  { label: '会话', names: ['new', 'clear', 'compact', 'goal', 'sessions', 'rename', 'to', 'status'] },
  { label: '生成控制', names: ['stop', 'steer', 'unqueue', 'retry'] },
  { label: '模型与权限', names: ['model', 'reasoning', 'cost', 'preset', 'permission'] },
  { label: '文件与执行', names: ['ls', 'get', 'run'] },
  { label: '插件与帮助', names: ['plugins', 'help'] },
];

/** 未归类命令的组名（排在所有分组之后） */
export const PANEL_GROUP_FALLBACK = '其他';

/** 命令所属分组：查表，未收录返回「其他」 */
export function panelGroupOf(name: string): string {
  for (const group of PANEL_GROUPS) {
    if (group.names.includes(name)) return group.label;
  }
  return PANEL_GROUP_FALLBACK;
}

/** 宽字符区间：CJK、假名、全角符号、emoji */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
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

/** 面板元素（`type=command`：点击后把 name 填进聊天输入框） */
export interface PanelItem {
  type: 'command';
  name: string;
  desc?: string;
}

/** 同步结果（每条对应一个场景） */
export interface PanelSyncResult {
  scope: PanelScope;
  action: 'created' | 'updated' | 'deleted';
  panelId: string;
  count: number;
}

interface PanelRecord {
  panel_id: string;
  panel?: { remark?: string };
}

interface PanelListResponse {
  records?: PanelRecord[];
}

/** 单个字符的显示宽度：CJK / emoji 算 2，其余算 1 */
function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  for (const [start, end] of WIDE_RANGES) {
    if (cp >= start && cp <= end) return 2;
  }
  return 1;
}

/** 文本显示宽度（与平台「14 字符≈7 汉字」的口径一致） */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}

/**
 * 按显示宽度截断，超长补 `…`（省略号按 2 宽预留，避免截完仍超限）
 */
export function clipPanelText(text: string, maxWidth: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (displayWidth(flat) <= maxWidth) return flat;

  let out = '';
  let width = 0;
  for (const ch of flat) {
    const w = charWidth(ch);
    if (width + w + 2 > maxWidth) break;
    out += ch;
    width += w;
  }
  return `${out.trimEnd()}…`;
}

/** 面板说明只留一行短句：命令自带的用法括号在输入框里没有意义，先去掉 */
function shortPanelDesc(text: string): string {
  const short = text
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .trim();
  return clipPanelText(short || text, PANEL_DESC_MAX);
}

/**
 * 面板命令目录：按分组顺序列出私聊可见命令（不带斜杠）。
 *
 * 组内保持注册顺序；设置页按 group 聚合成卡片，QQ 指令面板也按这个顺序展示。
 * 命令可用性在请求时现查。
 */
export function listPanelCommands(commands: readonly SlashCommand[]): PanelCommandWire[] {
  const infos: PanelCommandWire[] = [];
  // 同步发生在连接后：能力可能晚于命令表挂载，这里现取可见命令。
  for (const cmd of visibleCommands(commands)) {
    // SDK 的 scope 还可能有其它场景值，非私聊可见的一律不同步
    if (cmd.scope !== undefined && cmd.scope !== 'c2c' && cmd.scope !== 'all') continue;

    const name = Array.isArray(cmd.name) ? cmd.name[0] : cmd.name;
    if (!name) continue;
    infos.push({
      name,
      ...(cmd.description ? { description: cmd.description } : {}),
      group: panelGroupOf(name),
    });
  }

  // 按分组顺序重排：设置页与 QQ 面板共用这一份顺序
  return [...PANEL_GROUPS.map((group) => group.label), PANEL_GROUP_FALLBACK]
    .flatMap((label) => infos.filter((info) => info.group === label));
}

/** 按私聊可见性筛选命令，只保留 shown 中的主名后拼成面板元素；空名单就是空面板 */
export function buildPanelItems(
  commands: readonly SlashCommand[],
  shown: readonly string[] = [],
): PanelItem[] {
  const shownNames = new Set(shown);
  const items: PanelItem[] = [];
  for (const info of listPanelCommands(commands)) {
    if (!shownNames.has(info.name)) continue;
    items.push({
      type: 'command',
      name: clipPanelText(`/${info.name}`, PANEL_NAME_MAX),
      ...(info.description ? { desc: shortPanelDesc(info.description) } : {}),
    });
    if (items.length >= PANEL_MAX_ITEMS) break;
  }
  return items;
}

/** 找本插件建的面板（按 remark 认领；面板总数上限 20，一页 50 足够） */
async function findManagedPanel(api: OpenApiLike, scope: PanelScope): Promise<string | undefined> {
  const list = await api.get<PanelListResponse>('/v2/panels', { scope, limit: 50 });
  return list.records?.find((record) => record.panel?.remark === PANEL_REMARK)?.panel_id;
}

/** 面板同步选项 */
export interface PanelSyncOptions {
  /** 总开关：false 时移除本插件创建的面板 */
  enabled?: boolean;
  /** 展示的命令主名；[] = 不展示 */
  shown?: readonly string[];
  logger?: Pick<Logger, 'debug' | 'warn'>;
}

/**
 * 把命令同步到私聊全局面板
 *
 * 已有面板就覆盖元素（PUT，不影响关联对象），没有才创建（POST）；
 * 总开关关闭或名单为空时删除本插件建的面板。出错直接抛给调用方：
 * 启动时记 warn，`/bot-panel` 回给用户。
 */
export async function syncCommandPanels(
  api: OpenApiLike,
  commands: readonly SlashCommand[],
  options: PanelSyncOptions = {},
): Promise<PanelSyncResult[]> {
  const { enabled = true, shown = [], logger } = options;
  const results: PanelSyncResult[] = [];

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

    const created = await api.post<{ panel_id?: string }>('/v2/panels', {
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
export function formatPanelSummary(results: readonly PanelSyncResult[]): string {
  const label: Record<PanelScope, string> = { c2c: '私聊' };
  if (results.length === 0) return '未变更';
  return results
    .map((r) => r.action === 'deleted' ? `${label[r.scope]} 已移除` : `${label[r.scope]} ${r.count} 项`)
    .join(' · ');
}
