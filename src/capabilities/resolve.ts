/**
 * Model capability resolution (issue #15 D1-D3, W4).
 *
 * Deterministic priority, no silent merging:
 *   user override > models.dev (fetchedAt) > cc meta (transport) > protocol default
 * Lower-layer disagreements surface as conflicts (WARN in doctor). User
 * overrides never conflict (documented resolution). Stale models.dev facts
 * keep last-good and are flagged (TTL = compat window).
 */

import type { ModelMetaOverride } from "../types.ts";
import type { ModelsDevCapabilities } from "./models-dev.ts";
import { CAPABILITIES_TTL_MS } from "./models-dev.ts";

/** ModelMetaOverride + diagnostic-only vision (no registration surface, #15). */
export type CapabilityMeta = ModelMetaOverride & { vision?: boolean };

export type CapabilitySource =
  | "user-override"
  | "models-dev"
  | "cc-meta"
  | "protocol-default";

export interface CapabilityEntry<T> {
  value: T;
  source: CapabilitySource;
  /** models.dev observedAt / fetchedAt when source is models-dev. */
  fetchedAt?: string;
  /** True when the models-dev fact is older than the compat-window TTL. */
  stale?: boolean;
}

export interface CapabilityConflict {
  field: string;
  effective: string;
  overridden: string;
  effectiveSource: CapabilitySource;
  overriddenSource: CapabilitySource;
}

export interface ResolvedCapabilities {
  contextWindow: CapabilityEntry<number>;
  maxTokens: CapabilityEntry<number>;
  reasoning: CapabilityEntry<boolean>;
  vision: CapabilityEntry<boolean>;
  conflicts: CapabilityConflict[];
}

interface LayerInputs {
  user?: CapabilityMeta | undefined;
  modelsDev?: ModelsDevCapabilities | undefined;
  ccMeta?: CapabilityMeta | undefined;
  defaults?: CapabilityMeta | undefined;
  now?: number;
  staleThresholdMs?: number;
}

function pick<T>(
  field: "contextWindow" | "maxTokens" | "reasoning" | "vision",
  layers: Array<{ value: T | undefined; source: CapabilitySource; fetchedAt?: string }>,
): { entry: CapabilityEntry<T>; overridden: Array<{ value: T; source: CapabilitySource }> } {
  const picked = layers.find((l) => l.value !== undefined);
  const effective = picked ?? {
    // never happens: defaults layer always supplies value for the 4 fields
    value: undefined as unknown as T,
    source: "protocol-default" as CapabilitySource,
  };
  const overridden = layers
    .filter((l) => l.value !== undefined && l !== picked)
    .map((l) => ({ value: l.value as T, source: l.source }));
  return { entry: { ...effective, value: effective.value as T }, overridden };
}

/** Resolve capability facts with deterministic priority + conflict/stale facts. */
export function resolveModelCapabilities(input: LayerInputs): ResolvedCapabilities {
  const now = input.now ?? Date.now();
  const ttl = input.staleThresholdMs ?? CAPABILITIES_TTL_MS;
  const md = input.modelsDev;
  const mdFetched = md?.observedAt;
  const mdStale =
    mdFetched !== undefined &&
    now - Date.parse(mdFetched) > ttl;

  const layersFor = <T>(field: "contextWindow" | "maxTokens" | "reasoning" | "vision") => {
    const layers: Array<{ value: T | undefined; source: CapabilitySource; fetchedAt?: string }> = [
      { value: input.user?.[field] as T | undefined, source: "user-override" },
      { value: md?.[field] as T | undefined, source: "models-dev", fetchedAt: mdFetched },
      { value: input.ccMeta?.[field] as T | undefined, source: "cc-meta" },
      { value: input.defaults?.[field] as T | undefined, source: "protocol-default" },
    ];
    return layers;
  };

  const context = pick<number>("contextWindow", layersFor("contextWindow"));
  const maxTokens = pick<number>("maxTokens", layersFor("maxTokens"));
  const reasoning = pick<boolean>("reasoning", layersFor("reasoning"));
  const vision = pick<boolean>("vision", layersFor("vision"));

  // Conflicts: lower-layer disagreement with the winner, EXCLUDING the
  // user-override layer (overriding upstream is the documented resolution).
  const conflicts: CapabilityConflict[] = [];
  const entries = { contextWindow: context.entry, maxTokens: maxTokens.entry, reasoning: reasoning.entry, vision: vision.entry };
  for (const [field, res] of [
    ["contextWindow", context],
    ["maxTokens", maxTokens],
    ["reasoning", reasoning],
    ["vision", vision],
  ] as const) {
    if (res.entry.source === "user-override") continue;
    for (const o of res.overridden) {
      if (o.value !== res.entry.value) {
        conflicts.push({
          field,
          effective: String(res.entry.value),
          overridden: String(o.value),
          effectiveSource: res.entry.source,
          overriddenSource: o.source,
        });
      }
    }
  }

  const stale = mdStale;
  for (const e of [entries.contextWindow, entries.maxTokens, entries.reasoning, entries.vision]) {
    if (e.source === "models-dev") e.stale = stale;
  }

  return { ...entries, conflicts };
}
