/**
 * Model capability resolution (issue #15 D1-D3, W4; issue #36 id-tag + host;
 * issue #63 unknown-model conservatism).
 *
 * Deterministic priority, no silent merging:
 *   user override > model id tag > host adaptation (anyrouter) >
 *   models.dev (fetchedAt) > cc meta (transport) > protocol default
 *
 * Issue #63:
 * - maxTokens never invents a protocol 32K/64K/128K floor; missing → unresolved
 * - reasoning missing → runtime conservative false with conservative-default source
 * - stale models.dev last-good still wins and is flagged
 *
 * Lower-layer disagreements surface as conflicts (WARN in doctor). User
 * overrides never conflict (documented resolution).
 */

import type { ModelMetaOverride } from "../types.ts";
import type { ModelsDevCapabilities } from "./models-dev.ts";
import { CAPABILITIES_TTL_MS } from "./models-dev.ts";

/** ModelMetaOverride + diagnostic-only vision (no registration surface, #15). */
export type CapabilityMeta = ModelMetaOverride & { vision?: boolean };

export type CapabilitySource =
  | "user-override"
  | "model-id-tag"
  | "host-adaptation"
  | "models-dev"
  | "cc-meta"
  | "protocol-default"
  /** Runtime-only derivation when reasoning is unknown (issue #63). */
  | "conservative-default"
  /** No trusted maxTokens authority (issue #63). */
  | "unresolved";

export interface CapabilityEntry<T> {
  value: T | undefined;
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
  idTag?: CapabilityMeta | undefined;
  hostAdaptation?: CapabilityMeta | undefined;
  modelsDev?: ModelsDevCapabilities | undefined;
  ccMeta?: CapabilityMeta | undefined;
  /**
   * Protocol / structural floors. Issue #63: callers must NOT put maxTokens
   * (or unknown-model reasoning) here — those no longer invent protocol values.
   */
  defaults?: CapabilityMeta | undefined;
  now?: number;
  staleThresholdMs?: number;
}

function pickOptional<T>(
  layers: Array<{ value: T | undefined; source: CapabilitySource; fetchedAt?: string }>,
): {
  entry: CapabilityEntry<T> | undefined;
  overridden: Array<{ value: T; source: CapabilitySource }>;
} {
  const picked = layers.find((l) => l.value !== undefined);
  if (!picked || picked.value === undefined) {
    return { entry: undefined, overridden: [] };
  }
  const overridden = layers
    .filter((l) => l.value !== undefined && l !== picked)
    .map((l) => ({ value: l.value as T, source: l.source }));
  return {
    entry: { ...picked, value: picked.value as T },
    overridden,
  };
}

/** True when maxTokens has a trusted numeric authority (not unresolved). */
export function isMaxTokensResolved(
  entry: CapabilityEntry<number>,
): entry is CapabilityEntry<number> & { value: number } {
  return entry.source !== "unresolved" && typeof entry.value === "number" && entry.value > 0;
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
      { value: input.idTag?.[field] as T | undefined, source: "model-id-tag" },
      { value: input.hostAdaptation?.[field] as T | undefined, source: "host-adaptation" },
      { value: md?.[field] as T | undefined, source: "models-dev", fetchedAt: mdFetched },
      { value: input.ccMeta?.[field] as T | undefined, source: "cc-meta" },
      { value: input.defaults?.[field] as T | undefined, source: "protocol-default" },
    ];
    return layers;
  };

  const context = pickOptional<number>(layersFor("contextWindow"));
  const maxTokens = pickOptional<number>(layersFor("maxTokens"));
  const reasoning = pickOptional<boolean>(layersFor("reasoning"));
  const vision = pickOptional<boolean>(layersFor("vision"));

  // contextWindow still uses a structural floor when nothing else supplies it
  // (status bar / compact need a number; issue #63 only bans maxTokens floors).
  const contextEntry: CapabilityEntry<number> = context.entry ?? {
    value: undefined,
    source: "unresolved",
  };
  const maxTokensEntry: CapabilityEntry<number> = maxTokens.entry ?? {
    value: undefined,
    source: "unresolved",
  };
  // reasoning: unknown → runtime conservative false; never written back to config.
  const reasoningEntry: CapabilityEntry<boolean> = reasoning.entry ?? {
    value: false,
    source: "conservative-default",
  };
  const visionEntry: CapabilityEntry<boolean> = vision.entry ?? {
    value: false,
    source: "conservative-default",
  };

  // Conflicts: lower-layer disagreement with the winner, EXCLUDING the
  // user-override layer (overriding upstream is the documented resolution).
  // Unresolved / pure conservative entries have no conflicts.
  const conflicts: CapabilityConflict[] = [];
  const pairs = [
    ["contextWindow", context, contextEntry],
    ["maxTokens", maxTokens, maxTokensEntry],
    ["reasoning", reasoning, reasoningEntry],
    ["vision", vision, visionEntry],
  ] as const;

  for (const [field, res, entry] of pairs) {
    if (!res.entry) continue;
    if (entry.source === "user-override") continue;
    if (entry.source === "unresolved" || entry.source === "conservative-default") continue;
    for (const o of res.overridden) {
      if (o.value !== entry.value) {
        conflicts.push({
          field,
          effective: String(entry.value),
          overridden: String(o.value),
          effectiveSource: entry.source,
          overriddenSource: o.source,
        });
      }
    }
  }

  const entries = {
    contextWindow: contextEntry,
    maxTokens: maxTokensEntry,
    reasoning: reasoningEntry,
    vision: visionEntry,
  };
  const stale = mdStale;
  for (const e of [entries.contextWindow, entries.maxTokens, entries.reasoning, entries.vision]) {
    if (e.source === "models-dev") e.stale = stale;
  }

  return { ...entries, conflicts };
}
