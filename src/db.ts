import type { CcProvider, ProviderRow } from "./types.ts";
import { parseProviderRow, uniquifyPiNames } from "./parse/index.ts";

/**
 * Column-set capability probe for the cc-switch `providers` table (issue #9/#20).
 *
 * CC Switch migrations are additive (schema.rs: add_column_if_missing), so the
 * column set varies by version: legacy DBs expose `provider_type` while the
 * 3.19+ schema classifies via `category` and keys providers by composite
 * `(id, app_type)`. The SELECT is built from the probed column set so a fresh
 * install never fails on a column that does not exist.
 */

export interface DbCapabilities {
  /** Column names present on the providers table (probed). */
  columns: string[];
  hasCategory: boolean;
  hasProviderType: boolean;
  /** Primary key spans both id and app_type (3.19+ composite identity). */
  compositeId: boolean;
}

/** Columns required for pi-switch parsing; probe failures fall back to these. */
export const PROVIDERS_CORE_COLUMNS = [
  "id",
  "app_type",
  "name",
  "settings_config",
  "is_current",
  "website_url",
  "notes",
  "meta",
  "sort_index",
] as const;

/** Optional classification columns, included only when present. */
export const PROVIDERS_OPTIONAL_COLUMNS = ["provider_type", "category"] as const;

export function parseTableInfo(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];
  let rows: Array<{ name?: unknown; pk?: unknown }>;
  try {
    rows = JSON.parse(text) as Array<{ name?: unknown; pk?: unknown }>;
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => (typeof r?.name === "string" ? r.name : undefined))
    .filter((n): n is string => Boolean(n));
}

/** Detect composite (id, app_type) primary key from PRAGMA table_info output. */
export function hasCompositeId(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  let rows: Array<{ name?: unknown; pk?: unknown }>;
  try {
    rows = JSON.parse(text) as Array<{ name?: unknown; pk?: unknown }>;
  } catch {
    return false;
  }
  if (!Array.isArray(rows)) return false;
  const pkCols = rows.filter((r) => Number(r?.pk) > 0).map((r) => String(r?.name));
  return pkCols.includes("id") && pkCols.includes("app_type");
}

function probeCapabilities(deps: DbReaderDeps): DbCapabilities | undefined {
  try {
    const raw = deps.execFileSync(
      deps.sqlite3Path,
      ["-cmd", ".timeout 3000", "-readonly", "-json", deps.dbPath, "PRAGMA table_info(providers)"],
      { encoding: "utf8", timeout: deps.timeoutMs ?? 15_000, maxBuffer: deps.maxBuffer ?? 64 * 1024 * 1024 },
    );
    const columns = parseTableInfo(raw);
    return {
      columns,
      hasCategory: columns.includes("category"),
      hasProviderType: columns.includes("provider_type"),
      compositeId: hasCompositeId(raw),
    };
  } catch {
    return undefined;
  }
}

function buildProvidersSql(cap: DbCapabilities | undefined): string {
  const optional = PROVIDERS_OPTIONAL_COLUMNS.filter((c) => !cap || cap.columns.includes(c));
  return `
SELECT ${[...PROVIDERS_CORE_COLUMNS, ...optional].join(", ")}
FROM providers
ORDER BY app_type, sort_index, name
`.trim();
}

export interface DbReaderDeps {
  execFileSync: (
    file: string,
    args: string[],
    opts: { encoding: string; timeout: number; maxBuffer: number },
  ) => string;
  existsSync: (path: string) => boolean;
  sqlite3Path: string;
  dbPath: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface ReadResult {
  providers: CcProvider[];
  ok: boolean;
  error?: string;
  /** Probed schema capabilities (doctor #19 W1); undefined when probe failed. */
  capabilities?: DbCapabilities;
}

/**
 * Read providers via sqlite3 CLI (readonly + busy timeout).
 * On failure returns ok=false so caller can keep last-good snapshot.
 *
 * Schema-safe: probes the providers table column set first and builds the
 * SELECT from it, so a 3.19+ install (category column, no usable
 * provider_type) or a legacy install never fails on a missing column.
 */
export function readProviders(deps: DbReaderDeps): ReadResult {
  if (!deps.existsSync(deps.dbPath)) {
    return { providers: [], ok: false, error: `database not found: ${deps.dbPath}` };
  }

  const timeout = deps.timeoutMs ?? 15_000;
  const maxBuffer = deps.maxBuffer ?? 64 * 1024 * 1024;

  // Probe the column set (PRAGMA table_info). On probe failure fall back to
  // core columns only — never risk a SELECT that references a missing column.
  const capabilities = probeCapabilities(deps);
  const sql = `${buildProvidersSql(capabilities)};`;

  let raw: string;
  try {
    raw = deps.execFileSync(
      deps.sqlite3Path,
      ["-cmd", ".timeout 3000", "-readonly", "-json", deps.dbPath, sql],
      { encoding: "utf8", timeout, maxBuffer },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { providers: [], ok: false, error: `sqlite3 failed: ${msg}`, capabilities };
  }

  let rows: ProviderRow[];
  try {
    const text = raw.trim();
    rows = text ? (JSON.parse(text) as ProviderRow[]) : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { providers: [], ok: false, error: `json parse failed: ${msg}`, capabilities };
  }

  if (!Array.isArray(rows)) {
    return { providers: [], ok: false, error: "unexpected sqlite3 json shape", capabilities };
  }

  const providers = uniquifyPiNames(rows.map((row) => parseProviderRow(normalizeRow(row))));
  return { providers, ok: true, capabilities };
}

function normalizeRow(row: ProviderRow): ProviderRow {
  return {
    ...row,
    id: String(row.id),
    app_type: String(row.app_type ?? ""),
    name: String(row.name ?? ""),
    settings_config:
      typeof row.settings_config === "string"
        ? row.settings_config
        : JSON.stringify(row.settings_config ?? {}),
    is_current: row.is_current ? 1 : 0,
    category: row.category ? String(row.category) : row.category ?? null,
  };
}

/** Default DB path: ~/.cc-switch/cc-switch.db */
export function defaultDbPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.CC_SWITCH_DB?.trim()) return env.CC_SWITCH_DB.trim();
  return `${home.replace(/[\\/]+$/, "")}/.cc-switch/cc-switch.db`;
}
