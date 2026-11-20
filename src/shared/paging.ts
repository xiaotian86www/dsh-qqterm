/**
 * 列表分页：/sessions 与 /plugins 共用切片、越界提示与页脚
 *
 * 三处细节必须一致，否则同一套页码在不同列表里表现不同：
 * 空列表也算 1 页、页码越界先给提示再渲染、多页时页脚两侧缺哪边省略哪边。
 */
import { commandLink } from './inline.ts';

/** 每页条数（§4.3：分页一页 10 条） */
export const PAGE_SIZE = 10;

/** 总页数：空列表算 1 页，页码永远不会是 0 */
export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

/** 取一页：页码越界时夹回 1..pages（要先提示越界的调用方自己判 page） */
export function pageSlice<T>(items: readonly T[], page: number): { page: number; pages: number; shown: T[] } {
  const pages = pageCount(items.length);
  const current = Math.min(Math.max(page, 1), pages);
  const start = (current - 1) * PAGE_SIZE;
  return { page: current, pages, shown: items.slice(start, start + PAGE_SIZE) };
}

/**
 * 页码越界提示。
 *
 * `command` 接收页码返回整条命令（`/sessions 1`），提示里的「回到第 1 页」
 * 也走它，保证指向的是同一条命令。
 */
export function pageOutOfRange(page: number, pages: number, command: (page: number) => string): string {
  return `⚠️ 第 ${page} 页没有内容（共 ${pages} 页） · ${commandLink(command(1), '回到第 1 页')}`;
}

/** 分页导航：多页时给出 上一页 · 第 x/y 页 · 下一页，缺哪边省略哪边 */
export function pageLinks(page: number, pages: number, command: (page: number) => string): string[] {
  if (pages <= 1) return [];
  const links: string[] = [];
  if (page > 1) links.push(commandLink(command(page - 1), '上一页'));
  links.push(`第 ${page}/${pages} 页`);
  if (page < pages) links.push(commandLink(command(page + 1), '下一页'));
  return links;
}
