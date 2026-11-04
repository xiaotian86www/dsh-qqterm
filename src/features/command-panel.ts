/**
 * 指令面板同步 — 把插件当前注册的斜杠命令写进 QQ 指令面板
 *
 * 面板是机器人级配置（`/v2/panels`），没有按会话写入的语义：
 *   - c2c / group 各维护一个 target_type=all 的面板
 *   - 用 panel.remark 标记归属，重复同步原地更新，不会重复创建
 *
 * 平台限制：每机器人最多 20 个面板、每面板最多 20 项；
 * name 最多 14 字符（约 7 个汉字）、desc 最多 30 字符（约 15 个汉字）。
 */
import type { CategorizedCommand } from '../commands/types.ts';
import type { Logger, OpenApiLike } from '../types.ts';

/** 面板归属标记：列表里靠它认出「这个面板是本插件建的」 */
export const PANEL_REMARK = 'im-qqbot:commands';

/** 单个面板最多的元素数 */
export const PANEL_MAX_ITEMS = 20;

/** 元素名宽度上限（汉字按 2 计） */
export const PANEL_NAME_MAX = 14;

/** 元素描述宽度上限（汉字按 2 计） */
export const PANEL_DESC_MAX = 30;

/** 需要同步的场景：私聊 + 群聊（频道/频道私信不在本插件范围） */
export const PANEL_SCOPES = ['c2c', 'group'] as const;

export type PanelScope = (typeof PANEL_SCOPES)[number];

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
  action: 'created' | 'updated';
  panelId: string;
  count: number;
}

/** 面板同步的 api 形状（与 OpenAPI 网关一致，单测注入假实现） */
export type PanelApiLike = OpenApiLike;

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

/** 按场景筛选命令，拼成面板元素（c2c / group 各一份） */
export function buildPanelItems(
  commands: readonly CategorizedCommand[],
  scope: PanelScope,
): PanelItem[] {
  const items: PanelItem[] = [];
  for (const cmd of commands) {
    if (cmd.scope === 'c2c' && scope !== 'c2c') continue;
    if (cmd.scope === 'group' && scope !== 'group') continue;

    const name = Array.isArray(cmd.name) ? cmd.name[0] : cmd.name;
    if (!name) continue;

    const desc = cmd.panelDesc ?? cmd.description;
    items.push({
      type: 'command',
      name: clipPanelText(`/${name}`, PANEL_NAME_MAX),
      ...(desc ? { desc: shortPanelDesc(desc) } : {}),
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

/**
 * 把命令同步到 c2c / group 两个全局面板
 *
 * 已有面板就覆盖元素（PUT，不影响关联对象），没有才创建（POST）。
 * 出错直接抛给调用方：启动时记 warn，`/bot-panel` 回给用户。
 */
export async function syncCommandPanels(
  api: OpenApiLike,
  commands: readonly CategorizedCommand[],
  logger?: Pick<Logger, 'debug' | 'warn'>,
): Promise<PanelSyncResult[]> {
  const results: PanelSyncResult[] = [];

  for (const scope of PANEL_SCOPES) {
    const items = buildPanelItems(commands, scope);
    if (items.length === 0) continue;

    const panel = { items, remark: PANEL_REMARK };
    const existing = await findManagedPanel(api, scope);

    if (existing !== undefined) {
      await api.put(`/v2/panels/${existing}`, { panel });
      results.push({ scope, action: 'updated', panelId: existing, count: items.length });
      logger?.debug?.(`[im-qqbot] 指令面板已更新: ${scope} ${existing} (${items.length} 项)`);
      continue;
    }

    const created = await api.post<{ panel_id?: string }>('/v2/panels', {
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
export function formatPanelSummary(results: readonly PanelSyncResult[]): string {
  const label: Record<PanelScope, string> = { c2c: '私聊', group: '群聊' };
  return results.map((r) => `${label[r.scope]} ${r.count} 项`).join(' · ');
}
