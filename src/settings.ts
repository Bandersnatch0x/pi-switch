import type {
  FingerprintPreset,
  ModelMetaOverride,
  ModelOverrideEntry,
  PiSwitchConfig,
  PiSwitchSelection,
  SessionModelStrategy,
} from "./types.ts";
import type { UserReasoningProfileOverride } from "./capabilities/thinking-projection.ts";
import {
  isThinkingFormat,
  isThinkingLevel,
  LEGACY_SETTINGS_KEY,
  SESSION_MODEL_STRATEGIES,
  SETTINGS_KEY,
  THINKING_LEVELS,
} from "./types.ts";
import type { CcProvider } from "./types.ts";
import {
  cleanModelMeta,
  matchExactModelOverride,
  matchExactModelOverrideEntry,
} from "./model-meta.ts";
import { parsePins, parseRecent } from "./pins-recent.ts";
import { parseClaudeCodeCompatConfig } from "./compat/claude-code.ts";
import { parseGeminiToolCompatConfig } from "./compat/gemini-tool-compat.ts";
import {
  parseProviderWireCompat,
  type ProviderWireCompat,
} from "./provider-wire-compat.ts";
import {
  parseModelTupleCompat,
  type ModelTupleCompat,
} from "./model-tuple-compat.ts";
import { hasOwn, isPlainObject } from "./compat/wire-shared.ts";
import {
  readJsonObjectLenient,
  type FsLike,
} from "./json-file.ts";
import {
  configEditError,
  editConfig,
  editConfigWithResult,
  type ConfigEditResult,
  type ConfigWriteTarget,
} from "./config-edit.ts";
import {
  applyExactModelThinkingOptIn,
  type ExactModelThinkingOptInRequest,
} from "./capabilities/thinking-opt-in.ts";
import {
  normalizeUserReasoningProfileOverride,
  providerEndpointTupleKey,
  type ThinkingProjectionDecision,
} from "./capabilities/thinking-projection.ts";

/**
 * Minimum supported Pi runtime (issue #11 D1, compat-window-policy).
 * Must match `peerDependencies["@earendil-works/pi-coding-agent"]` in package.json.
 */
export const PI_MIN_VERSION = "0.78.1";

/** Compare dotted numeric semver strings (no prerelease handling). Returns -1/0/1. */
export function compareSemver(a: string, b: string): number {
  const pa = a.trim().split(".").map(Number);
  const pb = b.trim().split(".").map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

export function readJsonFile(fs: FsLike, path: string): Record<string, unknown> {
  return readJsonObjectLenient(fs, path);
}

export function readSelection(fs: FsLike, settingsPath: string): PiSwitchSelection | undefined {
  const settings = readJsonFile(fs, settingsPath);
  const sel = settings[SETTINGS_KEY] as PiSwitchSelection | undefined;
  if (sel?.dbId && sel?.model) {
    return {
      dbId: String(sel.dbId),
      model: String(sel.model).trim(),
      tab: sel.tab ? String(sel.tab) : undefined,
      appType: sel.appType ? String(sel.appType) : undefined,
      provider: sel.provider ? String(sel.provider) : undefined,
    };
  }
  return undefined;
}

export function writeSelection(
  fs: FsLike,
  settingsPath: string,
  sel: PiSwitchSelection,
  pid: number,
): { ok: boolean; error?: string } {
  // Same atomic envelope as pi-switch.json writers; the target here is
  // settings.json (ConfigWriteTarget.configPath = whichever config file).
  return editConfig({ fs, configPath: settingsPath, pid }, (settings) => ({
    ...settings,
    [SETTINGS_KEY]: {
      dbId: sel.dbId,
      model: sel.model.trim(),
      tab: sel.tab,
      appType: sel.appType,
      provider: sel.provider,
    },
  }));
}

/**
 * One-shot migration from legacy ccSwitchSelection.
 * Only migrates when the legacy provider name uniquely matches one provider
 * (by displayName or old ccs- slug heuristics).
 */
export function migrateLegacySelection(
  fs: FsLike,
  settingsPath: string,
  providers: CcProvider[],
  pid: number,
): PiSwitchSelection | undefined {
  const existing = readSelection(fs, settingsPath);
  if (existing) return existing;

  const settings = readJsonFile(fs, settingsPath);
  const legacy = settings[LEGACY_SETTINGS_KEY] as
    | { provider?: string; model?: string }
    | undefined;
  if (!legacy?.provider || !legacy?.model) return undefined;

  const nameHint = legacy.provider
    .replace(/^ccs-/, "")
    .replace(/^ps-/, "");
  const matches = providers.filter((p) => {
    const slugName = p.displayName
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return (
      p.piName === legacy.provider ||
      p.displayName === legacy.provider ||
      slugName === nameHint ||
      p.piName.endsWith(`-${nameHint}`)
    );
  });

  if (matches.length !== 1) return undefined;

  const p = matches[0];
  const sel: PiSwitchSelection = {
    dbId: p.id,
    model: legacy.model.trim(),
    appType: p.appType,
    tab: p.appType,
    provider: p.piName,
  };
  writeSelection(fs, settingsPath, sel, pid);
  return sel;
}

function parseModelMeta(raw: unknown): ModelMetaOverride | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return cleanModelMeta(raw as ModelMetaOverride);
}

