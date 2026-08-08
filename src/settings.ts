import type {
  FingerprintPreset,
  ModelMetaOverride,
  ModelOverrideEntry,
  PinEntry,
  PiSwitchConfig,
  PiSwitchSelection,
  RecentEntry,
} from "./types.ts";
import {
  DEFAULT_RECENT_LIMIT,
  isThinkingFormat,
  isThinkingLevel,
  LEGACY_SETTINGS_KEY,
  SETTINGS_KEY,
  THINKING_LEVELS,
} from "./types.ts";
import type { CcProvider } from "./types.ts";
import { cleanModelMeta, matchExactModelOverride } from "./model-meta.ts";
import {
  providerOverrideKeys,
  resolveProviderOverride,
  type ProviderOverrideEntry,
} from "./provider-override.ts";
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
  updateJsonObjectAtomic,
  type FsLike,
} from "./json-file.ts";
import {
  configEditError,
  editConfig,
  editConfigWithResult,
  type ConfigEditResult,
  type ConfigWriteTarget,
} from "./config-edit.ts";

export { providerOverrideKeys, resolveProviderOverride };
export type { ProviderOverrideEntry };
export type { FsLike };
export type { ConfigEditResult, ConfigWriteTarget };
export {
  configEditError,
  editConfig,
  editConfigWithResult,
} from "./config-edit.ts";

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

export function piSettingsPath(home: string): string {
  return `${home.replace(/[\\/]+$/, "")}/.pi/agent/settings.json`;
}

export function piSwitchConfigPath(home: string): string {
  return `${home.replace(/[\\/]+$/, "")}/.pi/agent/pi-switch.json`;
}

/** W4 capability-facts cache (provenance + fetchedAt; drop to roll back). */
export function piSwitchCachePath(home: string): string {
  return `${home.replace(/[\\/]+$/, "")}/.pi/agent/pi-switch-cache.json`;
}

export function providerHeadersPath(home: string): string {
  return `${home.replace(/[\\/]+$/, "")}/.pi/agent/provider-headers.json`;
}

export function readJsonFile(fs: FsLike, path: string): Record<string, unknown> {
  return readJsonObjectLenient(fs, path);
}

export function writeJsonAtomic(
  fs: FsLike,
  path: string,
  data: Record<string, unknown>,
  pid: number,
): void {
  updateJsonObjectAtomic(fs, path, pid, () => ({
    document: data,
    result: undefined,
  }));
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
  try {
    updateJsonObjectAtomic(fs, settingsPath, pid, (settings) => ({
      document: {
        ...settings,
        [SETTINGS_KEY]: {
          dbId: sel.dbId,
          model: sel.model.trim(),
          tab: sel.tab,
          appType: sel.appType,
          provider: sel.provider,
        },
      },
      result: undefined,
    }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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

function parsePins(raw: unknown): PinEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PinEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const dbId = typeof rec.dbId === "string" ? rec.dbId.trim() : "";
    const model = typeof rec.model === "string" ? rec.model.trim() : "";
    if (!dbId || !model) continue;
    const label =
      typeof rec.label === "string" && rec.label.trim() ? rec.label.trim() : undefined;
    const appType =
      typeof rec.appType === "string" && rec.appType.trim() ? rec.appType.trim() : undefined;
    out.push({ dbId, model, appType, label });
  }
  return out;
}

function parseRecent(raw: unknown): RecentEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: RecentEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const dbId = typeof rec.dbId === "string" ? rec.dbId.trim() : "";
    const model = typeof rec.model === "string" ? rec.model.trim() : "";
    const at =
      typeof rec.at === "number" && Number.isFinite(rec.at) ? Math.floor(rec.at) : 0;
    if (!dbId || !model) continue;
    const appType =
      typeof rec.appType === "string" && rec.appType.trim() ? rec.appType.trim() : undefined;
    out.push({ dbId, model, appType, at });
  }
  return out;
}

