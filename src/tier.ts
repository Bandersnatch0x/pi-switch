/**
 * App-type support tiers (issue #14, W2).
 *
 * Provider-level tier is derived from the parse result + credential
 * reachability:
 * - direct: switchable (static baseUrl + apiKey resolved, protocol mapped)
 * - visible-only: managed-auth / parse failure / unknown protocol; listed but
 *   never switched (SPEC §11); carries the reason bucket
 * - routed-fallback: no static reusable credentials AND the app type has a
 *   CC Switch application-level routing fallback (claude-desktop, openclaw);
 *   only usable when the client explicitly points at the CC Switch proxy
 *   (never enabled per-provider automatically, #10/#14)
 *
 * hybrid is deliberately absent (#10: 3.19 routing contract has no
 * Provider identity, so per-provider hybrid is impossible).
 */

import type { CcProvider } from "./types.ts";
import { isSwitchable, MANAGED_AUTH_PARSE_ERROR } from "./parse/index.ts";

export type ProviderTier = "direct" | "visible-only" | "routed-fallback";

/** Visible-only reason buckets (W2 distribution). */
export type VisibleOnlyReason = "managed-auth" | "parse-error" | "no-credentials";

export interface ProviderTierInfo {
  tier: ProviderTier;
  reason?: VisibleOnlyReason;
  /** app types with a CC Switch application-level routing fallback (#14). */
}

/** App types whose only fallback is application-level routing (claude-desktop/openclaw). */
const ROUTED_APP_TYPES = new Set(["claude-desktop", "openclaw"]);

export function deriveTier(provider: CcProvider): ProviderTierInfo {
  if (isSwitchable(provider)) return { tier: "direct" };

  const reason: VisibleOnlyReason =
    provider.parseError === MANAGED_AUTH_PARSE_ERROR
      ? "managed-auth"
      : provider.apiKey || provider.baseUrl
        ? "parse-error"
        : "no-credentials";

  if (ROUTED_APP_TYPES.has(provider.appType)) {
    return { tier: "routed-fallback", reason };
  }
  return { tier: "visible-only", reason };
}

/** Per-app-type tier summary rows for doctor W2. */
export interface AppTypeTierRow {
  appType: string;
  total: number;
  direct: number;
  visible: number;
  routed: number;
  /** visible-only reason distribution, e.g. { "managed-auth": 2 }. */
  reasonDistribution: Partial<Record<VisibleOnlyReason, number>>;
}

export function summarizeTiers(providers: CcProvider[]): AppTypeTierRow[] {
  const groups = new Map<string, AppTypeTierRow>();
  for (const p of providers) {
    const row =
      groups.get(p.appType) ??
      {
        appType: p.appType,
        total: 0,
        direct: 0,
        visible: 0,
        routed: 0,
        reasonDistribution: {},
      };
    row.total += 1;
    const { tier, reason } = deriveTier(p);
    if (tier === "direct") row.direct += 1;
    else if (tier === "routed-fallback") row.routed += 1;
    else row.visible += 1;
    if (reason) row.reasonDistribution[reason] = (row.reasonDistribution[reason] ?? 0) + 1;
    groups.set(p.appType, row);
  }
  return [...groups.values()].sort((a, b) => a.appType.localeCompare(b.appType));
}
