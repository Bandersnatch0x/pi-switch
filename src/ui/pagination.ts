/** Shared page size for all pi-switch TUI list pickers. */
export const PAGE_SIZE = 10;

/**
 * Keep `idx` within the visible window `[scroll, scroll + vis)`. Returns the
 * scroll offset that keeps the cursor in view (or 0 when everything fits).
 */
export function ensureScroll(
  idx: number,
  scroll: number,
  vis: number,
  total: number,
): number {
  if (total <= vis) return 0;
  if (idx < scroll) return idx;
  if (idx >= scroll + vis) return idx - vis + 1;
  return scroll;
}

/**
 * Flip one page of `vis` items in direction `dir` (+1 = PgDn, -1 = PgUp),
 * cycling past the edges: PgDn off the last page wraps to the first, PgUp off
 * the first page wraps to the last. The cursor lands on the top item of the
 * target page. No-op when everything fits one page.
 */
export function pageFlip(
  idx: number,
  _scroll: number,
  total: number,
  vis: number,
  dir: number,
): { idx: number; scroll: number } {
  if (total <= vis) return { idx, scroll: 0 };
  const totalPages = Math.ceil(total / vis);
  // Arrow-key navigation keeps a sliding scroll offset, so it may not align
  // with a page boundary. Page changes must follow the focused item instead.
  const currentIdx = Math.max(0, Math.min(Math.floor(idx), total - 1));
  const current = Math.floor(currentIdx / vis);
  const step = dir === 0 ? 0 : dir > 0 ? 1 : -1;
  const target = (current + step + totalPages) % totalPages;
  const nextScroll = target * vis;
  return { idx: nextScroll, scroll: nextScroll };
}
