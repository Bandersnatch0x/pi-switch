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
  const [cp, fs, osMod] = await Promise.all([
    import("node:child_process"),
    import("node:fs"),
    import("node:os"),
  ]);

  const rt = new Runtime({
    execFileSync: cp.execFileSync,
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
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
