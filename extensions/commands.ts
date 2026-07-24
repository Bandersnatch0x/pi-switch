/**
 * Interactive slash-command handlers: /ps-config, /ps-override, /ps-doctor.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CcProvider, PiSwitchSelection } from "../src/types.ts";
import { defaultDbPath } from "../src/db.ts";
import { isSwitchable } from "../src/parse/index.ts";
import {
  migrateLegacySelection,
  piSettingsPath,
  piSwitchConfigPath,
  pushRecentEntry,
  readSelection,
  resolveProviderOverride,
  togglePinEntry,
  writePins,
  writeProviderModelMeta,
  writeRecent,
  writeSelection,
  type ModelMetaOverride,
} from "../src/settings.ts";
import { switchToProvider } from "../src/register.ts";
import { fetchRemoteModels } from "../src/models-fetch.ts";
import { threeLevelPick } from "../src/ui/three-level-pick.ts";
import { runModelMetaDialog } from "../src/ui/model-meta-dialog.ts";
import { summarizeModelMeta } from "../src/model-meta.ts";
import { formatDoctorReport, runDoctor } from "../src/doctor.ts";
import {
  activeProviderName,
  asRegisterApi,
  findRegisteredModel,
  type PiSwitchCtx,
} from "../src/pi-context.ts";
import type { ModelMetaDialogUi } from "../src/ui/model-meta-dialog.ts";
import type { Runtime } from "./runtime.ts";

/** Adapt Pi ExtensionUIContext confirm(title,message) to dialog's confirm(message). */
function asModelMetaUi(ui: PiSwitchCtx["ui"]): ModelMetaDialogUi {
  return {
    select: (title, options) => ui.select(title, options),
    input: (prompt, defaultValue) => ui.input(prompt, defaultValue),
    confirm: (message) => ui.confirm("确认", message),
    notify: (message, level) => {
      const t =
        level === "error" || level === "warning" || level === "info"
          ? level
          : "info";
      ui.notify(message, t);
    },
  };
}

async function persistAndMaybeReapplyMeta(
  rt: Runtime,
  pi: ExtensionAPI,
  ctx: PiSwitchCtx,
  provider: CcProvider,
  modelMeta: ModelMetaOverride | null,
): Promise<boolean> {
  const configPath = piSwitchConfigPath(rt.home);
  const written = writeProviderModelMeta(
    rt.fsLike(),
    configPath,
    provider,
    modelMeta,
    process.pid,
  );
  if (!written.ok) {
    ctx.ui?.notify?.(`参数覆写保存失败：${written.error}`, "error");
    return false;
  }

  rt.reloadConfig();

  // Re-apply immediately when this provider is currently registered/active.
  const settingsPath = piSettingsPath(rt.home);
  const sel = readSelection(rt.fsLike(), settingsPath);
  const isActive =
    rt.registeredPsNames.includes(provider.piName) ||
    (sel?.dbId != null && sel.dbId === provider.id);

  if (isActive) {
    const modelId =
      sel?.dbId === provider.id && sel.model
        ? sel.model
        : provider.configModels[0];
    if (modelId) {
      const result = await switchToProvider({
        pi: asRegisterApi(pi),
        provider,
        modelId,
        findModel: (p, m) => findRegisteredModel(ctx, p, m),
        previousPsNames: rt.registeredPsNames,
        rules: rt.headerRules,
        ...rt.headerOverrideOpts(provider),
        vars: rt.headerVars(),
        debug: rt.config.debug,
        onReject: rt.rejectSink(),
        modelMeta: rt.modelMetaFor(provider),
      });
      if (result.ok) {
        rt.registeredPsNames = [provider.piName];
      } else {
        ctx.ui?.notify?.(
          `已保存覆写，但重新应用失败：${result.error}`,
          "warning",
        );
      }
    }
  }

  const summary =
    modelMeta == null
      ? "已清除 modelMeta 覆写"
      : `已保存：${summarizeModelMeta(modelMeta)}`;
  ctx.ui?.notify?.(`${summary} · ${provider.displayName}`, "info");
  return true;
}

