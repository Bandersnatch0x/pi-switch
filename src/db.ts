import type { CcProvider, ProviderRow } from "./types.ts";
import { parseProviderRow } from "./parse/index.ts";

export const PROVIDERS_SQL = `
SELECT id, app_type, name, settings_config, is_current,
       website_url, notes, meta, provider_type, sort_index
FROM providers
ORDER BY app_type, sort_index, name
`.trim();

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
}

/**
 * Read providers via sqlite3 CLI (readonly + busy timeout).
 * On failure returns ok=false so caller can keep last-good snapshot.
 */
export function readProviders(deps: DbReaderDeps): ReadResult {
  if (!deps.existsSync(deps.dbPath)) {
    return { providers: [], ok: false, error: `database not found: ${deps.dbPath}` };
  }

  const timeout = deps.timeoutMs ?? 15_000;
  const maxBuffer = deps.maxBuffer ?? 64 * 1024 * 1024;

  // CLI .timeout via -cmd (PRAGMA busy_timeout with -json emits a second JSON array)
  const sql = `${PROVIDERS_SQL};`;

  let raw: string;
  try {
    raw = deps.execFileSync(
      deps.sqlite3Path,
      ["-cmd", ".timeout 3000", "-readonly", "-json", deps.dbPath, sql],
      { encoding: "utf8", timeout, maxBuffer },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { providers: [], ok: false, error: `sqlite3 failed: ${msg}` };
  }

  let rows: ProviderRow[];
  try {
    const text = raw.trim();
    rows = text ? (JSON.parse(text) as ProviderRow[]) : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { providers: [], ok: false, error: `json parse failed: ${msg}` };
  }

  if (!Array.isArray(rows)) {
    return { providers: [], ok: false, error: "unexpected sqlite3 json shape" };
  }

  const providers = rows.map((row) => parseProviderRow(normalizeRow(row)));
  return { providers, ok: true };
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
  };
}

/** Default DB path: ~/.cc-switch/cc-switch.db */
export function defaultDbPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.CC_SWITCH_DB?.trim()) return env.CC_SWITCH_DB.trim();
  return `${home.replace(/[\\/]+$/, "")}/.cc-switch/cc-switch.db`;
}
