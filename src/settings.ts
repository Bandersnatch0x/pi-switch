import type {
  FingerprintPreset,
  ModelMetaOverride,
  PinEntry,
  PiSwitchConfig,
  PiSwitchSelection,
  RecentEntry,
} from "./types.ts";
import {
  DEFAULT_RECENT_LIMIT,
  isThinkingFormat,
  LEGACY_SETTINGS_KEY,
  SETTINGS_KEY,
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
  readJsonObjectLenient,
  updateJsonObjectAtomic,
  type FsLike,
} from "./json-file.ts";

export { providerOverrideKeys, resolveProviderOverride };
export type { ProviderOverrideEntry };
export type { FsLike } from "./json-file.ts";

export function piSettingsPath(home: string): string {
  return `${home.replace(/[\\/]+$/, "")}/.pi/agent/settings.json`;
}

export function piSwitchConfigPath(home: string): string {
  return `${home.replace(/[\\/]+$/, "")}/.pi/agent/pi-switch.json`;
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
    out.push({ dbId, model, label });
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
    out.push({ dbId, model, at });
  }
  return out;
}

export function readPiSwitchConfig(fs: FsLike, path: string): PiSwitchConfig {
  const raw = readJsonFile(fs, path);
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
    providerOverrides:
      raw.providerOverrides && typeof raw.providerOverrides === "object"
        ? (raw.providerOverrides as PiSwitchConfig["providerOverrides"])
        : undefined,
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

type MutableOverrideEntry = {
  label?: string;
  fingerprint?: FingerprintPreset;
  headers?: Record<string, string>;
  modelMeta?: ModelMetaOverride;
  modelOverrides?: Record<string, ModelMetaOverride>;
};

function validateThinkingFormat(
  modelMeta: ModelMetaOverride,
): { ok: true } | { ok: false; error: string } {
  if (typeof modelMeta.thinkingFormat === "string" && modelMeta.thinkingFormat.trim()) {
    const fmt = modelMeta.thinkingFormat.trim();
    if (!isThinkingFormat(fmt)) {
      return {
        ok: false,
        error: `invalid thinkingFormat: ${fmt} (allowed: openai|openrouter|together|deepseek|zai|qwen|chat-template|qwen-chat-template|string-thinking|ant-ling)`,
      };
    }
  }
  return { ok: true };
}

/** An override entry is only worth keeping when it carries real config. */
function entryIsEmpty(entry: MutableOverrideEntry): boolean {
  const modelCount = entry.modelOverrides ? Object.keys(entry.modelOverrides).length : 0;
  return !entry.modelMeta && !entry.headers && !entry.fingerprint && modelCount === 0;
}

/**
 * Persist modelMeta for a provider (provider scope) or one model id
 * (model scope) under the canonical dbId key.
 *
 * Pass modelMeta=null to clear that scope only. Provider-scope clear keeps
 * per-model overrides; use clearAllModelMetaOverrides to wipe both.
 */
export function writeModelMetaOverride(
  fs: FsLike,
  configPath: string,
  provider: Pick<CcProvider, "id" | "displayName">,
  scope: ModelMetaScope,
  modelMeta: ModelMetaOverride | null,
  pid: number,
): { ok: boolean; error?: string } {
  try {
    if (modelMeta) {
      const valid = validateThinkingFormat(modelMeta);
      if (!valid.ok) return valid;
    }

    if (scope.kind === "model" && !scope.modelId.trim()) {
      return { ok: false, error: "empty model id" };
    }
    updateJsonObjectAtomic(fs, configPath, pid, (raw) => {
      const overrides =
        raw.providerOverrides && typeof raw.providerOverrides === "object" && !Array.isArray(raw.providerOverrides)
          ? { ...(raw.providerOverrides as Record<string, ProviderOverrideEntry>) }
          : {};
      const prev = (overrides[provider.id] && typeof overrides[provider.id] === "object"
        ? { ...overrides[provider.id] }
        : {}) as MutableOverrideEntry;

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
      if (entryIsEmpty(prev)) delete overrides[provider.id];
      else overrides[provider.id] = prev;

      return {
        document: { ...raw, providerOverrides: overrides },
        result: undefined,
      };
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Drop provider-scope modelMeta and every per-model override for a provider. */
export function clearAllModelMetaOverrides(
  fs: FsLike,
  configPath: string,
  provider: Pick<CcProvider, "id" | "displayName">,
  pid: number,
): { ok: boolean; error?: string } {
  try {
    updateJsonObjectAtomic(fs, configPath, pid, (raw) => {
      const overrides =
        raw.providerOverrides && typeof raw.providerOverrides === "object" && !Array.isArray(raw.providerOverrides)
          ? { ...(raw.providerOverrides as Record<string, ProviderOverrideEntry>) }
          : {};
      const prev = (overrides[provider.id] && typeof overrides[provider.id] === "object"
        ? { ...overrides[provider.id] }
        : {}) as MutableOverrideEntry;
      delete prev.modelMeta;
      delete prev.modelOverrides;
      if (entryIsEmpty(prev)) delete overrides[provider.id];
      else overrides[provider.id] = prev;
      return {
        document: { ...raw, providerOverrides: overrides },
        result: undefined,
      };
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Back-compat wrapper: provider-scope write. */
export function writeProviderModelMeta(
  fs: FsLike,
  configPath: string,
  provider: Pick<CcProvider, "id" | "displayName">,
  modelMeta: ModelMetaOverride | null,
  pid: number,
): { ok: boolean; error?: string } {
  return writeModelMetaOverride(fs, configPath, provider, { kind: "provider" }, modelMeta, pid);
}

export function pinKey(dbId: string, model: string): string {
  return `${dbId}::${model.trim()}`;
}

export function isPinned(pins: PinEntry[] | undefined, dbId: string, model: string): boolean {
  const key = pinKey(dbId, model);
  return (pins ?? []).some((p) => pinKey(p.dbId, p.model) === key);
}

/** Toggle a pin entry. Returns the new pins array. */
export function togglePinEntry(
  pins: PinEntry[] | undefined,
  entry: PinEntry,
): { pins: PinEntry[]; pinned: boolean } {
  const list = [...(pins ?? [])];
  const key = pinKey(entry.dbId, entry.model);
  const idx = list.findIndex((p) => pinKey(p.dbId, p.model) === key);
  if (idx >= 0) {
    list.splice(idx, 1);
    return { pins: list, pinned: false };
  }
  list.unshift({
    dbId: entry.dbId,
    model: entry.model.trim(),
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
    at: entry.at ?? Date.now(),
  };
  const key = pinKey(next.dbId, next.model);
  const filtered = (recent ?? []).filter((r) => pinKey(r.dbId, r.model) !== key);
  return [next, ...filtered].slice(0, Math.max(1, limit));
}

/** Persist pins array (full replace). */
export function writePins(
  fs: FsLike,
  configPath: string,
  pins: PinEntry[],
  pid: number,
): { ok: boolean; error?: string } {
  try {
    updateJsonObjectAtomic(fs, configPath, pid, (raw) => ({
      document: { ...raw, pins },
      result: undefined,
    }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Persist recent array (full replace). */
export function writeRecent(
  fs: FsLike,
  configPath: string,
  recent: RecentEntry[],
  pid: number,
): { ok: boolean; error?: string } {
  try {
    updateJsonObjectAtomic(fs, configPath, pid, (raw) => ({
      document: { ...raw, recent },
      result: undefined,
    }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function togglePinAndWrite(
  fs: FsLike,
  configPath: string,
  entry: PinEntry,
  pid: number,
): { ok: boolean; error?: string; pins: PinEntry[]; pinned: boolean } {
  try {
    const next = updateJsonObjectAtomic(fs, configPath, pid, (raw) => {
      const toggled = togglePinEntry(parsePins(raw.pins), entry);
      return {
        document: { ...raw, pins: toggled.pins },
        result: toggled,
      };
    });
    return { ok: true, ...next };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      pins: [],
      pinned: false,
    };
  }
}

export function recordRecentAndWrite(
  fs: FsLike,
  configPath: string,
  entry: Omit<RecentEntry, "at"> & { at?: number },
  pid: number,
): { ok: boolean; error?: string; recent: RecentEntry[] } {
  try {
    const recent = updateJsonObjectAtomic(fs, configPath, pid, (raw) => {
      const config = readPiSwitchConfig({
        ...fs,
        existsSync: (path) => path === configPath || fs.existsSync(path),
        readFileSync: (path, encoding) =>
          path === configPath ? JSON.stringify(raw) : fs.readFileSync(path, encoding),
      }, configPath);
      const next = pushRecentEntry(config.recent, entry, config.recentLimit);
      return {
        document: { ...raw, recent: next },
        result: next,
      };
    });
    return { ok: true, recent };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      recent: [],
    };
  }
}
