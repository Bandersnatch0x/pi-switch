export const NAV_PREV = "↑ 上一页";
export const NAV_NEXT = "↓ 下一页";
export const NAV_JUMP = "↗ 跳页…";
export const SEARCH_LABEL = "🔍 搜索…";

export function paginate<T>(
  items: T[],
  page: number,
  pageSize: number,
): { items: T[]; totalPages: number; page: number } {
  const size = Math.max(1, pageSize);
  const totalPages = Math.ceil(items.length / size);
  if (totalPages === 0) return { items: [], totalPages: 0, page: 1 };
  const p = Math.min(Math.max(1, page), totalPages);
  const start = (p - 1) * size;
  return { items: items.slice(start, start + size), totalPages, page: p };
}

export function buildPageOptions(
  pageItems: string[],
  page: number,
  totalPages: number,
  totalItems: number,
  opts?: { includeSearch?: boolean; includeJump?: boolean },
): { options: string[]; title: string } {
  const options = [...pageItems];
  if (opts?.includeSearch) options.push(SEARCH_LABEL);
  if (totalPages > 1) {
    if (page > 1) options.push(NAV_PREV);
    if (page < totalPages) options.push(NAV_NEXT);
    if (opts?.includeJump !== false) options.push(NAV_JUMP);
  }
  const displayPage = totalPages === 0 ? 0 : page;
  const title = `第 ${displayPage}/${totalPages} 页 · 共 ${totalItems} 项`;
  return { options, title };
}
