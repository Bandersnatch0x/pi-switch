/**
 * pi-switch extension entry.
 *
 * Pure logic lives under ../src; runtime IO and command wiring live in
 * ./runtime.ts, ./commands.ts, ./switch-lifecycle.ts.
 * Runtime notes (from old cc-switch extension):
 *   - bun:sqlite is NOT available → shell out to sqlite3 CLI
 *   - node:* builtins must be dynamic-imported inside the async factory
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveSqlitePath } from "../src/sqlite-path.ts";
import { Runtime } from "./runtime.ts";
import { registerCommands } from "./commands.ts";
import { createSwitchLifecycle } from "./switch-lifecycle.ts";
import { installClaudeCodeCompat } from "./claude-code-compat.ts";
import { installGeminiToolCompat } from "./gemini-tool-compat.ts";

export default async function (pi: ExtensionAPI) {
  const [cp, cryptoMod, fs, osMod, moduleMod, pathMod, urlMod, httpMod] = await Promise.all([
    import("node:child_process"),
    import("node:crypto"),
    import("node:fs"),
    import("node:os"),
    import("node:module"),
    import("node:path"),
    import("node:url"),
    import("node:http"),
  ]);

  const probeHttp = (url: string, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      const req = httpMod.get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
    });

  const require = moduleMod.createRequire(import.meta.url);
  const extensionDir = pathMod.dirname(urlMod.fileURLToPath(import.meta.url));
  const snapshotPath = pathMod.join(extensionDir, "..", "defaults", "fingerprint-snapshot.json");
  const resolvePackageVersion = (name: string): string | undefined => {
    try {
      const entry = require.resolve(name);
      const pkgPath = pathMod.join(pathMod.dirname(entry), "..", "package.json");
      const version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
      return typeof version === "string" && version.trim() ? version.trim() : undefined;
    } catch {
      return undefined;
    }
  };

  const rt = new Runtime({
    execFileSync: cp.execFileSync,
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
    randomUUID: cryptoMod.randomUUID,
    resolvePackageVersion,
    snapshotPath,
    probeHttp,
    release: osMod.release(),
    home: osMod.homedir(),
  });

  rt.reloadConfig();
  rt.reloadHeaderRules();

  const resolved = resolveSqlitePath({
    configPath: rt.config.sqlitePath,
    exists: rt.io.existsSync,
  });
  rt.sqlite3Tried = resolved.tried ?? [];
  if (!resolved.path) {
    console.error(
      "[pi-switch] sqlite3 not found. Set SQLITE3_PATH or pi-switch.json.sqlitePath. Tried:",
      resolved.tried,
    );
    rt.sqlite3Path = "";
  } else {
    rt.sqlite3Path = resolved.path;
  }

  const lifecycle = createSwitchLifecycle(pi, rt);
  lifecycle.install();
  installClaudeCodeCompat(pi, rt);
  installGeminiToolCompat(pi, rt);
  registerCommands(pi, rt, lifecycle);
}
