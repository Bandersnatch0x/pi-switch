/**
 * Interactive slash-command handlers: /ps-config, /ps-override, /ps-info, /ps-doctor.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CcProvider, ModelMetaOverride, PinEntry } from "../src/types.ts";
import { API_MODEL_META } from "../src/types.ts";
import { defaultDbPath } from "../src/db.ts";
import { PI_MIN_VERSION } from "../src/settings.ts";
import { isSwitchable } from "../src/parse/index.ts";
import { resolveProviderOverride } from "../src/provider-override.ts";
import {
  fetchRemoteModels,
  mergeModelLists,
  resolveListedModel,
} from "../src/models-fetch.ts";
import { threeLevelPick } from "../src/ui/three-level-pick.ts";
import { buildQuickEntries } from "../src/ui/quick-pick.ts";
import { quickSwitchPick } from "../src/ui/quick-switch-pick.ts";
import { runModelMetaDialog } from "../src/ui/model-meta-dialog.ts";
import { runModelMetaForm } from "../src/ui/model-meta-form.ts";
import { pickOverrideProvider } from "../src/ui/provider-override-pick.ts";
import type { ModelMetaScope, ModelMetaDialogInput, ModelMetaDialogResult } from "../src/ui/model-meta-dialog.ts";
import { summarizeModelMeta } from "../src/model-meta.ts";
import { formatDoctorReport, runDoctor } from "../src/doctor.ts";
import type { ResolvedCapabilities } from "../src/capabilities/resolve.ts";
import { isModelsDevMiss } from "../src/capabilities/models-dev.ts";
import {
  createEffectiveConfigSummary,
  formatEffectiveConfigSummary,
} from "../src/effective-config.ts";
import { isFingerprintPreset } from "../src/headers/fingerprints.ts";
import { activeProviderName, type PiSwitchCtx } from "../src/pi-context.ts";
import { buildProviderConfig } from "../src/register.ts";
import type { ModelMetaDialogUi } from "../src/ui/model-meta-dialog.ts";
import type { Runtime } from "./runtime.ts";
import type {
  SwitchLifecycle,
  ActivationResult,
  ActivationStageResult,
} from "./switch-lifecycle.ts";
import { runProbeCommand, runRepairCommand } from "./probe-commands.ts";
import { t, tf } from "../src/ui/tui-locale.ts";

/** Adapt Pi ExtensionUIContext confirm(title,message) to dialog's confirm(message). */
function asModelMetaUi(ui: PiSwitchCtx["ui"]): ModelMetaDialogUi {
  return {
    select: (title, options) => ui.select(title, options),
    input: (prompt, defaultValue) => ui.input(prompt, defaultValue),
    confirm: (message) => ui.confirm(t("confirm"), message),
    notify: (message, level) => {
      const t =
        level === "error" || level === "warning" || level === "info"
          ? level
          : "info";
      ui.notify(message, t);
    },
  };
}

/** Protocol-tier fallback shown as 默认 in the dialog. */
function tierMeta(provider: CcProvider): ModelMetaOverride | undefined {
  if (!provider.api) return undefined;
  const tier = API_MODEL_META[provider.api];
  return {
    reasoning: tier.reasoning,
    contextWindow: tier.contextWindow,
    maxTokens: tier.maxTokens,
  };
}

function scopeText(scope: ModelMetaScope): string {
  return scope.kind === "provider" ? t("scopeAllModels") : tf("scopeModel", { id: scope.modelId });
}

