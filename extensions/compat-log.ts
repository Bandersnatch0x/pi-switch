/**
 * Shared file logging for compat extensions: append one timestamped JSON
 * line, keep only the last `cap` lines, redact inline URL credentials
 * before they land on disk. Logging must never break a request — every
 * path swallows errors.
 */

import type { FsLike } from "../src/settings.ts";

/** Minimum fs surface the logger needs — lets tests pass a 3-method mock. */
export type LogFs = Pick<FsLike, "existsSync" | "readFileSync" | "writeFileSync">;

const LOG_LINE_CAP = 50;

/** Append a timestamped JSON entry to `path`, keeping the last `cap` lines. */
export function appendCappedJsonLog(
  fs: LogFs,
  path: string,
  entry: Record<string, unknown>,
  cap = LOG_LINE_CAP,
): void {
  try {
    const line = JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n";
    let prev = "";
    try {
      if (fs.existsSync(path)) prev = fs.readFileSync(path, "utf8");
    } catch {
      prev = "";
    }
    const lines = (prev + line).split("\n").filter(Boolean).slice(-cap);
    fs.writeFileSync(path, lines.join("\n") + "\n", "utf8");
  } catch {
    /* ignore logging failures */
  }
}

/** Strip inline `user:pass@` credentials from a URL before logging it. */
export function redactUrlCredentials(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
}
