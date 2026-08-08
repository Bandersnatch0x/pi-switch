/**
 * Load and combine package defaults + shared provider-headers rules.
 * Pure over injected IO; callers supply the package defaults path.
 */

import type { HeaderRule } from "../types.ts";
import { providerHeadersPath } from "../settings.ts";
import { combineRules, parseHeaderRulesFile } from "./rules.ts";

export type HeaderRulesLoadIo = {
  home: string;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf8") => string;
  /** Absolute path to package defaults/headers.json. */
  defaultsPath: string;
};

/** Load defaults + ~/.pi/agent/provider-headers.json and combine. */
export function loadHeaderRules(io: HeaderRulesLoadIo): HeaderRule[] {
  let defaults: HeaderRule[] = [];
  try {
    if (io.existsSync(io.defaultsPath)) {
      defaults = parseHeaderRulesFile(
        JSON.parse(io.readFileSync(io.defaultsPath, "utf8")),
      );
    }
  } catch {
    // package defaults optional at runtime
  }

  let shared: HeaderRule[] = [];
  try {
    const sp = providerHeadersPath(io.home);
    if (io.existsSync(sp)) {
      shared = parseHeaderRulesFile(
        JSON.parse(io.readFileSync(sp, "utf8")),
      );
    }
  } catch {
    // ignore
  }
  return combineRules(defaults, shared);
}

/** Resolve file: URL pathname for the current platform (Windows drive letter). */
export function fileUrlPath(url: URL): string {
  return url.pathname.startsWith("/") && process.platform === "win32"
    ? decodeURIComponent(url.pathname.slice(1))
    : decodeURIComponent(url.pathname);
}