async function persistAndMaybeReapplyMeta(
  rt: Runtime,
  lifecycle: SwitchLifecycle,
  ctx: PiSwitchCtx,
  provider: CcProvider,
  scope: ModelMetaScope,
  modelMeta: ModelMetaOverride | null,
): Promise<boolean> {
  const written = rt.state.saveModelMetaOverride(provider, scope, modelMeta);
  if (!written.ok) {
    ctx.ui?.notify?.(
      tf("overrideSaveFailed", { error: written.error ?? "unknown" }),
      "error",
    );
    return false;
  }

  rt.reloadConfig();
  await reapplyIfActive(rt, lifecycle, ctx, provider);

  const summary =
    modelMeta == null
      ? t("overrideCleared")
      : tf("overrideSaved", { summary: summarizeModelMeta(modelMeta) });
  ctx.ui?.notify?.(
    `${summary} · ${provider.displayName} · ${scopeText(scope)}`,
    "info",
  );
  return true;
}

async function clearAllAndMaybeReapply(
  rt: Runtime,
  lifecycle: SwitchLifecycle,
  ctx: PiSwitchCtx,
  provider: CcProvider,
): Promise<void> {
  const written = rt.state.clearModelMetaOverrides(provider);
  if (!written.ok) {
    ctx.ui?.notify?.(
      tf("overrideClearFailed", { error: written.error ?? "unknown" }),
      "error",
    );
    return;
  }
  rt.reloadConfig();
  await reapplyIfActive(rt, lifecycle, ctx, provider);
  ctx.ui?.notify?.(tf("overrideClearedAll", { provider: provider.displayName }), "info");
}

/** Re-apply registration when this provider is currently registered/active. */
async function reapplyIfActive(
  rt: Runtime,
  lifecycle: SwitchLifecycle,
  ctx: PiSwitchCtx,
  provider: CcProvider,
): Promise<void> {
  const sel = rt.state.readSelection();
  const isActive =
    rt.registeredPsNames.includes(provider.piName) ||
    (sel?.dbId != null && sel.dbId === provider.id);
  if (!isActive) return;

  const modelId = resolveListedModel(
    provider.configModels,
    sel?.dbId === provider.id ? sel.model : undefined,
  );
  if (!modelId) return;

  const result = await lifecycle.activate(
    { provider, modelId, commit: "runtime-only" },
    ctx,
  );
  if (result.kind === "failed") {
    ctx.ui?.notify?.(tf("overrideReapplyFailed", { error: result.error }), "warning");
  }
}

async function openProviderOverride(
  rt: Runtime,
  lifecycle: SwitchLifecycle,
  ctx: PiSwitchCtx,
  provider: CcProvider,
  /** Preselect model scope (from picker `o` on a highlighted model). */
  modelId?: string,
): Promise<void> {
  if (!isSwitchable(provider)) {
    ctx.ui?.notify?.(
      tf("notSwitchableReason", { reason: provider.parseError ?? "unknown" }),
      "warning",
    );
    return;
  }
  // Reload so dialog shows latest disk values.
  rt.reloadConfig();
  // Dialog edits *explicit* layers (not the effective merge).
  const entry = resolveProviderOverride(rt.config.providerOverrides, provider);
  const knownModels = mergeModelLists(
    provider.configModels,
    Object.keys(entry?.modelOverrides ?? {}).filter((k) => !k.includes("*")),
  );
  const models = modelId && !knownModels.includes(modelId)
    ? [modelId, ...knownModels]
    : knownModels;

  const dialogInput: ModelMetaDialogInput = {
    provider,
    scope: modelId ? { kind: "model", modelId } : { kind: "provider" },
    providerMeta: entry?.modelMeta,
    modelOverrides: entry?.modelOverrides,
    base: rt.config.defaultModelMeta,
    tier: tierMeta(provider),
    models,
  };

  let result: ModelMetaDialogResult;
  if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
    try {
      result = await runModelMetaForm(ctx, dialogInput);
    } catch (err) {
      console.error("[pi-switch] model-meta form failed, falling back:", err);
      result = await runModelMetaDialog(asModelMetaUi(ctx.ui), dialogInput);
    }
  } else {
    result = await runModelMetaDialog(asModelMetaUi(ctx.ui), dialogInput);
  }

  if (result.kind === "cancel") return;
  if (result.kind === "clearAll") {
    await clearAllAndMaybeReapply(rt, lifecycle, ctx, provider);
    return;
  }
  await persistAndMaybeReapplyMeta(
    rt,
    lifecycle,
    ctx,
    provider,
    result.scope,
    result.kind === "clear" ? null : result.modelMeta,
  );
}