async function openProviderOverride(
  rt: Runtime,
  pi: ExtensionAPI,
  ctx: PiSwitchCtx,
  provider: CcProvider,
): Promise<void> {
  if (!isSwitchable(provider)) {
    ctx.ui?.notify?.(`不可切换: ${provider.parseError ?? "unknown"}`, "warning");
    return;
  }
  // Reload so dialog shows latest disk values.
  rt.reloadConfig();
  // Dialog edits the *explicit* per-provider override (not the effective merge).
  const existing = resolveProviderOverride(rt.config.providerOverrides, provider)?.modelMeta;
  const result = await runModelMetaDialog(asModelMetaUi(ctx.ui), provider, existing);
  if (result.kind === "cancel") return;
  await persistAndMaybeReapplyMeta(
    rt,
    pi,
    ctx,
    provider,
    result.kind === "clear" ? null : result.modelMeta,
  );
}

export async function runOverrideCommand(
  rt: Runtime,
  pi: ExtensionAPI,
  ctx: PiSwitchCtx,
): Promise<void> {
  const { providers, error } = rt.refreshSnapshot();
  if (error) ctx.ui?.notify?.(error, "warning");
  const switchable = providers.filter(isSwitchable);
  if (!switchable.length) {
    ctx.ui?.notify?.("没有可切换的 Provider", "warning");
    return;
  }

  const settingsPath = piSettingsPath(rt.home);
  const sel = readSelection(rt.fsLike(), settingsPath);
  const currentId = sel?.dbId;

  // Prefer current selection at top.
  const ordered = [
    ...switchable.filter((p) => p.id === currentId),
    ...switchable.filter((p) => p.id !== currentId),
  ];
  const labels = ordered.map((p) => {
    const mark = p.id === currentId ? "★ " : "";
    return `${mark}${p.appType}/${p.displayName}`;
  });

  const pick = await ctx.ui.select("参数覆写 · 选择 Provider", labels);
  if (!pick) return;
  const idx = labels.indexOf(pick);
  const provider = ordered[idx];
  if (!provider) return;
  await openProviderOverride(rt, pi, ctx, provider);
}

export async function runDoctorCommand(rt: Runtime, ctx: PiSwitchCtx): Promise<void> {
  rt.reloadConfig();
  rt.reloadHeaderRules();
  // Force re-probe so doctor shows current fingerprint sources.
  rt.invalidateVarsCache();
  rt.headerVars();

  const { providers, error } = rt.refreshSnapshot();
  const settingsPath = piSettingsPath(rt.home);
  const sel = readSelection(rt.fsLike(), settingsPath);
  const dbPath = defaultDbPath(rt.home);

  const report = runDoctor({
    home: rt.home,
    dbPath,
    dbExists: rt.io.existsSync(dbPath),
    sqlite3Path: rt.sqlite3Path || null,
    sqlite3Tried: rt.sqlite3Tried,
    providers,
    providersError: error,
    selection: sel,
    config: rt.config,
    headerRuleCount: rt.headerRules.length,
    varsSummary: rt.varsSummary,
    pins: rt.config.pins,
    recent: rt.config.recent,
  });

  const text = formatDoctorReport(report);
  console.log(text);
  // Prefer multi-line notify when available; fall back to summary.
  if (typeof ctx.ui?.notify === "function") {
    const level =
      report.summary.fail > 0 ? "error" : report.summary.warn > 0 ? "warning" : "info";
    ctx.ui.notify(
      `pi-switch doctor · pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail}\n` +
        report.checks
          .map((c) => {
            const tag = c.status === "pass" ? "PASS" : c.status === "warn" ? "WARN" : "FAIL";
            return `[${tag}] ${c.title}: ${c.detail}`;
          })
          .join("\n"),
      level,
    );
  }
  ctx.ui?.setStatus?.(
    "pi-switch",
    `doctor p=${report.summary.pass} w=${report.summary.warn} f=${report.summary.fail}`,
  );
}

