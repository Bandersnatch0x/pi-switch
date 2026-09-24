/**
 * Mirror in-process provider registrations into Pi's `models.json`.
 *
 * Why this exists: `pi.registerProvider()` only mutates the *current process's*
 * ModelRuntime. Anything that builds its own runtime cannot see the provider —
 * pi-subagents' detached subagent runner is such a process (only the
 * foreground in-process child inherits the parent registry), so a pi-switch-only
 * `provider/id` fails to resolve there and the child dies before its first
 * request. `models.json` is Pi's cross-process provider layer (the same file
 * CC Switch writes), so mirroring there makes the registration resolvable
 * everywhere.
 *
 * Safety rules (models.json is shared with the user and other tools):
 *   - Only `providers.<name>` is touched; every other key is preserved.
 *   - Only entries pi-switch itself wrote are rewritten or pruned. An entry
 *     whose content differs from ours and is not in our ownership record is
 *     reported as a conflict and left untouched.
 *   - Writes are atomic + compare-and-swap via json-file.ts, so a concurrent
 *     external edit aborts instead of being clobbered.
 */

import {
  readJsonObjectLenient,
  updateJsonObjectAtomic,
  type FsLike,
  type JsonObject,
} from "./json-file.ts";
import type { BuiltProviderConfig } from "./register.ts";

export const PERSISTED_PROVIDERS_VERSION = 1;

/** Sidecar document: `~/.pi/agent/pi-switch-persisted-providers.json`. */
export interface PersistedProvidersState {
  version: number;
  /** models.json provider name → digest of the exact entry pi-switch wrote. */
  owned: Record<string, string>;
}

export interface ProviderMirrorEntry {
  name: string;
  config: JsonObject;
}

/** Stable (key-sorted) JSON so digests never depend on property order. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

/** Model keys Pi's models.json schema knows; anything else is dropped. */
const MODEL_KEYS = [
  "id",
  "name",
  "api",
  "baseUrl",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "inputLimits",
  "cost",
  "promptCache",
  "contextWindow",
  "maxTokens",
  "samplingParams",
  "headers",
  "compat",
] as const;

function pick(source: Record<string, unknown>, keys: readonly string[]): JsonObject {
  const out: JsonObject = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Project one registration config onto the shape `models.json` validates
 * (`ProviderConfigSchema`). Unknown keys are dropped rather than written: an
 * invalid entry makes Pi reject the *whole* file and lose every provider in it.
 */
export function sanitizeProviderEntry(config: BuiltProviderConfig): JsonObject {
  const source = config as unknown as Record<string, unknown>;
  const entry = pick(source, ["name", "baseUrl", "apiKey", "api", "authHeader", "headers"]);
  const models = Array.isArray(source.models) ? source.models : [];
  const sanitizedModels = models
    .filter((model): model is Record<string, unknown> => Boolean(model) && typeof model === "object")
    .map((model) => pick(model, MODEL_KEYS))
    .filter((model) => typeof model.id === "string" && model.id.length > 0);
  if (sanitizedModels.length) entry.models = sanitizedModels;
  return entry;
}

/** Union two entries for the same provider; the later model wins per id. */
export function mergeProviderEntry(
  previous: JsonObject | undefined,
  next: JsonObject,
): JsonObject {
  if (!previous) return next;
  const previousModels = Array.isArray(previous.models) ? previous.models : undefined;
  const nextModels = Array.isArray(next.models) ? next.models : undefined;
  if (!previousModels?.length || !nextModels?.length) {
    return { ...previous, ...next };
  }
  const merged: unknown[] = [...previousModels];
  for (const model of nextModels) {
    const id = (model as { id?: unknown }).id;
    const index = merged.findIndex(
      (candidate) => (candidate as { id?: unknown }).id === id,
    );
    if (index >= 0) merged[index] = model;
    else merged.push(model);
  }
  return { ...previous, ...next, models: merged };
}

export interface ProviderMirror {
  record(name: string, config: BuiltProviderConfig): void;
  forget(names: string[]): void;
  entries(): ProviderMirrorEntry[];
  size(): number;
}

/**
 * Accumulates what this process registered so one sync can write the whole set.
 * Re-registering the same provider with one model id must not shrink the entry.
 */
export function createProviderMirror(): ProviderMirror {
  const entries = new Map<string, JsonObject>();
  return {
    record(name, config) {
      if (!name) return;
      entries.set(name, mergeProviderEntry(entries.get(name), sanitizeProviderEntry(config)));
    },
    forget(names) {
      for (const name of names) entries.delete(name);
    },
    entries() {
      return [...entries].map(([name, config]) => ({ name, config }));
    },
    size() {
      return entries.size;
    },
  };
}

export interface ProviderSyncPlan {
  /** Entries to write into `providers`. */
  writes: ProviderMirrorEntry[];
  /** Owned names to delete from `providers`. */
  removals: string[];
  /** Names left alone because models.json holds foreign content under them. */
  conflicts: string[];
  /** Ownership record after this sync. */
  nextOwned: Record<string, string>;
  valueChanged: boolean;
  ownershipChanged: boolean;
}

function asProviderMap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => b[key] === a[key]);
}

/**
 * Pure decision: what to write, what to prune, what to leave alone.
 * A name is ours when it is absent, when its digest matches the ownership
 * record, or when the file already holds exactly what we would write.
 */