export async function runOverrideCommand(
  rt: Runtime,
  lifecycle: SwitchLifecycle,
  ctx: PiSwitchCtx,
): Promise<void> {
  const { providers, error } = rt.refreshSnapshot();
  if (error) ctx.ui?.notify?.(error, "warning");
  rt.reloadConfig();
  const switchable = providers.filter(isSwitchable);
  if (!switchable.length) {
    ctx.ui?.notify?.(t("noSwitchableProviders"), "warning");
    return;
  }

  const currentId = rt.state.readSelection()?.dbId;

  // Prefer current selection at top.
  const ordered = [
    ...switchable.filter((p) => p.id === currentId),
    ...switchable.filter((p) => p.id !== currentId),
  ];
  const labels = ordered.map((p) => {
    const mark = p.id === currentId ? "★ " : "";
    const entry = resolveProviderOverride(rt.config.providerOverrides, p);
    const n = Object.keys(entry?.modelOverrides ?? {}).length;
    const badge = entry?.modelMeta
      ? ` · ${n ? tf("combinedOverrideBadge", { n }) : t("overrideBadge")}`
      : n
        ? ` · ${tf("modelOverrideBadge", { n })}`
        : "";
    return `${mark}${p.appType}/${p.displayName}${badge}`;
  });

  const idx = await pickOverrideProvider(ctx, t("overrideProviderTitle"), labels);
  if (idx === undefined) return;
  const provider = ordered[idx];
  if (!provider) return;
  await openProviderOverride(rt, lifecycle, ctx, provider);
}

export async function runDoctorCommand(rt: Runtime, ctx: PiSwitchCtx): Promise<void> {
  rt.reloadConfig();
  rt.reloadHeaderRules();
  // Force re-probe so doctor shows current fingerprint sources.
  rt.invalidateVarsCache();
  rt.headerVars();

  const { providers, error, capabilities: schemaCapabilities } = rt.refreshSnapshot();
  const sel = rt.state.readSelection();
  const dbPath = defaultDbPath(rt.home);
  const routingProbe = await rt.routingProbe();

  // W4: refresh the selected model's capability fact when missing/stale, then resolve.
  let capabilities: { modelId: string; resolved: ResolvedCapabilities } | undefined;
  let modelsDevCache: { state: "hit" | "miss" | "cold"; observedAt?: string } | undefined;
  const selMatch = sel
    ? providers.find(
        (p) => p.id === sel.dbId && (!sel.appType || p.appType === sel.appType),
      )
    : undefined;
  if (sel && selMatch && isSwitchable(selMatch)) {
    const cached = rt.rawCacheEntry(sel.model);
    if (!cached || rt.isCapabilitiesStale(cached)) {
      await rt.refreshCapabilities([sel.model]);
    }
    capabilities = { modelId: sel.model, resolved: rt.capabilitiesFor(selMatch, sel.model) };
    // Issue #39: surface cache state after on-demand refresh.
    const entry = rt.rawCacheEntry(sel.model);
    if (!entry) {
      modelsDevCache = { state: "cold" };
    } else if (isModelsDevMiss(entry)) {
      modelsDevCache = { state: "miss", observedAt: entry.observedAt };
    } else {
      modelsDevCache = { state: "hit", observedAt: entry.observedAt };
    }
  }

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
    piVersion: rt.piVersion(),
    piMinVersion: PI_MIN_VERSION,
    fingerprintSnapshot: rt.fingerprintSnapshot(),
    routingProbe,
    capabilities,
    modelsDevCache,
    refreshFailure: rt.lastRefreshFailure(),
    migrationSummary: rt.migrationSummary,
    schemaCapabilities,
    providerWireCompat: selMatch ? rt.providerWireCompatFor?.(selMatch) : undefined,
  });

  const text = formatDoctorReport(report);
  // Prefer multi-line notify when available; fall back to console.log so the
  // report still surfaces in headless/RPC hosts. Avoids double-printing in
  // hosts (like Orca) that surface both console.log and notify.
  if (typeof ctx.ui?.notify === "function") {
    const level =
      report.summary.fail > 0 ? "error" : report.summary.warn > 0 ? "warning" : "info";
    ctx.ui.notify(text, level);
  } else {
    console.log(text);
  }
  ctx.ui?.setStatus?.(
    "pi-switch",
    `doctor p=${report.summary.pass} w=${report.summary.warn} f=${report.summary.fail}`,
  );
}

