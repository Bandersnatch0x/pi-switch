import type { PiSwitchConfig, PiSwitchSelection } from "./types.ts";
import { LEGACY_SETTINGS_KEY, SETTINGS_KEY } from "./types.ts";
import type { CcProvider } from "./types.ts";

export interface FsLike {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf8") => string;
  writeFileSync: (path: string, data: string, encoding: "utf8") => void;
  renameSync: (from: string, to: string) => void;
}

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
  try {
    if (!fs.existsSync(path)) return {};
    const v = JSON.parse(fs.readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function writeJsonAtomic(
  fs: FsLike,
  path: string,
  data: Record<string, unknown>,
  pid: number,
): void {
  const tmp = `${path}.tmp-${pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, path);
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
    const settings = readJsonFile(fs, settingsPath);
    settings[SETTINGS_KEY] = {
      dbId: sel.dbId,
      model: sel.model.trim(),
      tab: sel.tab,
      appType: sel.appType,
      provider: sel.provider,
    };
    writeJsonAtomic(fs, settingsPath, settings, pid);
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

export function readPiSwitchConfig(fs: FsLike, path: string): PiSwitchConfig {
  const raw = readJsonFile(fs, path);
  return {
    pageSize: typeof raw.pageSize === "number" ? raw.pageSize : undefined,
    tabs: Array.isArray(raw.tabs) ? raw.tabs.filter((t): t is string => typeof t === "string") : undefined,
    aliasCcs: typeof raw.aliasCcs === "boolean" ? raw.aliasCcs : undefined,
    sqlitePath: typeof raw.sqlitePath === "string" ? raw.sqlitePath : raw.sqlitePath === null ? null : undefined,
    providerOverrides:
      raw.providerOverrides && typeof raw.providerOverrides === "object"
        ? (raw.providerOverrides as PiSwitchConfig["providerOverrides"])
        : undefined,
    debug: Boolean(raw.debug),
  };
}