export function planProviderSync(input: {
  existing: Record<string, unknown> | undefined;
  owned: Record<string, string>;
  desired: ProviderMirrorEntry[];
  digest: (text: string) => string;
}): ProviderSyncPlan {
  const existing = asProviderMap(input.existing);
  const wanted = new Map(input.desired.map((entry) => [entry.name, entry]));
  const writes: ProviderMirrorEntry[] = [];
  const conflicts: string[] = [];
  const nextOwned: Record<string, string> = {};

  for (const entry of wanted.values()) {
    const digest = input.digest(stableJson(entry.config));
    const current = existing[entry.name];
    if (current === undefined) {
      writes.push(entry);
      nextOwned[entry.name] = digest;
      continue;
    }
    const currentDigest = input.digest(stableJson(current));
    if (currentDigest === digest) {
      // Already identical: adopt without rewriting.
      nextOwned[entry.name] = digest;
      continue;
    }
    if (input.owned[entry.name] === currentDigest) {
      writes.push(entry);
      nextOwned[entry.name] = digest;
      continue;
    }
    conflicts.push(entry.name);
  }

  const removals: string[] = [];
  for (const [name, digest] of Object.entries(input.owned)) {
    if (wanted.has(name)) continue;
    const current = existing[name];
    if (current === undefined) continue;
    // Prune only content we still recognize as ours.
    if (input.digest(stableJson(current)) === digest) removals.push(name);
  }

  return {
    writes,
    removals,
    conflicts,
    nextOwned,
    valueChanged: writes.length > 0 || removals.length > 0,
    ownershipChanged: !sameRecord(input.owned, nextOwned),
  };
}

export interface ProviderPersistenceIo {
  fs: FsLike;
  modelsPath: string;
  statePath: string;
  pid: number;
  /** Short stable digest of a string (sha256 hex is fine). */
  digest: (text: string) => string;
}

export interface ProviderSyncResult {
  ok: boolean;
  written: string[];
  removed: string[];
  conflicts: string[];
  error?: string;
}

function readOwnership(fs: FsLike, statePath: string): Record<string, string> {
  const raw = readJsonObjectLenient(fs, statePath);
  const owned = raw.owned;
  if (!owned || typeof owned !== "object" || Array.isArray(owned)) return {};
  const out: Record<string, string> = {};
  for (const [name, digest] of Object.entries(owned as Record<string, unknown>)) {
    if (typeof digest === "string") out[name] = digest;
  }
  return out;
}

/**
 * Strict read of models.json: a file Pi cannot parse is left alone rather than
 * replaced by a document reconstructed from `{}`.
 */
function readModelsDocument(fs: FsLike, path: string): JsonObject {
  if (!fs.existsSync(path)) return {};
  const source = fs.readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `refusing to rewrite ${path}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`refusing to rewrite ${path}: root is not an object`);
  }
  return parsed as JsonObject;
}

function writeOwnership(
  io: ProviderPersistenceIo,
  owned: Record<string, string>,
): void {
  updateJsonObjectAtomic(io.fs, io.statePath, io.pid, (document) => ({
    document: {
      ...document,
      version: PERSISTED_PROVIDERS_VERSION,
      owned,
    },
    result: undefined,
  }));
}

function applyPlan(
  existing: Record<string, unknown>,
  plan: ProviderSyncPlan,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  for (const name of plan.removals) delete next[name];
  for (const entry of plan.writes) next[entry.name] = entry.config;
  return next;
}

/**
 * Apply the mirror to models.json. Never throws: persistence is a best-effort
 * side effect of switching, and a failure must not fail the switch itself.
 */
export function syncPersistedProviders(
  io: ProviderPersistenceIo,
  desired: ProviderMirrorEntry[],
): ProviderSyncResult {
  const empty: ProviderSyncResult = { ok: true, written: [], removed: [], conflicts: [] };
  try {
    const owned = readOwnership(io.fs, io.statePath);
    const document = readModelsDocument(io.fs, io.modelsPath);
    const existing = asProviderMap(document.providers);
    const preview = planProviderSync({
      existing,
      owned,
      desired,
      digest: io.digest,
    });
    if (!preview.valueChanged && !preview.ownershipChanged) {
      return { ...empty, conflicts: preview.conflicts };
    }

    let applied: ProviderSyncPlan | undefined;
    if (preview.valueChanged) {
      updateJsonObjectAtomic(io.fs, io.modelsPath, io.pid, (document) => {
        // Replan against the fresh document so a concurrent edit wins the race
        // instead of being overwritten with stale decisions.
        const fresh = asProviderMap(document.providers);
        const plan = planProviderSync({ existing: fresh, owned, desired, digest: io.digest });
        applied = plan;
        if (!plan.valueChanged) return { document, result: undefined };
        return {
          document: { ...document, providers: applyPlan(fresh, plan) },
          result: undefined,
        };
      });
    }

    const finalOwned = applied?.nextOwned ?? preview.nextOwned;
    if (!sameRecord(owned, finalOwned)) writeOwnership(io, finalOwned);

    const effective = applied ?? preview;
    return {
      ok: true,
      written: effective.writes.map((entry) => entry.name),
      removed: effective.removals,
      conflicts: effective.conflicts,
    };
  } catch (error) {
    return {
      ...empty,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
