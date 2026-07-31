/**
 * Resolve per-provider overrides from pi-switch.json.
 *
 * Kept separate from settings.ts and model-meta.ts to avoid a circular
 * import (settings needs cleanModelMeta; model-meta needs override lookup).
 */

import type { CcProvider, PiSwitchConfig } from "./types.ts";

export type ProviderOverrideEntry = NonNullable<
  PiSwitchConfig["providerOverrides"]
>[string];

/** Keys accepted by providerOverrides, in match priority order. */
export function providerOverrideKeys(
  provider: Pick<CcProvider, "id" | "piName" | "displayName">,
): string[] {
  const display = provider.displayName?.trim() ?? "";
  const slugName = display
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const keys = [provider.id, provider.piName, display, slugName];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * Resolve per-provider parameter overrides from pi-switch.json.
 * Match order (issue #16): nested [appType][id] -> top-level dbId -> piName
 * -> displayName -> slug(displayName). Case-insensitive fallback for
 * name-like keys. Top-level legacy keys still match (back-compat).
 */
export function resolveProviderOverride(
  overrides: PiSwitchConfig["providerOverrides"] | undefined,
  provider: Pick<CcProvider, "id" | "piName" | "displayName"> & { appType?: string },
): ProviderOverrideEntry | undefined {
  if (!overrides) return undefined;

  // 1. nested composite [appType][id] (canonical post-migration shape)
  if (provider.appType) {
    const appGroup = overrides[provider.appType];
    if (appGroup && typeof appGroup === "object") {
      const hit = (appGroup as Record<string, unknown>)[provider.id];
      if (hit && typeof hit === "object") return hit as ProviderOverrideEntry;
    }
  }

  // 2. top-level legacy chain: dbId -> piName -> displayName -> slug
  for (const key of providerOverrideKeys(provider)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      return overrides[key] as ProviderOverrideEntry;
    }
  }

  // Case-insensitive match for human-written name keys
  const wanted = new Set(providerOverrideKeys(provider).map((k) => k.toLowerCase()));
  for (const [key, value] of Object.entries(overrides)) {
    if (wanted.has(key.toLowerCase())) return value as ProviderOverrideEntry;
  }
  return undefined;
}
