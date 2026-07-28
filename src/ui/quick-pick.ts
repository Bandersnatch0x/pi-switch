/** /ps quick-switch list: pinned + recent pairs collapsed to one screen. */
import { isSwitchable } from "../parse/index.ts";
import type { CcProvider, PinEntry, RecentEntry } from "../types.ts";

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
 * dbId+model; stale dbIds and unswitchable providers are dropped silently —
 * /ps is a shortcut, not a diagnostic surface.
 */
export function buildQuickEntries(
  pins: PinEntry[],
  recent: RecentEntry[],
  providers: CcProvider[],
): QuickEntry[] {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: QuickEntry[] = [];

  const push = (dbId: string, modelId: string, pinned: boolean): void => {
    if (out.length >= QUICK_LIMIT) return;
    const key = `${dbId}\n${modelId}`;
    if (seen.has(key)) return;
    const provider = byId.get(dbId);
    if (!provider || !isSwitchable(provider)) return;
    seen.add(key);
    out.push({
      provider,
      modelId,
      pinned,
      label: `${pinned ? "★ " : ""}${provider.appType}/${provider.displayName} · ${modelId}`,
    });
  };

  for (const p of pins) push(p.dbId, p.model, true);
  for (const r of [...recent].sort((a, b) => b.at - a.at)) push(r.dbId, r.model, false);
  return out;
}