const PROVIDER_OVERRIDE_ENTRY_KEYS = new Set([
  "label",
  "fingerprint",
  "headers",
  "modelMeta",
  "modelOverrides",
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
): ModelOverrideEntry {
  const meta = parseModelMeta(raw) ?? {};
  const entry: ModelOverrideEntry = { ...meta };
  if (hasOwn(raw, "compat")) {
    entry.compat = parseModelTupleCompat(raw.compat, `${path}.compat`);
  }
  return entry;
}

function parseProviderOverrideEntry(
  raw: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  // modelMeta must not host wire/tuple compat.
  rejectNestedWireCompat(raw.modelMeta, `${path}.modelMeta`);

  const next = { ...raw };
  if (isPlainObject(raw.modelOverrides)) {
    const models: Record<string, ModelOverrideEntry> = {};
    for (const [modelId, modelRaw] of Object.entries(raw.modelOverrides)) {
      if (!isPlainObject(modelRaw)) continue;
      models[modelId] = parseModelOverrideEntry(
        modelRaw,
        `${path}.modelOverrides.${modelId}`,
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

export function readPiSwitchConfig(fs: FsLike, path: string): PiSwitchConfig {
  const raw = readJsonFile(fs, path);
  if (hasOwn(raw, "compat")) {
    throw new Error(
      "invalid compat scope: Provider wire compat belongs under providerOverrides.<provider>.compat",
    );
  }
  rejectNestedWireCompat(raw.defaultModelMeta, "defaultModelMeta");
  const varsRaw =
    raw.vars && typeof raw.vars === "object" && !Array.isArray(raw.vars)
      ? (raw.vars as Record<string, unknown>)
      : undefined;
  return {
    tabs: Array.isArray(raw.tabs) ? raw.tabs.filter((t): t is string => typeof t === "string") : undefined,
    aliasCcs: typeof raw.aliasCcs === "boolean" ? raw.aliasCcs : undefined,
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
  modelOverrides?: Record<string, ModelMetaOverride>;
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
        const key = matchExactModelOverride(map, modelId)?.key ?? modelId;
        const cleaned = modelMeta ? cleanModelMeta(modelMeta) : undefined;
        if (!cleaned) delete map[key];
        else map[key] = cleaned;
        if (Object.keys(map).length) prev.modelOverrides = map;
        else delete prev.modelOverrides;
      }
      if (modelMeta) prev.label = prev.label ?? provider.displayName;
      return prev;
    }),
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

/** Legacy pin key (pre-identity-migration); still used for back-compat matching. */
export function pinKey(dbId: string, model: string): string {
  return `${dbId}::${model.trim()}`;
}

/** Identity-aware pin key (issue #16): appType::dbId::model. */
export function entryKey(p: { dbId: string; model: string; appType?: string }): string {
  return p.appType ? `${p.appType}::${p.dbId}::${p.model.trim()}` : pinKey(p.dbId, p.model);
}

/**
 * Same provider+model identity. An appType-carrying probe also claims
 * appType-less legacy entries (pre-migration / appType-stripping bug); a
 * legacy probe never claims an appType-carrying entry (can't disambiguate).
 */
function sameEntry(
  stored: { dbId: string; model: string; appType?: string },
  probe: { dbId: string; model: string; appType?: string },
): boolean {
  if (stored.dbId !== probe.dbId) return false;
  if (stored.model.trim() !== probe.model.trim()) return false;
  return stored.appType === probe.appType || (!stored.appType && Boolean(probe.appType));
}

export function isPinned(
  pins: PinEntry[] | undefined,
  dbId: string,
  model: string,
  appType?: string,
): boolean {
  return (pins ?? []).some((p) => sameEntry(p, { dbId, model, appType }));
}

/** Toggle a pin entry. Returns the new pins array. */
export function togglePinEntry(
  pins: PinEntry[] | undefined,
  entry: PinEntry,
): { pins: PinEntry[]; pinned: boolean } {
  const list = [...(pins ?? [])];
  // Unpin removes every match, healing duplicates accumulated by the old
  // appType-stripping read path.
  const kept = list.filter((p) => !sameEntry(p, entry));
  if (kept.length !== list.length) {
    return { pins: kept, pinned: false };
  }
  list.unshift({
    dbId: entry.dbId,
    model: entry.model.trim(),
    appType: entry.appType,
    label: entry.label,
  });
  return { pins: list, pinned: true };
}

export function pushRecentEntry(
  recent: RecentEntry[] | undefined,
  entry: Omit<RecentEntry, "at"> & { at?: number },
  limit = DEFAULT_RECENT_LIMIT,
): RecentEntry[] {
  const next: RecentEntry = {
    dbId: entry.dbId,
    model: entry.model.trim(),
    appType: entry.appType,
    at: entry.at ?? Date.now(),
  };
  const filtered = (recent ?? []).filter((r) => !sameEntry(r, next));
  return [next, ...filtered].slice(0, Math.max(1, limit));
}

/** Persist pins array (full replace). */
export function writePins(
  fs: FsLike,
  configPath: string,
  pins: PinEntry[],
  pid: number,
): ConfigEditResult {
  return editConfig({ fs, configPath, pid }, (raw) => ({ ...raw, pins }));
}

/** Persist recent array (full replace). */
export function writeRecent(
  fs: FsLike,
  configPath: string,
  recent: RecentEntry[],
  pid: number,
): ConfigEditResult {
  return editConfig({ fs, configPath, pid }, (raw) => ({ ...raw, recent }));
}

export type TogglePinWriteResult =
  | { ok: true; pins: PinEntry[]; pinned: boolean }
  | { ok: false; error: string; pins: PinEntry[]; pinned: boolean };

export type RecordRecentWriteResult =
  | { ok: true; recent: RecentEntry[] }
  | { ok: false; error: string; recent: RecentEntry[] };

export function togglePinAndWrite(
  fs: FsLike,
  configPath: string,
  entry: PinEntry,
  pid: number,
): TogglePinWriteResult {
  const edited = editConfigWithResult({ fs, configPath, pid }, (raw) => {
    const toggled = togglePinEntry(parsePins(raw.pins), entry);
    return {
      document: { ...raw, pins: toggled.pins },
      result: toggled,
    };
  });
  if (!edited.ok) {
    return { ok: false, error: edited.error, pins: [], pinned: false };
  }
  return { ok: true, ...edited.result };
}

export function recordRecentAndWrite(
  fs: FsLike,
  configPath: string,
  entry: Omit<RecentEntry, "at"> & { at?: number },
  pid: number,
): RecordRecentWriteResult {
  const edited = editConfigWithResult({ fs, configPath, pid }, (raw) => {
    const config = readPiSwitchConfig(
      {
        ...fs,
        existsSync: (path) => path === configPath || fs.existsSync(path),
        readFileSync: (path, encoding) =>
          path === configPath
            ? JSON.stringify(raw)
            : fs.readFileSync(path, encoding),
      },
      configPath,
    );
    const next = pushRecentEntry(config.recent, entry, config.recentLimit);
    return {
      document: { ...raw, recent: next },
      result: next,
    };
  });
  if (!edited.ok) {
    return { ok: false, error: edited.error, recent: [] };
  }
  return { ok: true, recent: edited.result };
}
