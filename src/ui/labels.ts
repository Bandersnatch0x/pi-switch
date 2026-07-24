import type { CcProvider } from "../types.ts";
import { isSwitchable } from "../parse/index.ts";

export function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url || "—";
  }
}

/** ANSI yellow for current session model.provider (no ★/● markers). */
export const ANSI_YELLOW = "\x1b[33m";
export const ANSI_RESET = "\x1b[0m";

export function yellowHighlight(text: string): string {
  return `${ANSI_YELLOW}${text}${ANSI_RESET}`;
}

export function sortProviders(
  providers: CcProvider[],
  lastUsedDbId?: string,
): CcProvider[] {
  const sorted = [...providers].sort((a, b) => {
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
