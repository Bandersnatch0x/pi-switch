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
 * Match order: dbId → piName → displayName → slug(displayName).
 * Case-insensitive fallback for name-like keys.
 */
export function resolveProviderOverride(
  overrides: PiSwitchConfig["providerOverrides"] | undefined,
  provider: Pick<CcProvider, "id" | "piName" | "displayName">,
): ProviderOverrideEntry | undefined {
  if (!overrides) return undefined;

  for (const key of providerOverrideKeys(provider)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      return overrides[key];
    }
  }

  // Case-insensitive match for human-written name keys
  const wanted = new Set(providerOverrideKeys(provider).map((k) => k.toLowerCase()));
  for (const [key, value] of Object.entries(overrides)) {
    if (wanted.has(key.toLowerCase())) return value;
  }
  return undefined;
}
