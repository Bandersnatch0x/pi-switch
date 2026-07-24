import type { CcProvider, PiApi } from "../types.ts";
import { isSwitchable } from "../parse/index.ts";

export function apiShort(api: PiApi | null | undefined): string {
  switch (api) {
    case "anthropic-messages":
      return "anth";
    case "openai-responses":
      return "resp";
    case "openai-completions":
      return "chat";
    case "google-generative-ai":
      return "gem";
    default:
      return "?";
  }
}

export function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url || "—";
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * ★ name · host · apiShort · status ●
 */
export function formatProviderLabel(
  provider: CcProvider,
  opts: { piActive: boolean; isLastUsed: boolean },
): string {
  const host = truncate(extractHostname(provider.baseUrl), 24);
  const short = apiShort(provider.api);
  const status = isSwitchable(provider)
    ? "可切换"
    : `不可切换: ${provider.parseError ?? "unknown"}`;
  const star = opts.isLastUsed ? "★ " : "";
  const dot = opts.piActive ? " ●" : "";
  return `${star}${provider.displayName} · ${host} · ${short} · ${status}${dot}`;
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
    return (
      p.displayName.toLowerCase().includes(q) ||
      host.includes(q) ||
      notes.includes(q) ||
      p.appType.toLowerCase().includes(q)
    );
  });
}
