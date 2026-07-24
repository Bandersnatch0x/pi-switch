/**
 * Resolve sqlite3 executable path per SPEC §3.2 / Q16:
 * SQLITE3_PATH → pi-switch.json.sqlitePath → PATH lookup
 */

export interface ResolveSqliteOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string | null;
  /** Injected for tests: returns true if path is executable/exists */
  exists?: (path: string) => boolean;
  /** Injected for tests: which PATH entries exist */
  which?: (name: string) => string | undefined;
  platform?: NodeJS.Platform;
}

export function resolveSqlitePath(opts: ResolveSqliteOptions = {}): {
  path: string | undefined;
  source: string;
  tried: string[];
} {
  const env = opts.env ?? process.env;
  const tried: string[] = [];
  const exists = opts.exists ?? defaultExists;
  const which = opts.which ?? defaultWhich;

  if (env.SQLITE3_PATH?.trim()) {
    const p = env.SQLITE3_PATH.trim();
    tried.push(p);
    if (exists(p)) return { path: p, source: "SQLITE3_PATH", tried };
  }

  if (opts.configPath?.trim()) {
    const p = opts.configPath.trim();
    tried.push(p);
    if (exists(p)) return { path: p, source: "pi-switch.json.sqlitePath", tried };
  }

  const name = (opts.platform ?? process.platform) === "win32" ? "sqlite3.exe" : "sqlite3";
  const found = which(name) ?? which("sqlite3");
  if (found) {
    tried.push(found);
    return { path: found, source: "PATH", tried };
  }
  tried.push(name);
  return { path: undefined, source: "none", tried };
}

function defaultExists(p: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function defaultWhich(name: string): string | undefined {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, [name], { encoding: "utf8" }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    return first || undefined;
  } catch {
    return undefined;
  }
}