/** /ps-info — readonly view of the config registration would currently use. */
export function runEffectiveConfigCommand(rt: Runtime, ctx: PiSwitchCtx): void {
  rt.reloadConfig();
  rt.reloadHeaderRules();
  const { providers, error } = rt.refreshSnapshot();
  if (error) ctx.ui?.notify?.(error, "warning");

  const activePiName = activeProviderName(ctx);
  const activeModelId =
    typeof ctx.model?.id === "string" && ctx.model.id.trim()
      ? ctx.model.id.trim()
      : undefined;
  let source: "active" | "saved" = "active";
  let provider = activePiName
    ? providers.find((candidate) => candidate.piName === activePiName)
    : undefined;
  let modelId = activeModelId;

  if (!provider || !modelId) {
    const selection = rt.state.readSelection();
    provider = selection
      ? providers.find((candidate) => candidate.id === selection.dbId)
      : undefined;
    modelId = selection?.model;
    source = "saved";
  }

  if (!provider || !modelId) {
    ctx.ui?.notify?.(t("effectiveConfigEmpty"), "warning");
    return;
  }

  const resolvedModelId =
    resolveListedModel(provider.configModels, modelId) ?? modelId;
  const providerWireCompat = rt.providerWireCompatFor?.(provider);
  const caps = rt.capabilitiesFor(provider, resolvedModelId);
  const config = buildProviderConfig(provider, [resolvedModelId], {
    rules: rt.headerRules,
    ...rt.headerOverrideOpts(provider),
    vars: rt.headerVars(),
    debug: rt.config.debug,
    onReject: rt.rejectSink(),
    modelMetaFor: (id) => rt.modelMetaFor(provider, id),
    modelsDevFor: (id) => rt.modelsDevFor?.(id),
    providerWireCompat,
    tupleCompatFor: (id) => rt.tupleCompatFor(provider, id),
  });
  if (!config) {
    const maxUnresolved =
      caps.maxTokens.source === "unresolved" ||
      typeof caps.maxTokens.value !== "number";
    ctx.ui?.notify?.(
      maxUnresolved
        ? tf("effectiveConfigMaxUnresolved", {
            provider: provider.displayName,
            model: resolvedModelId,
          })
        : tf("effectiveConfigBuildFailed", {
            reason: provider.parseError ?? provider.displayName,
          }),
      "error",
    );
    return;
  }

  const override = resolveProviderOverride(rt.config.providerOverrides, provider);
  const fingerprint =
    typeof override?.fingerprint === "string" && isFingerprintPreset(override.fingerprint)
      ? override.fingerprint
      : undefined;
  const summary = createEffectiveConfigSummary({
    source,
    provider,
    modelId: resolvedModelId,
    config,
    fingerprint,
    providerWireCompat,
    reasoningConservative: caps.reasoning.source === "conservative-default",
  });
  const text = formatEffectiveConfigSummary(summary);
  if (ctx.ui?.notify) {
    ctx.ui.notify(text, "info");
  } else {
    console.log(text);
  }
  ctx.ui?.setStatus?.(
    "pi-switch",
    `info ${summary.modelId} @ ${summary.appType}/${summary.providerName}`,
  );
}

