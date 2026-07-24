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
import { DEFAULT_PAGE_SIZE } from "../src/types.ts";
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
import { fetchRemoteModels, mergeModelLists } from "../src/models-fetch.ts";
import { buildTabs, formatTabLabel } from "../src/ui/tabs.ts";
import {
  buildPageOptions,
  NAV_JUMP,
  NAV_NEXT,
  NAV_PREV,
  paginate,
  SEARCH_LABEL,
} from "../src/ui/paginate.ts";
import {
  filterProviders,
  formatProviderLabel,
  sortProviders,
} from "../src/ui/labels.ts";

// Populated by async factory
let execFileSync: typeof import("node:child_process").execFileSync;
let existsSync: typeof import("node:fs").existsSync;
let readFileSync: typeof import("node:fs").readFileSync;
let writeFileSync: typeof import("node:fs").writeFileSync;
let renameSync: typeof import("node:fs").renameSync;
let HOME = "";

const MANUAL_ENTRY = "✎ 手动输入 model id…";
const FETCH_REMOTE = "📡 获取远端模型";
const REFETCH = "↻ 重新拉取远端模型";

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
  return {
    codexVersion: "0.144.0",
    claudeCodeVersion: "1.0.0",
    geminiVersion: "0.1.0",
    osInfo: process.platform === "win32" ? "Windows" : process.platform,
  };
}

function overridesFor(dbId: string): Record<string, string> | undefined {
  return config.providerOverrides?.[dbId]?.headers;
}

// ── Interactive UI ───────────────────────────────────────────────────────────

async function pickTab(
  providers: CcProvider[],
  ctx: any,
  preferred?: string,
): Promise<string | undefined> {
  const tabs = buildTabs(providers, config.tabs);
  if (!tabs.length) return undefined;
  if (tabs.length === 1) return tabs[0].appType;

  const labels = tabs.map((t) => formatTabLabel(t, t.appType === preferred));
  const picked = await ctx.ui.select("选择 app_type", labels);
  if (!picked) return undefined;
  const idx = labels.indexOf(picked);
  return tabs[idx]?.appType;
}

async function pickProvider(
  providers: CcProvider[],
  ctx: any,
  lastDbId?: string,
  activePiName?: string,
): Promise<CcProvider | undefined> {
  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
  let list = sortProviders(providers, lastDbId);
  let page = 1;
  let query = "";

  while (true) {
    const filtered = filterProviders(list, query);
    const { items, totalPages } = paginate(filtered, page, pageSize);
    const labels = items.map((p) =>
      formatProviderLabel(p, {
        piActive: activePiName === p.piName,
        isLastUsed: lastDbId === p.id,
      }),
    );
    const nav = buildPageOptions(labels, page, totalPages, filtered.length, {
      includeSearch: true,
      includeJump: true,
    });
    const title =
      (query ? `搜索 "${query}" · ` : "") + nav.title + ` · ${providers[0]?.appType ?? ""}`;
    const picked = await ctx.ui.select(title, nav.options);
    if (!picked) return undefined;
    if (picked === SEARCH_LABEL) {
      const q = await ctx.ui.input("搜索 name / host / notes", query);
      query = q?.trim() ?? "";
      page = 1;
      continue;
    }
    if (picked === NAV_PREV) {
      page--;
      continue;
    }
    if (picked === NAV_NEXT) {
      page++;
      continue;
    }
    if (picked === NAV_JUMP) {
      const raw = await ctx.ui.input(`跳到页码 (1-${totalPages})`, String(page));
      const n = parseInt(raw ?? "", 10);
      if (Number.isFinite(n)) page = n;
      continue;
    }
    const idx = labels.indexOf(picked);
    const provider = items[idx];
    if (!provider) return undefined;
    if (!isSwitchable(provider)) {
      ctx.ui.notify(`不可切换: ${provider.parseError ?? "unknown"}`, "warning");
      continue;
    }
    return provider;
  }
}

async function pickModel(provider: CcProvider, ctx: any): Promise<string | undefined> {
  let remote: string[] = [];
  let remoteLoaded = false;

  while (true) {
    const all = mergeModelLists(provider.configModels, remote);
    let page = 1;
    const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;

    while (true) {
      const { items, totalPages } = paginate(all, page, pageSize);
      const tools = [MANUAL_ENTRY, remoteLoaded ? REFETCH : FETCH_REMOTE];
      const nav = buildPageOptions([...items, ...tools], page, Math.max(totalPages, 1), all.length, {
        includeSearch: false,
        includeJump: totalPages > 1,
      });
      const title = `选择 model（${provider.displayName}） · 第 ${page}/${Math.max(totalPages, 1)} 页 · 共 ${all.length} 个`;
      const picked = await ctx.ui.select(title, nav.options);
      if (!picked) return undefined;
      if (picked === NAV_PREV) {
        page--;
        continue;
      }
      if (picked === NAV_NEXT) {
        page++;
        continue;
      }
      if (picked === NAV_JUMP) {
        const raw = await ctx.ui.input(`跳到页码`, String(page));
        const n = parseInt(raw ?? "", 10);
        if (Number.isFinite(n)) page = n;
        continue;
      }
      if (picked === MANUAL_ENTRY) {
        const manual = await ctx.ui.input(
          "输入 model id",
          provider.configModels[0] ?? "",
        );
        if (manual?.trim()) return manual.trim();
        break;
      }
      if (picked === FETCH_REMOTE || picked === REFETCH) {
        ctx.ui.setStatus?.("pi-switch", "拉取远端模型…");
        const ua = overridesFor(provider.id)?.["User-Agent"];
        const result = await fetchRemoteModels({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          modelsUrl: provider.modelsUrl,
          isFullUrl: provider.isFullUrl,
          userAgent: ua,
        });
        ctx.ui.setStatus?.("pi-switch", undefined);
        remoteLoaded = true;
        if (result.error || !result.models.length) {
          ctx.ui.notify(
            `远端模型获取失败${result.error ? `: ${result.error}` : "（空列表）"}，可手动输入`,
            "warning",
          );
          remote = [];
        } else {
          remote = result.models;
          ctx.ui.notify(`已获取 ${remote.length} 个远端模型`, "info");
        }
        break; // rebuild outer
      }
      return picked.trim();
    }
  }
}

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

  const tab = await pickTab(providers, ctx, sel?.tab ?? sel?.appType);
  if (!tab) return;

  const inTab = providers.filter((p) => p.appType === tab);
  const provider = await pickProvider(
    inTab,
    ctx,
    sel?.dbId,
    (ctx.model as any)?.provider as string | undefined,
  );
  if (!provider) return;

  const modelId = await pickModel(provider, ctx);
  if (!modelId) return;

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
    tab,
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
    `● ${modelId} @ ${provider.appType}/${provider.displayName}`,
  );
}

// ── Entry ────────────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  const [cp, fs, os] = await Promise.all([
    import("node:child_process"),
    import("node:fs"),
    import("node:os"),
  ]);
  execFileSync = cp.execFileSync;
  existsSync = fs.existsSync;
  readFileSync = fs.readFileSync;
  writeFileSync = fs.writeFileSync;
  renameSync = fs.renameSync;
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
          `● ${current.model} @ ${match.appType}/${match.displayName}`,
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