const PROVIDER_OVERRIDE_ENTRY_KEYS = new Set([
  "label",
  "fingerprint",
  "headers",
  "modelMeta",
  "modelOverrides",
  "reasoningProfile",
  "compat",
  "claudeCodeCompat",
  "geminiToolCompat",
]);

function rejectNestedWireCompat(value: unknown, path: string): void {
  if (isPlainObject(value) && hasOwn(value, "compat")) {
    throw new Error(
      `invalid ${path}.compat scope: Provider wire compat belongs under providerOverrides.<provider>.compat`,
    );
  }
}

/** Exact-model tuple keys that must not appear at Provider scope. */
function looksLikeExactModelTupleCompat(c: Record<string, unknown>): boolean {
  return (
    hasOwn(c, "supportsDeveloperRole") ||
    hasOwn(c, "supportsReasoningEffort") ||
    hasOwn(c, "maxTokensField") ||
    hasOwn(c, "thinkingFormat") ||
    hasOwn(c, "requiresReasoningContentOnAssistantMessages") ||
    hasOwn(c, "forceAdaptiveThinking") ||
    hasOwn(c, "supportsTemperature")
  );
}

function parseModelOverrideEntry(
  raw: Record<string, unknown>,
  path: string,
  modelId: string,
): ModelOverrideEntry {
  const meta = parseModelMeta(raw) ?? {};
  const entry: ModelOverrideEntry = { ...meta };
  if (hasOwn(raw, "compat")) {
    entry.compat = parseModelTupleCompat(raw.compat, `${path}.compat`);
  }
  if (hasOwn(raw, "reasoningProfile")) {
    if (modelId.includes("*")) {
      throw new Error(
        `invalid ${path}.reasoningProfile scope: reasoning profiles require an exact model id`,
      );
    }
    try {
      entry.reasoningProfile = normalizeUserReasoningProfileOverride(
        raw.reasoningProfile,
      );
    } catch (error) {
      throw new Error(
        `invalid ${path}.reasoningProfile: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return entry;
}

function rejectBroadReasoningProfile(value: unknown, path: string): void {
  if (isPlainObject(value) && hasOwn(value, "reasoningProfile")) {
    throw new Error(
      `invalid ${path}.reasoningProfile scope: reasoning profiles belong under an exact modelOverrides.<model> entry`,
    );
  }
}

function parseProviderOverrideEntry(
  raw: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  // modelMeta must not host wire/tuple compat.
  rejectNestedWireCompat(raw.modelMeta, `${path}.modelMeta`);
  rejectBroadReasoningProfile(raw.modelMeta, `${path}.modelMeta`);
  if (hasOwn(raw, "reasoningProfile")) {
    throw new Error(
      `invalid ${path}.reasoningProfile scope: reasoning profiles belong under an exact modelOverrides.<model> entry`,
    );
  }

  const next = { ...raw };
  if (isPlainObject(raw.modelOverrides)) {
    const models: Record<string, ModelOverrideEntry> = {};
    for (const [modelId, modelRaw] of Object.entries(raw.modelOverrides)) {
      if (!isPlainObject(modelRaw)) continue;
      models[modelId] = parseModelOverrideEntry(
        modelRaw,
        `${path}.modelOverrides.${modelId}`,
        modelId,
      );
    }
    next.modelOverrides = models;
  }
  // Provider-scope compat is Provider wire (#62), never Chat tuple (#64).
  if (hasOwn(raw, "compat")) {
    const c = raw.compat;
    if (isPlainObject(c) && looksLikeExactModelTupleCompat(c)) {
      throw new Error(
        `invalid ${path}.compat scope: exact-model tuple compat belongs under modelOverrides.<model>.compat`,
      );
    }
    next.compat = parseProviderWireCompat(raw.compat, `${path}.compat`);
  }
  return next;
}

function parseProviderOverrides(
  raw: unknown,
): PiSwitchConfig["providerOverrides"] | undefined {
  if (!isPlainObject(raw)) return undefined;

  const parsed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) {
      parsed[key] = value;
      continue;
    }

    const isEntry = Object.keys(value).some((field) =>
      PROVIDER_OVERRIDE_ENTRY_KEYS.has(field),
    );
    if (isEntry) {
      parsed[key] = parseProviderOverrideEntry(
        value,
        `providerOverrides.${key}`,
      );
      continue;
    }

    const group: Record<string, unknown> = {};
    for (const [providerId, entry] of Object.entries(value)) {
      group[providerId] = isPlainObject(entry)
        ? parseProviderOverrideEntry(
            entry,
            `providerOverrides.${key}.${providerId}`,
          )
        : entry;
    }
    parsed[key] = group;
  }
  return parsed as PiSwitchConfig["providerOverrides"];
}

function parseSessionModelStrategy(v: unknown): SessionModelStrategy | undefined {
  return typeof v === "string" &&
    (SESSION_MODEL_STRATEGIES as readonly string[]).includes(v)
    ? (v as SessionModelStrategy)
    : undefined;
}

export function readPiSwitchConfig(fs: FsLike, path: string): PiSwitchConfig {
  const raw = readJsonFile(fs, path);
  if (hasOwn(raw, "compat")) {
    throw new Error(
      "invalid compat scope: Provider wire compat belongs under providerOverrides.<provider>.compat",
    );
  }
  rejectNestedWireCompat(raw.defaultModelMeta, "defaultModelMeta");
  rejectBroadReasoningProfile(raw.defaultModelMeta, "defaultModelMeta");
  const varsRaw =
    raw.vars && typeof raw.vars === "object" && !Array.isArray(raw.vars)
      ? (raw.vars as Record<string, unknown>)
      : undefined;
  return {
    tabs: Array.isArray(raw.tabs) ? raw.tabs.filter((t): t is string => typeof t === "string") : undefined,
    aliasCcs: typeof raw.aliasCcs === "boolean" ? raw.aliasCcs : undefined,
    persistProviders:
      typeof raw.persistProviders === "boolean" ? raw.persistProviders : undefined,
    sqlitePath: typeof raw.sqlitePath === "string" ? raw.sqlitePath : raw.sqlitePath === null ? null : undefined,
    vars: varsRaw
      ? {
          codexVersion: typeof varsRaw.codexVersion === "string" ? varsRaw.codexVersion : undefined,
          claudeCodeVersion:
            typeof varsRaw.claudeCodeVersion === "string" ? varsRaw.claudeCodeVersion : undefined,
          geminiVersion: typeof varsRaw.geminiVersion === "string" ? varsRaw.geminiVersion : undefined,
          anthropicVersion:
            typeof varsRaw.anthropicVersion === "string" ? varsRaw.anthropicVersion : undefined,
          anthropicBeta: typeof varsRaw.anthropicBeta === "string" ? varsRaw.anthropicBeta : undefined,
          codexOriginator:
            typeof varsRaw.codexOriginator === "string" ? varsRaw.codexOriginator : undefined,
        }
      : undefined,
    defaultModelMeta: parseModelMeta(raw.defaultModelMeta),
    claudeCodeCompat: parseClaudeCodeCompatConfig(raw.claudeCodeCompat),
    geminiToolCompat: parseGeminiToolCompatConfig(raw.geminiToolCompat),
    providerOverrides: parseProviderOverrides(raw.providerOverrides),
    pins: parsePins(raw.pins),
    recent: parseRecent(raw.recent),
    recentLimit: typeof raw.recentLimit === "number" && raw.recentLimit > 0
      ? Math.floor(raw.recentLimit)
      : undefined,
    sessionModelStrategy: parseSessionModelStrategy(raw.sessionModelStrategy),
    debug: Boolean(raw.debug),
  };
}

// providerOverrideKeys / resolveProviderOverride live in provider-override.ts
// (re-exported above) to break the settings ↔ model-meta cycle.

// Re-export type for existing imports
export type { ModelMetaOverride };

/** Where a modelMeta edit is stored. */
export type ModelMetaScope =
  | { kind: "provider" }
  | { kind: "model"; modelId: string };

export type MutableOverrideEntry = {
  label?: string;
  fingerprint?: FingerprintPreset;
  headers?: Record<string, string>;
  modelMeta?: ModelMetaOverride;
  modelOverrides?: Record<string, ModelOverrideEntry>;
  compat?: ProviderWireCompat;
  /** Force Claude Code compat on/off (provider scope; written by Repair Recipe2). */
  claudeCodeCompat?: boolean;
  /** Force Gemini tool compat on/off (provider scope; written by Repair Recipe3). */
  geminiToolCompat?: boolean;
};

function validateModelMetaWrite(
  modelMeta: ModelMetaOverride,
): ConfigEditResult {
  if (typeof modelMeta.thinkingFormat === "string" && modelMeta.thinkingFormat.trim()) {
    const fmt = modelMeta.thinkingFormat.trim();
    if (!isThinkingFormat(fmt)) {
      return {
        ok: false,
        error: `invalid thinkingFormat: ${fmt} (allowed: openai|openrouter|together|deepseek|zai|qwen|chat-template|qwen-chat-template|string-thinking|ant-ling)`,
      };
    }
  }
  if (modelMeta.thinkingLevelMap !== undefined) {
    if (
      !modelMeta.thinkingLevelMap ||
      typeof modelMeta.thinkingLevelMap !== "object" ||
      Array.isArray(modelMeta.thinkingLevelMap)
    ) {
      return { ok: false, error: "invalid thinkingLevelMap: expected object" };
    }
    for (const [key, value] of Object.entries(modelMeta.thinkingLevelMap)) {
      if (!isThinkingLevel(key)) {
        return {
          ok: false,
          error: `invalid thinkingLevelMap key: ${key} (allowed: ${THINKING_LEVELS.join("|")})`,
        };
      }
      if (value === null) continue;
      if (typeof value !== "string" || !value.trim()) {
        return {
          ok: false,
          error: `invalid thinkingLevelMap value for ${key}: expected non-empty string or null`,
        };
      }
    }
  }
  if (
    modelMeta.supportsDeveloperRole !== undefined &&
    typeof modelMeta.supportsDeveloperRole !== "boolean"
  ) {
    return {
      ok: false,
      error: "invalid supportsDeveloperRole: expected boolean",
    };
  }
  if (
    modelMeta.requiresReasoningContentOnAssistantMessages !== undefined &&
    typeof modelMeta.requiresReasoningContentOnAssistantMessages !== "boolean"
  ) {
    return {
      ok: false,
      error: "invalid requiresReasoningContentOnAssistantMessages: expected boolean",
    };
  }
  if (
    modelMeta.useBuiltInCompat !== undefined &&
    typeof modelMeta.useBuiltInCompat !== "boolean"
  ) {
    return {
      ok: false,
      error: "invalid useBuiltInCompat: expected boolean",
    };
  }
  return { ok: true };
}

/** Persist or clear one validated exact-model reasoning profile definition. */
export function writeExactModelReasoningProfile(
  target: ConfigWriteTarget,
  provider: Pick<CcProvider, "id" | "displayName"> & { appType?: string },
  modelId: string,
  profile: UserReasoningProfileOverride | null,
): ConfigEditResult {
  const id = modelId.trim();
  if (!id || id.includes("*")) {
    return {
      ok: false,
      error: "reasoning profile requires a non-empty exact model id",
    };
  }
  let normalized: UserReasoningProfileOverride | undefined;
  if (profile) {
    try {
      normalized = normalizeUserReasoningProfileOverride(profile);
    } catch (error) {
      return configEditError(
        `invalid reasoning profile: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return editConfig(target, (raw) =>
    updateOverrideEntry(raw, provider, (entry) => {
      const prev = { ...entry };
      const map = { ...(prev.modelOverrides ?? {}) };
      const match = matchExactModelOverrideEntry(map, id);
      const key = match?.key ?? id;
      const existing = { ...(match?.entry ?? {}) };
      if (normalized) existing.reasoningProfile = normalized;
      else delete existing.reasoningProfile;
      if (Object.keys(existing).length) map[key] = existing;
      else delete map[key];
      if (Object.keys(map).length) prev.modelOverrides = map;
      else delete prev.modelOverrides;
      if (normalized) prev.label = prev.label ?? provider.displayName;
      return prev;
    }),
  );
}

/** An override entry is only worth keeping when it carries real config. */
export function entryIsEmpty(entry: MutableOverrideEntry): boolean {
  const modelCount = entry.modelOverrides ? Object.keys(entry.modelOverrides).length : 0;
  return (
    !entry.modelMeta &&
    !entry.headers &&
    !entry.fingerprint &&
    !entry.compat &&
    !entry.claudeCodeCompat &&
    !entry.geminiToolCompat &&
    modelCount === 0
  );
}

/**
 * Return a new raw document with the override entry updated, so
 * resolveProviderOverride reads the edited values.
 *
 * Immutable: `raw` is never mutated; a shallow copy carrying the updated
 * `providerOverrides` is returned.
 *
 * With appType, the canonical slot is nested [appType][id]; a shadowed
 * top-level [id] entry (left by the old flat write path) is absorbed into
 * the nested slot first — nested values win per key — so edits are never
 * written somewhere the resolver ignores. Without appType, the legacy
 * top-level slot is used as before.
 */
export function updateOverrideEntry(
  raw: Record<string, unknown>,
  provider: Pick<CcProvider, "id" | "displayName"> & { appType?: string },
  mutate: (prev: MutableOverrideEntry) => MutableOverrideEntry,
): Record<string, unknown> {
  const overrides = isPlainObject(raw.providerOverrides)
    ? { ...(raw.providerOverrides as Record<string, unknown>) }
    : {};
  const appType = provider.appType?.trim();

  if (!appType) {
    const prev = (isPlainObject(overrides[provider.id])
      ? { ...(overrides[provider.id] as object) }
      : {}) as MutableOverrideEntry;
    const next = mutate(prev);
    if (entryIsEmpty(next)) delete overrides[provider.id];
    else overrides[provider.id] = next;
    return { ...raw, providerOverrides: overrides };
  }

  const group = isPlainObject(overrides[appType])
    ? { ...(overrides[appType] as Record<string, unknown>) }
    : {};
  let prev = (isPlainObject(group[provider.id])
    ? { ...(group[provider.id] as object) }
    : {}) as MutableOverrideEntry;

  const flat = overrides[provider.id];
  if (isPlainObject(flat)) {
    const flatEntry = flat as MutableOverrideEntry;
    const mergedModels = {
      ...(flatEntry.modelOverrides ?? {}),
      ...(prev.modelOverrides ?? {}),
    };
    prev = { ...flatEntry, ...prev };
    if (Object.keys(mergedModels).length) prev.modelOverrides = mergedModels;
    else delete prev.modelOverrides;
    delete overrides[provider.id];
  }

  const next = mutate(prev);
  if (entryIsEmpty(next)) delete group[provider.id];
  else group[provider.id] = next;
  if (Object.keys(group).length) overrides[appType] = group;
  else delete overrides[appType];
  return { ...raw, providerOverrides: overrides };
}

/**
 * Persist modelMeta for a provider (provider scope) or one model id
 * (model scope) under the canonical dbId key.
 *
 * Pass modelMeta=null to clear that scope only. Provider-scope clear keeps
 * per-model overrides; use clearAllModelMetaOverrides to wipe both.
 */
export function writeModelMetaOverride(
  target: ConfigWriteTarget,
  provider: Pick<CcProvider, "id" | "displayName"> & { appType?: string },
  scope: ModelMetaScope,
  modelMeta: ModelMetaOverride | null,
): ConfigEditResult {
  if (modelMeta) {
    const valid = validateModelMetaWrite(modelMeta);
    if (!valid.ok) return valid;
  }
  if (scope.kind === "model" && !scope.modelId.trim()) {
    return { ok: false, error: "empty model id" };
  }
  return editConfig(target, (raw) =>
    updateOverrideEntry(raw, provider, (entry) => {
      const prev = { ...entry };
      if (scope.kind === "provider") {
        const cleaned = modelMeta ? cleanModelMeta(modelMeta) : undefined;
        if (!cleaned) delete prev.modelMeta;
        else prev.modelMeta = cleaned;
      } else {
        const modelId = scope.modelId.trim();
        const map = { ...(prev.modelOverrides ?? {}) };
        const match = matchExactModelOverrideEntry(map, modelId);
        const key = match?.key ?? modelId;
        const cleaned = modelMeta ? cleanModelMeta(modelMeta) : undefined;
        const next: ModelOverrideEntry = {};
        if (match?.entry.compat) next.compat = match.entry.compat;
        if (match?.entry.reasoningProfile) {
          next.reasoningProfile = match.entry.reasoningProfile;
        }
        if (cleaned) Object.assign(next, cleaned);
        if (Object.keys(next).length) map[key] = next;
        else delete map[key];
        if (Object.keys(map).length) prev.modelOverrides = map;
        else delete prev.modelOverrides;
      }
      if (modelMeta) prev.label = prev.label ?? provider.displayName;
      return prev;
    }),
  );
}

/**
 * Persist the reviewed lossy max -> ultra opt-in. The ordinary writer remains
 * permissive for legacy raw maps; this path requires fresh tuple/profile
 * authority and is the only path used by the UI-generated opt-in.
 */
export function writeExactModelThinkingOptIn(
  target: ConfigWriteTarget,
  provider: Pick<
    CcProvider,
    "id" | "displayName" | "appType" | "api" | "baseUrl"
  >,
  scope: ModelMetaScope,
  modelMeta: ModelMetaOverride,
  decision: ThinkingProjectionDecision | undefined,
  request: ExactModelThinkingOptInRequest,
): ConfigEditResult {
  if (!provider.appType || !provider.api || !provider.baseUrl || !decision) {
    return { ok: false, error: "thinking opt-in requires a complete provider tuple" };
  }
  let tupleKey: string;
  try {
    tupleKey = providerEndpointTupleKey({
      appType: provider.appType,
      providerId: provider.id,
      api: provider.api,
      baseUrl: provider.baseUrl,
      modelId: scope.kind === "model" ? scope.modelId : decision.tuple.modelId,
    });
  } catch (error) {
    return {
      ok: false,
      error: `invalid thinking opt-in tuple: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (tupleKey !== decision.tupleKey) {
    return { ok: false, error: "thinking decision does not match the provider tuple" };
  }
  const applied = applyExactModelThinkingOptIn(
    modelMeta,
    scope,
    decision,
    request,
  );
  if (!applied.ok) return applied;
  return writeModelMetaOverride(
    target,
    provider,
    scope,
    applied.modelMeta,
  );
}

/** Persist or clear Provider-scoped request-wire compatibility. */
export function writeProviderWireCompat(
  target: ConfigWriteTarget,
  provider: Pick<CcProvider, "id" | "displayName" | "api"> & {
    appType?: string;
  },
  compat: ProviderWireCompat | null,
): ConfigEditResult {
  let parsed: ProviderWireCompat | undefined;
  try {
    parsed = compat
      ? parseProviderWireCompat(compat, "provider compat")
      : undefined;
  } catch (error) {
    return configEditError(error);
  }
  if (parsed && parsed.api !== provider.api) {
    return {
      ok: false,
      error: `provider compat api ${parsed.api} does not match provider api ${provider.api ?? "unsupported"}`,
    };
  }
  return editConfig(target, (raw) =>
    updateOverrideEntry(raw, provider, (entry) => {
      const next = { ...entry };
      if (parsed) {
        next.compat = parsed;
        next.label = next.label ?? provider.displayName;
      } else {
        delete next.compat;
      }
      return next;
    }),
  );
}

/** Drop provider-scope modelMeta and every per-model override for a provider. */
export function clearAllModelMetaOverrides(
  target: ConfigWriteTarget,
  provider: Pick<CcProvider, "id" | "displayName"> & { appType?: string },
): ConfigEditResult {
  return editConfig(target, (raw) =>
    updateOverrideEntry(raw, provider, (entry) => {
      const prev = { ...entry };
      delete prev.modelMeta;
      delete prev.modelOverrides;
      return prev;
    }),
  );
}

/** Back-compat wrapper: provider-scope write. */
export function writeProviderModelMeta(
  target: ConfigWriteTarget,
  provider: Pick<CcProvider, "id" | "displayName">,
  modelMeta: ModelMetaOverride | null,
): ConfigEditResult {
  return writeModelMetaOverride(target, provider, { kind: "provider" }, modelMeta);
}

export function writeModelTupleCompat(
  target: ConfigWriteTarget,
  provider: Pick<CcProvider, "id" | "displayName" | "api"> & { appType?: string },
  modelId: string,
  compat: ModelTupleCompat | null,
): ConfigEditResult {
  const id = modelId.trim();
  if (!id) return { ok: false, error: "empty model id" };
  let parsed: ModelTupleCompat | undefined;
  try {
    parsed = compat
      ? parseModelTupleCompat(compat, "model tuple compat")
      : undefined;
  } catch (error) {
    return configEditError(error);
  }
  if (parsed && provider.api && provider.api !== parsed.api) {
    return {
      ok: false,
      error: `tuple compat api ${parsed.api} does not match provider api ${provider.api}`,
    };
  }
  return editConfig(target, (raw) =>
    updateOverrideEntry(raw, provider, (entry) => {
      const prev = { ...entry };
      const map = { ...(prev.modelOverrides ?? {}) };
      const key = matchExactModelOverride(map, id)?.key ?? id;
      const existing = { ...(map[key] ?? {}) } as ModelOverrideEntry;
      if (parsed) {
        existing.compat = parsed;
        map[key] = existing;
        prev.label = prev.label ?? provider.displayName;
      } else {
        delete existing.compat;
        const remaining = cleanModelMeta(existing);
        if (remaining && Object.keys(remaining).length) {
          map[key] = { ...remaining } as ModelOverrideEntry;
        } else if (Object.keys(existing).length === 0 || !cleanModelMeta(existing)) {
          // Only compat was present — drop the entry entirely when empty.
          const stripped = { ...existing };
          delete stripped.compat;
          if (Object.keys(stripped).length === 0) delete map[key];
          else map[key] = stripped as ModelOverrideEntry;
        } else {
          map[key] = existing;
        }
      }
      if (Object.keys(map).length) prev.modelOverrides = map;
      else delete prev.modelOverrides;
      return prev;
    }),
  );
}

/** @deprecated Use writeModelTupleCompat (Chat #64 / Anthropic #67). */
export const writeChatTupleCompat = writeModelTupleCompat;