export async function runCommand(
  rt: Runtime,
  lifecycle: SwitchLifecycle,
  ctx: PiSwitchCtx,
): Promise<void> {
  rt.reloadHeaderRules();

  // Loop so `o` override returns to the picker (F contract). Esc at type-only exits.
  // First pass and each resume after override reloads config + DB snapshot once.
  // Remote model lists live here so they survive picker re-entry after `o`.
  const remoteCache = new Map<string, string[]>();
  // After `o` the picker reopens at the model column of the edited provider.
  let resume: { appType?: string; dbId: string; model?: string } | undefined;
  while (true) {
    rt.reloadConfig();
    const { providers: live, error: snapErr } = rt.refreshSnapshot();
    if (snapErr) ctx.ui.notify(snapErr, "warning");
    if (!live.length) {
      ctx.ui.notify(t("noCcProviders"), "warning");
      return;
    }
    const sel = rt.state.readOrMigrateSelection(live);

    const picked = await threeLevelPick(ctx, {
      providers: live,
      preferredTab: sel?.tab ?? sel?.appType,
      lastDbId: sel?.dbId,
      lastModel: sel?.model,
      resume,
      activePiName: activeProviderName(ctx),
      tabOrder: rt.config.tabs,
      pins: rt.config.pins,
      recent: rt.config.recent,
      remoteCache,
      hasOverride: (provider, modelId) => rt.hasModelMetaOverride(provider, modelId),
      onTogglePin: (entry) => {
        const result = rt.state.togglePin(entry);
        if (!result.ok) {
          throw new Error(result.error ?? "write pins failed");
        }
        rt.config = { ...rt.config, pins: result.pins };
        return result.pins;
      },
      fetchRemote: async (provider) => {
        const ua = rt.overridesFor(provider)?.headers?.["User-Agent"];
        const r = await fetchRemoteModels({
          api: provider.api,
          authHeader: provider.authHeader,
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

    // Override path: custom TUI already closed; open form outside (H1), then resume picker.
    if (picked.kind === "override") {
      await openProviderOverride(rt, lifecycle, ctx, picked.provider, picked.modelId);
      resume = {
        appType: picked.provider.appType,
        dbId: picked.provider.id,
        model: picked.modelId,
      };
      continue;
    }
    if (picked.kind !== "ok") return;
    const { provider, modelId } = picked;

    const result = await lifecycle.activate(
      { provider, modelId, commit: "selection" },
      ctx,
    );
    notifyActivation(rt, ctx, provider, modelId, result);
    return;
  }
}

/** Shared post-activate notifications (used by /ps-config and /ps). */
function notifyActivation(
  rt: Runtime,
  ctx: PiSwitchCtx,
  provider: CcProvider,
  modelId: string,
  result: ActivationResult,
): void {
  if (result.kind === "failed") {
    const label =
      result.failedStage === "providerRegistration"
        ? t("stageProviderRegistration")
        : t("stageModelSwitch");
    ctx.ui.notify(tf("activationFailed", { stage: label, error: result.error }), "error");
    return;
  }

  const warnings = activationWarnings(result);
  if (warnings.length) {
    ctx.ui.notify(tf("activationPartial", { warnings: warnings.join("\n- ") }), "warning");
  } else {
    const metaHint = summarizeModelMeta(rt.modelMetaFor(provider, modelId));
    ctx.ui.notify(
      tf("activationSuccess", {
        provider: provider.displayName,
        model: modelId,
        meta: metaHint,
      }),
      "info",
    );
  }
  ctx.ui.setStatus?.(
    "pi-switch",
    `${modelId} @ ${provider.appType}/${provider.displayName}`,
  );
}

function stageIssue(
  stage: ActivationStageResult,
  failedLabel: string,
  skippedLabel?: string,
): string | undefined {
  if (stage.status === "failed") return `${failedLabel}: ${stage.error}`;
  if (stage.status === "skipped" && skippedLabel && stage.reason) {
    return `${skippedLabel}: ${stage.reason}`;
  }
  return undefined;
}

export function activationWarnings(
  result: Extract<ActivationResult, { kind: "activated" }>,
): string[] {
  return [
    stageIssue(
      result.stages.providerCleanup,
      t("oldProviderCleanupFailed"),
      t("oldProviderCleanupSkipped"),
    ),
    stageIssue(result.stages.selectionPersistence, t("selectionSaveFailed")),
    stageIssue(result.stages.recentPersistence, t("recentSaveFailed")),
  ].filter((item): item is string => Boolean(item));
}

/** /ps — one-screen quick switch across pinned + recent pairs (skips 3-level nav). */
export async function runQuickSwitch(
  rt: Runtime,
  lifecycle: SwitchLifecycle,
  ctx: PiSwitchCtx,
): Promise<void> {
  rt.reloadConfig();
  const { providers: live, error: snapErr } = rt.refreshSnapshot();
  if (snapErr) ctx.ui.notify(snapErr, "warning");
  if (!buildQuickEntries(rt.config.pins ?? [], rt.config.recent ?? [], live).length) {
    ctx.ui.notify(t("quickEmptyHint"), "warning");
    return;
  }
  const onTogglePin = async (entry: PinEntry): Promise<PinEntry[]> => {
    const result = rt.state.togglePin(entry);
    if (!result.ok) {
      throw new Error(result.error ?? "write pins failed");
    }
    rt.config = { ...rt.config, pins: result.pins };
    return result.pins;
  };
  const onPick = async (provider: CcProvider, modelId: string): Promise<void> => {
    const result = await lifecycle.activate(
      { provider, modelId, commit: "selection" },
      ctx,
    );
    notifyActivation(rt, ctx, provider, modelId, result);
  };
  await quickSwitchPick(ctx, {
    providers: live,
    pins: rt.config.pins ?? [],
    recent: rt.config.recent ?? [],
    onTogglePin,
    onPick,
  });
}

export function registerCommands(
  pi: ExtensionAPI,
  rt: Runtime,
  lifecycle: SwitchLifecycle,
): void {
  pi.registerCommand("ps-config", {
    description: t("cmdConfigDescription"),
    handler: async (_args, ctx) => {
      await runCommand(rt, lifecycle, ctx);
    },
  });

  pi.registerCommand("ps", {
    description: t("cmdQuickDescription"),
    handler: async (_args, ctx) => {
      await runQuickSwitch(rt, lifecycle, ctx);
    },
  });

  if (rt.config.aliasCcs !== false) {
    pi.registerCommand("ccs", {
      description: t("cmdAliasDescription"),
      handler: async (_args, ctx) => {
        await runCommand(rt, lifecycle, ctx);
      },
    });
  }

  pi.registerCommand("ps-override", {
    description: t("cmdOverrideDescription"),
    handler: async (_args, ctx) => {
      await runOverrideCommand(rt, lifecycle, ctx);
    },
  });

  pi.registerCommand("ps-doctor", {
    description: t("cmdDoctorDescription"),
    handler: async (_args, ctx) => {
      await runDoctorCommand(rt, ctx);
    },
  });

  pi.registerCommand("ps-probe", {
    description: t("cmdProbeDescription"),
    handler: async (_args, ctx) => {
      await runProbeCommand(pi, rt, ctx);
    },
  });

  pi.registerCommand("ps-repair", {
    description: t("cmdRepairDescription"),
    handler: async (_args, ctx) => {
      await runRepairCommand(pi, rt, lifecycle, ctx);
    },
  });

  pi.registerCommand("ps-info", {
    description: t("cmdInfoDescription"),
    handler: async (_args, ctx) => {
      runEffectiveConfigCommand(rt, ctx);
    },
  });
}
