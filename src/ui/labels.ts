import type { CcProvider } from "../types.ts";
import { isSwitchable } from "../parse/index.ts";

export function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url || "—";
  }
}

/** ANSI styles for TUI highlights. */
export const ANSI_YELLOW = "\x1b[33m";
export const ANSI_RESET = "\x1b[0m";

export function yellowHighlight(text: string): string {
  return `${ANSI_YELLOW}${text}${ANSI_RESET}`;
}

/**
 * AppType → single-cell ASCII tag for tab / list prefixes. ASCII is used
 * deliberately: Unicode glyphs (✦/⊕/◈/…) render at varying widths across
 * terminal fonts, which breaks three-level-pick column alignment since
 * `fit()` trusts `visibleWidth`. A single ASCII letter is exactly 1 cell
 * in every font, so alignment stays correct.
 */
export function getAppTypeIcon(appType: string): string {
  const t = appType.toLowerCase();
  if (t.includes("claude")) return "C";
  if (t.includes("codex") || t.includes("openai")) return "O";
  if (t.includes("gemini") || t.includes("google")) return "G";
  if (t.includes("grok")) return "K";
  if (t.includes("hermes")) return "H";
  if (t.includes("opencode")) return "E";
  return "·";
}

/**
 * Sort providers for the name column.
 * Order: lastUsed (if any) → pinned → switchable → displayName.
 */
export function sortProviders(
  providers: CcProvider[],
  lastUsedDbId?: string,
  pinnedDbIds?: Iterable<string>,
): CcProvider[] {
  const pinSet = new Set(pinnedDbIds ?? []);
  const sorted = [...providers].sort((a, b) => {
    const aPin = pinSet.has(a.id) ? 0 : 1;
    const bPin = pinSet.has(b.id) ? 0 : 1;
    if (aPin !== bPin) return aPin - bPin;
    const aOk = isSwitchable(a) ? 0 : 1;
    const bOk = isSwitchable(b) ? 0 : 1;
    if (aOk !== bOk) return aOk - bOk;
    return a.displayName.localeCompare(b.displayName, "zh");
  });
  if (!lastUsedDbId) return sorted;
  const idx = sorted.findIndex((p) => p.id === lastUsedDbId);
  if (idx <= 0) return sorted;
  const [item] = sorted.splice(idx, 1);
  sorted.unshift(item);
  return sorted;
}

export function filterProviders(
  providers: CcProvider[],
  query: string,
): CcProvider[] {
  const q = query.trim().toLowerCase();
  if (!q) return providers;
  return providers.filter((p) => {
    const host = extractHostname(p.baseUrl).toLowerCase();
    const notes = (p.notes ?? "").toLowerCase();
    const api = (p.api ?? "").toLowerCase();
    return (
      p.displayName.toLowerCase().includes(q) ||
      host.includes(q) ||
      notes.includes(q) ||
      p.appType.toLowerCase().includes(q) ||
      api.includes(q) ||
      p.id.toLowerCase().includes(q)
    );
  });
}