export async function runCommand(
  rt: Runtime,
  pi: ExtensionAPI,
  ctx: PiSwitchCtx,
): Promise<void> {
  rt.reloadConfig();
  rt.reloadHeaderRules();

  const { providers, error } = rt.refreshSnapshot();
  if (error) ctx.ui.notify(error, "warning");
  if (!providers.length) {
    ctx.ui.notify(
      "未找到 cc-switch provider（检查 ~/.cc-switch/cc-switch.db 或 CC_SWITCH_DB）",
      "warning",
    );
    return;
  }

  const settingsPath = piSettingsPath(rt.home);
  const sel =
    readSelection(rt.fsLike(), settingsPath) ??
    migrateLegacySelection(rt.fsLike(), settingsPath, providers, process.pid);

  const configPath = piSwitchConfigPath(rt.home);

  const picked = await threeLevelPick(ctx, {
    providers,
    preferredTab: sel?.tab ?? sel?.appType,
    lastDbId: sel?.dbId,
    lastModel: sel?.model,
    activePiName: activeProviderName(ctx),
    tabOrder: rt.config.tabs,
    pins: rt.config.pins,
    recent: rt.config.recent,
    onTogglePin: (entry) => {
      // Reload so concurrent edits aren't clobbered.
      rt.reloadConfig();
      const { pins, pinned } = togglePinEntry(rt.config.pins, entry);
      const written = writePins(rt.fsLike(), configPath, pins, process.pid);
      if (!written.ok) {
        throw new Error(written.error ?? "write pins failed");
      }
      rt.config = { ...rt.config, pins };
      // notify is done in picker; keep silent here
      void pinned;
      return pins;
    },
    fetchRemote: async (provider) => {
      const ua = rt.overridesFor(provider)?.headers?.["User-Agent"];
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
  // Override path: custom TUI already closed; open dialog outside (H1).
  if (picked.kind === "override") {
    await openProviderOverride(rt, pi, ctx, picked.provider);
    return;
  }
  if (picked.kind !== "ok") return;
  const { provider, modelId } = picked;

  const result = await switchToProvider({
    pi: asRegisterApi(pi),
    provider,
    modelId,
    findModel: (p, m) => findRegisteredModel(ctx, p, m),
    previousPsNames: rt.registeredPsNames,
    rules: rt.headerRules,
    ...rt.headerOverrideOpts(provider),
    vars: rt.headerVars(),
    debug: rt.config.debug,
    onReject: rt.rejectSink(),
    modelMeta: rt.modelMetaFor(provider),
  });

  if (!result.ok) {
    ctx.ui.notify(`切换失败：${result.error}`, "error");
    return;
  }

  rt.registeredPsNames = [provider.piName];
  const newSel: PiSwitchSelection = {
    dbId: provider.id,
    model: modelId,
    tab: provider.appType,
    appType: provider.appType,
    provider: provider.piName,
  };
  const persisted = writeSelection(rt.fsLike(), settingsPath, newSel, process.pid);
  // Track last-N recent (local only).
  rt.reloadConfig();
  const nextRecent = pushRecentEntry(
    rt.config.recent,
    { dbId: provider.id, model: modelId },
    rt.config.recentLimit,
  );
  const recentWritten = writeRecent(rt.fsLike(), configPath, nextRecent, process.pid);
  if (!recentWritten.ok && rt.config.debug) {
    console.warn("[pi-switch] write recent failed:", recentWritten.error);
  }

  if (!persisted.ok) {
    ctx.ui.notify(`已切换，本次选择未保存：${persisted.error}`, "warning");
  } else {
    const metaHint = summarizeModelMeta(rt.modelMetaFor(provider));
    ctx.ui.notify(
      `已切换到 ${provider.displayName} · ${modelId}（${metaHint}）`,
      "info",
    );
  }
  ctx.ui.setStatus?.(
    "pi-switch",
    `${modelId} @ ${provider.appType}/${provider.displayName}`,
  );
}

export function registerCommands(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerCommand("ps-config", {
    description: "从 cc-switch 选择 Provider 与 Model 并切换（pin/recent 本地快捷）",
    handler: async (_args, ctx) => {
      await runCommand(rt, pi, ctx);
    },
  });

  if (rt.config.aliasCcs !== false) {
    pi.registerCommand("ccs", {
      description: "ps-config 别名",
      handler: async (_args, ctx) => {
        await runCommand(rt, pi, ctx);
      },
    });
  }

  pi.registerCommand("ps-override", {
    description: "为 Provider 设置 modelMeta 参数覆写（预设：中转兼容 / 完整推理）",
    handler: async (_args, ctx) => {
      await runOverrideCommand(rt, pi, ctx);
    },
  });

  pi.registerCommand("ps-doctor", {
    description: "诊断 pi-switch 环境（sqlite3 / DB / 指纹 / modelMeta / pin）",
    handler: async (_args, ctx) => {
      await runDoctorCommand(rt, ctx);
    },
  });
}
