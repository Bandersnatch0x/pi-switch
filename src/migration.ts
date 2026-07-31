/**
 * One-shot provider-identity migration (issue #16).
 *
 * Canonical ProviderRef is { appType, id } (CC Switch 3.19 composite key).
 * Selection, pins, recent and providerOverrides previously keyed by dbId
 * alone are migrated to the composite identity, one-shot and idempotent:
 *
 * - hit 0  -> kept as-is, counted stale (no silent drop)
 * - hit 1  -> appType filled / override key moved into the nested [appType][id]
 * - hit >1 -> kept as-is, counted ambiguous (never guess)
 *
 * Backups are written before any change; the piSwitchMigration marker on both
 * files prevents re-migration. All writes go through the CAS atomic writer.
 */

import type {
  CcProvider,
  PiSwitchMigrationMarker,
  PiSwitchSelection,
  PinEntry,
  RecentEntry,
} from "./types.ts";
import { SETTINGS_KEY } from "./types.ts";
import { readJsonObjectLenient, updateJsonObjectAtomic, type FsLike } from "./json-file.ts";

export interface IdentityMigrationSummary {
  migrated: number;
  stale: number;
  ambiguous: number;
  skipped?: string;
}

export interface MigrationInput {
  fs: FsLike;
  settingsPath: string;
  configPath: string;
  providers: CcProvider[];
  pid: number;
  now?: number;
}

const MIGRATION_VERSION = 1;

function marker(now: number): PiSwitchMigrationMarker {
  return { version: MIGRATION_VERSION, migratedAt: new Date(now).toISOString() };
}

function hasMigrated(doc: Record<string, unknown>): boolean {
  const m = doc.piSwitchMigration as PiSwitchMigrationMarker | undefined;
  return typeof m?.version === "number" && m.version >= MIGRATION_VERSION;
}

function backup(fs: FsLike, path: string, ts: number): string | undefined {
  try {
    const data = fs.readFileSync(path, "utf8");
    const bakPath = `${path}.bak-${ts}`;
    fs.writeFileSync(bakPath, data, "utf8");
    return bakPath;
  } catch {
    return undefined; // file absent or unreadable — nothing to back up
  }
}

function hits(providers: CcProvider[], dbId: string): CcProvider[] {
  return providers.filter((p) => p.id === dbId);
}

/** Migrate one selection/pin/recent entry; returns the filled appType or null. */
function resolveAppType(
  providers: CcProvider[],
  dbId: string,
  summary: IdentityMigrationSummary,
): string | null | undefined {
  const found = hits(providers, dbId);
  if (found.length === 1) {
    summary.migrated += 1;
    return found[0].appType;
  }
  if (found.length > 1) {
    summary.ambiguous += 1;
    return null; // keep as-is, never guess
  }
  summary.stale += 1;
  return null;
}

/**
 * Migrate selection (settings.json) + pins/recent/providerOverrides
 * (pi-switch.json) to composite { appType, id } identity.
 */
export function migrateIdentityState(input: MigrationInput): IdentityMigrationSummary {
  const { fs, settingsPath, configPath, providers, pid } = input;
  const now = input.now ?? Date.now();
  const summary: IdentityMigrationSummary = { migrated: 0, stale: 0, ambiguous: 0 };

  // Never migrate without a usable provider snapshot (DB down -> everything
  // would look stale).
  if (!providers.length) {
    summary.skipped = "no-provider-snapshot";
    return summary;
  }

  const settings = readJsonObjectLenient(fs, settingsPath);
  const config = readJsonObjectLenient(fs, configPath);
  if (hasMigrated(settings) || hasMigrated(config)) {
    summary.skipped = "already-migrated";
    return summary;
  }

  // Pre-migration backups (rollback = restore these files).
  backup(fs, settingsPath, now);
  backup(fs, configPath, now);

  const sel = settings[SETTINGS_KEY] as PiSwitchSelection | undefined;
  if (sel?.dbId && sel.model && !sel.appType) {
    const appType = resolveAppType(providers, sel.dbId, summary);
    if (appType) {
      settings[SETTINGS_KEY] = { ...sel, appType };
    } else if (appType === null) {
      // ambiguous or stale: leave untouched, counts already bumped
    }
  }

  // pins / recent: fill appType when uniquely resolvable.
  const pins = (config.pins as PinEntry[] | undefined) ?? [];
  const nextPins: PinEntry[] = [];
  for (const p of pins) {
    if (p.appType || !p.dbId) {
      nextPins.push(p);
      continue;
    }
    const appType = resolveAppType(providers, p.dbId, summary);
    nextPins.push(appType ? { ...p, appType } : p);
  }
  config.pins = nextPins;

  const recent = (config.recent as RecentEntry[] | undefined) ?? [];
  const nextRecent: RecentEntry[] = [];
  for (const r of recent) {
    if (r.appType || !r.dbId) {
      nextRecent.push(r);
      continue;
    }
    const appType = resolveAppType(providers, r.dbId, summary);
    nextRecent.push(appType ? { ...r, appType } : r);
  }
  config.recent = nextRecent;

  // providerOverrides: move uniquely-resolvable top-level dbId keys into the
  // nested [appType][id] shape. Ambiguous/stale keys stay put.
  const overrides = (config.providerOverrides as Record<string, unknown> | undefined) ?? {};
  const nextOverrides: Record<string, unknown> = {};
  const nested: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(overrides)) {
    const found = hits(providers, key);
    if (found.length === 1) {
      const { appType, id } = found[0];
      (nested[appType] ??= {})[id] = value;
      summary.migrated += 1;
    } else {
      if (found.length > 1) summary.ambiguous += 1;
      else summary.stale += 1;
      nextOverrides[key] = value; // keep top-level (ambiguous) or non-dbId key
    }
  }
  // Nested entries win over any same-key top-level leftovers.
  for (const [appType, entries] of Object.entries(nested)) {
    nextOverrides[appType] = { ...(nextOverrides[appType] as Record<string, unknown>), ...entries };
  }
  config.providerOverrides = nextOverrides;

  settings.piSwitchMigration = marker(now);
  config.piSwitchMigration = marker(now);

  // CAS writes; a conflict retry re-runs the updater against the latest
  // snapshot, and the migration is idempotent so re-running is safe.
  updateJsonObjectAtomic(fs, settingsPath, pid, () => ({
    document: settings,
    result: undefined,
  }));
  updateJsonObjectAtomic(fs, configPath, pid, () => ({
    document: config,
    result: undefined,
  }));

  return summary;
}
