/** /ps quick-switch list: pinned + recent pairs collapsed to one screen. */
import { isSwitchable } from "../parse/index.ts";
import type { CcProvider, PinEntry, RecentEntry } from "../types.ts";
import { getAppTypeIcon } from "./labels.ts";

export interface QuickEntry {
  provider: CcProvider;
  modelId: string;
  pinned: boolean;
  label: string;
}

/** ponytail: hard cap keeps /ps a single screen; the 3-level picker covers the long tail. */
export const QUICK_LIMIT = 10;

/**
 * Pins first (★, config order), then recent by time desc. Deduped by
 * (appType, dbId, model) — composite identity (#9). Stale dbIds and
 * unswitchable providers are dropped silently — /ps is a shortcut, not a
 * diagnostic surface.
 */
export function buildQuickEntries(
  pins: PinEntry[],
  recent: RecentEntry[],
  providers: CcProvider[],
): QuickEntry[] {
  const byId = new Map(providers.map((p) => [`${p.appType}\n${p.id}`, p]));
  // Legacy fallback: first provider per dbId (pre-migration pins have no appType).
  const byIdAny = new Map<string, CcProvider>();
  for (const p of providers) if (!byIdAny.has(p.id)) byIdAny.set(p.id, p);
  const seen = new Set<string>();
  const out: QuickEntry[] = [];

  const push = (appType: string, dbId: string, modelId: string, pinned: boolean): void => {
    if (out.length >= QUICK_LIMIT) return;
    const key = `${appType}\n${dbId}\n${modelId}`;
    if (seen.has(key)) return;
    const provider = byId.get(`${appType}\n${dbId}`) ?? byIdAny.get(dbId);
    if (!provider || !isSwitchable(provider)) return;
    seen.add(key);
    const icon = getAppTypeIcon(provider.appType);
    const badge = pinned ? "* " : "  ";
    out.push({
      provider,
      modelId,
      pinned,
      label: `${badge}${icon} ${provider.appType}/${provider.displayName} · ${modelId}`,
    });
  };
  for (const p of pins) push(p.appType ?? "", p.dbId, p.model, true);
  for (const r of [...recent].sort((a, b) => b.at - a.at)) push(r.appType ?? "", r.dbId, r.model, false);
  return out;
}
