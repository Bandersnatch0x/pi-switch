/** /ps quick-switch list: pinned + recent pairs collapsed to one screen. */
import { isSwitchable } from "../parse/index.ts";
import type { CcProvider, PinEntry, RecentEntry } from "../types.ts";
import { getAppTypeIcon } from "./labels.ts";

export interface QuickEntry {
  provider: CcProvider;
  modelId: string;
  pinned: boolean;
  label: string;
  /**
   * Stored pin behind a starred row. Unpin must toggle with THIS identity:
   * the resolved provider may carry a different appType (dbId fallback for
   * stale/composite identities), which misses sameEntry and would add a
   * duplicate instead of removing the pin.
   */
  pin?: PinEntry;
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

  const push = (appType: string, dbId: string, modelId: string, pin?: PinEntry): void => {
    if (out.length >= QUICK_LIMIT) return;
    const provider = byId.get(`${appType}\n${dbId}`) ?? byIdAny.get(dbId);
    if (!provider || !isSwitchable(provider)) return;
    // Key on the *resolved* provider identity so an appType-less legacy entry
    // and its migrated twin collapse to one row.
    const key = `${provider.appType}\n${provider.id}\n${modelId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const icon = getAppTypeIcon(provider.appType);
    const pinned = Boolean(pin);
    const badge = pinned ? "* " : "  ";
    out.push({
      provider,
      modelId,
      pinned,
      label: `${badge}${icon} ${provider.appType}/${provider.displayName} · ${modelId}`,
      pin,
    });
  };
  for (const p of pins) push(p.appType ?? "", p.dbId, p.model, p);
  for (const r of [...recent].sort((a, b) => b.at - a.at)) push(r.appType ?? "", r.dbId, r.model);
  return out;
}
