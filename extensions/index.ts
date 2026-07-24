/**
 * pi-switch extension entry.
 *
 * Pure logic lives under ../src; this file does IO and Pi interaction.
 * Runtime notes (from old cc-switch extension):
 *   - bun:sqlite is NOT available → shell out to sqlite3 CLI
 *   - node:* builtins must be dynamic-imported inside the async factory
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CcProvider, HeaderRule, PiSwitchConfig, PiSwitchSelection } from "../src/types.ts";
import { defaultDbPath, readProviders } from "../src/db.ts";
import { resolveSqlitePath } from "../src/sqlite-path.ts";
import { isSwitchable } from "../src/parse/index.ts";
import { parseHeaderRulesFile, combineRules } from "../src/headers/rules.ts";
import {
  migrateLegacySelection,
  piSettingsPath,
  piSwitchConfigPath,
  providerHeadersPath,
  readPiSwitchConfig,
  readSelection,
  writeSelection,
  type FsLike,
} from "../src/settings.ts";
import { registerProvider, switchToProvider } from "../src/register.ts";
import { fetchRemoteModels } from "../src/models-fetch.ts";
import { threeLevelPick } from "../src/ui/three-level-pick.ts";

// Populated by async factory
let execFileSync: typeof import("node:child_process").execFileSync;
let existsSync: typeof import("node:fs").existsSync;
let readFileSync: typeof import("node:fs").readFileSync;
let writeFileSync: typeof import("node:fs").writeFileSync;
let renameSync: typeof import("node:fs").renameSync;
let os: typeof import("node:os");
let HOME = "";

const fsLike = (): FsLike => ({
  existsSync,
  readFileSync: readFileSync as FsLike["readFileSync"],
  writeFileSync: writeFileSync as FsLike["writeFileSync"],
  renameSync,
});

// ── Snapshot state ───────────────────────────────────────────────────────────

let lastGoodProviders: CcProvider[] = [];
let registeredPsNames: string[] = [];
let warnedMissingDbId = false;
let headerRules: HeaderRule[] = [];
let config: PiSwitchConfig = {};
let sqlite3Path = "sqlite3";

function loadConfig(): PiSwitchConfig {
  return readPiSwitchConfig(fsLike(), piSwitchConfigPath(HOME));
}

function loadHeaderRules(): HeaderRule[] {
  const defaultsPath = new URL("../defaults/headers.json", import.meta.url);
  let defaults: HeaderRule[] = [];
  try {
    // fileURL path for bun/node
    const p = defaultsPath.pathname.startsWith("/") && process.platform === "win32"
      ? decodeURIComponent(defaultsPath.pathname.slice(1))
      : decodeURIComponent(defaultsPath.pathname);
    if (existsSync(p)) {
      defaults = parseHeaderRulesFile(JSON.parse(readFileSync(p, "utf8")));
    }
  } catch {
    // package defaults optional at runtime
  }

  let shared: HeaderRule[] = [];
  try {
    const sp = providerHeadersPath(HOME);
    if (existsSync(sp)) {
      shared = parseHeaderRulesFile(JSON.parse(readFileSync(sp, "utf8")));
    }
  } catch {
    // ignore
  }
  return combineRules(defaults, shared);
}

function refreshSnapshot(): { providers: CcProvider[]; error?: string } {
  const result = readProviders({
    execFileSync: execFileSync as any,
    existsSync,
    sqlite3Path,
    dbPath: defaultDbPath(HOME),
  });
  if (result.ok) {
    lastGoodProviders = result.providers;
    return { providers: result.providers };
  }
  if (lastGoodProviders.length) {
    return {
      providers: lastGoodProviders,
      error: result.error ?? "read failed; using last good snapshot",
    };
  }
  return { providers: [], error: result.error ?? "failed to read database" };
}

function headerVars(): Record<string, string> {
  // Match the codex/claude CLI UA shape: "Windows 10.0; x64" / "macOS 14.5; arm64".
  // A bare "Windows" mismatches real CLI output and trips UA-fingerprinting gateways
  // (root cause of "Connection error 502" after switching). Versions kept current as
  // of the codex/claude CLI baseline that emits the bundled anthropic-beta flags.
  const osInfo = (() => {
    const arch = process.arch === "x64" ? "x64" : process.arch;
    if (process.platform === "win32") {
      const rel = os.release().split(".")[0] ?? "10";
      return `Windows ${rel}; ${arch}`;
    }
    if (process.platform === "darwin") return `macOS ${os.release()}; ${arch}`;
    return `${process.platform}; ${arch}`;
  })();
  return {
    codexVersion: "0.144.0",
    claudeCodeVersion: "1.0.0",
    geminiVersion: "0.1.0",
    osInfo,
  };
}

function overridesFor(dbId: string): Record<string, string> | undefined {
  return config.providerOverrides?.[dbId]?.headers;
}

// ── Interactive UI：三列同屏 类型 | 名称 | 模型 ─────────────────────────────

async function runCommand(pi: ExtensionAPI, ctx: any): Promise<void> {
  config = loadConfig();
  headerRules = loadHeaderRules();

  const { providers, error } = refreshSnapshot();
  if (error) ctx.ui.notify(error, "warning");
  if (!providers.length) {
    ctx.ui.notify(
      "未找到 cc-switch provider（检查 ~/.cc-switch/cc-switch.db 或 CC_SWITCH_DB）",
      "warning",
    );
    return;
  }

  const settingsPath = piSettingsPath(HOME);
  let sel =
    readSelection(fsLike(), settingsPath) ??
    migrateLegacySelection(fsLike(), settingsPath, providers, process.pid);

  const picked = await threeLevelPick(ctx, {
    providers,
    preferredTab: sel?.tab ?? sel?.appType,
    lastDbId: sel?.dbId,
    lastModel: sel?.model,
    activePiName: (ctx.model as any)?.provider as string | undefined,
    tabOrder: config.tabs,
    fetchRemote: async (provider) => {
      const ua = overridesFor(provider.id)?.["User-Agent"];
      const r = await fetchRemoteModels({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        modelsUrl: provider.modelsUrl,
        isFullUrl: provider.isFullUrl,
        userAgent: ua,
      });
      if (r.error) throw new Error(r.error);
      return r.models;
    },
  });
  if (picked.kind !== "ok") return;
  const { provider, modelId } = picked;

  const result = await switchToProvider({
    pi: pi as any,
    provider,
    modelId,
    findModel: (p, m) => (ctx.modelRegistry as any)?.find?.(p, m),
    previousPsNames: registeredPsNames,
    rules: headerRules,
    overrideHeaders: overridesFor(provider.id),
    vars: headerVars(),
    debug: config.debug,
  });

  if (!result.ok) {
    ctx.ui.notify(`切换失败：${result.error}`, "error");
    return;
  }

  registeredPsNames = [provider.piName];
  const newSel: PiSwitchSelection = {
    dbId: provider.id,
    model: modelId,
    tab: provider.appType,
    appType: provider.appType,
    provider: provider.piName,
  };
  const persisted = writeSelection(fsLike(), settingsPath, newSel, process.pid);
  if (!persisted.ok) {
    ctx.ui.notify(`已切换，本次选择未保存：${persisted.error}`, "warning");
  } else {
    ctx.ui.notify(`已切换到 ${provider.displayName} · ${modelId}`, "info");
  }
  ctx.ui.setStatus?.(
    "pi-switch",
    `${modelId} @ ${provider.appType}/${provider.displayName}`,
  );
}

// ── Entry ────────────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  const [cp, fs, osMod] = await Promise.all([
    import("node:child_process"),
    import("node:fs"),
    import("node:os"),
  ]);
  execFileSync = cp.execFileSync;
  existsSync = fs.existsSync;
  readFileSync = fs.readFileSync;
  writeFileSync = fs.writeFileSync;
  renameSync = fs.renameSync;
  os = osMod;
  HOME = os.homedir();

  config = loadConfig();
  headerRules = loadHeaderRules();

  const resolved = resolveSqlitePath({
    configPath: config.sqlitePath,
    exists: existsSync,
  });
  if (!resolved.path) {
    console.error(
      "[pi-switch] sqlite3 not found. Set SQLITE3_PATH or pi-switch.json.sqlitePath. Tried:",
      resolved.tried,
    );
  } else {
    sqlite3Path = resolved.path;
  }

  const { providers } = refreshSnapshot();

  const settingsPath = piSettingsPath(HOME);
  const sel =
    readSelection(fsLike(), settingsPath) ??
    migrateLegacySelection(fsLike(), settingsPath, providers, process.pid);

  if (sel) {
    const match = providers.find((p) => p.id === sel.dbId);
    if (match && isSwitchable(match)) {
      if (
        registerProvider(pi as any, match, [sel.model], {
          rules: headerRules,
          overrideHeaders: overridesFor(match.id),
          vars: headerVars(),
          debug: config.debug,
        })
      ) {
        registeredPsNames = [match.piName];
      }
    } else if (!warnedMissingDbId) {
      warnedMissingDbId = true;
      console.warn(
        `[pi-switch] saved dbId not available; keeping selection, not auto-switching (${sel.dbId})`,
      );
    }
  }

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    if (lastGoodProviders.length) {
      ctx.ui?.setStatus?.("pi-switch", `pi-switch: ${lastGoodProviders.length} providers`);
    }
    const current = readSelection(fsLike(), settingsPath);
    if (!current) return;
    const match = lastGoodProviders.find((p) => p.id === current.dbId);
    if (!match || !isSwitchable(match)) {
      if (!warnedMissingDbId) {
        warnedMissingDbId = true;
        ctx.ui?.setStatus?.("pi-switch", "⚠ 已保存的 Provider 不可用");
        ctx.ui?.notify?.(
          "pi-switch: 已保存的 Provider 在当前数据库中不可用，未自动切换",
          "warning",
        );
      }
      return;
    }
    registerProvider(pi as any, match, [current.model], {
      rules: headerRules,
      overrideHeaders: overridesFor(match.id),
      vars: headerVars(),
      debug: config.debug,
    });
    registeredPsNames = [match.piName];
    const model = (ctx as any).modelRegistry?.find?.(match.piName, current.model);
    if (model) {
      const ok = await pi.setModel(model as any);
      if (ok) {
        ctx.ui?.setStatus?.(
          "pi-switch",
          `${current.model} @ ${match.appType}/${match.displayName}`,
        );
      }
    }
  });

  pi.registerCommand("pi-switch", {
    description: "从 cc-switch 选择 Provider 与 Model 并切换",
    handler: async (_args, ctx) => {
      await runCommand(pi, ctx);
    },
  });

  if (config.aliasCcs !== false) {
    pi.registerCommand("ccs", {
      description: "pi-switch 别名",
      handler: async (_args, ctx) => {
        await runCommand(pi, ctx);
      },
    });
  }
}
