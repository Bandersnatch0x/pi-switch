import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveListedModel } from "../src/models-fetch.ts";
import { isSwitchable } from "../src/parse/index.ts";
import {
  asRegisterApi,
  findRegisteredModel,
  type PiSwitchCtx,
} from "../src/pi-context.ts";
import { registerProvider } from "../src/register.ts";
import type { CcProvider, PiSwitchSelection, RecentEntry } from "../src/types.ts";
import type { Runtime } from "./runtime.ts";

/** session_start reasons that may need a pi-switch provider re-registered. */
const SESSION_ACTIVATE_REASONS = new Set([
  "startup",
  "resume",
  "fork",
  "reload",
]);

export type SwitchTarget = {
  provider: CcProvider;
  modelId: string;
  commit: "selection" | "runtime-only";
};

/** Minimal session branch entry fields used to recover the last model. */
type SessionBranchEntry = {
  type?: string;
  provider?: string;
  modelId?: string;
  message?: {
    role?: string;
    provider?: string;
    model?: string;
  };
};

type SessionModelRef = { provider: string; modelId: string };

/**
 * Walk the active session branch for the last model (model_change or assistant).
 * ReadonlySessionManager exposes getBranch, not buildSessionContext.
 */
export function sessionModelFromBranch(
  entries: SessionBranchEntry[] | undefined,
): SessionModelRef | undefined {
  if (!entries?.length) return undefined;
  let found: SessionModelRef | undefined;
  for (const entry of entries) {
    if (entry.type === "model_change") {
      const provider = entry.provider?.trim();
      const modelId = entry.modelId?.trim();
      if (provider && modelId) found = { provider, modelId };
      continue;
    }
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const provider = entry.message.provider?.trim();
      const modelId = entry.message.model?.trim();
      if (provider && modelId) found = { provider, modelId };
    }
  }
  return found;
}

function matchProvider(
  providers: CcProvider[],
  opts: { dbId?: string; appType?: string; piName?: string },
): CcProvider | undefined {
  if (opts.dbId) {
    const byId = providers.find(
      (item) =>
        item.id === opts.dbId &&
        (!opts.appType || item.appType === opts.appType),
    );
    if (byId) return byId;
  }
  if (opts.piName) {
    return providers.find((item) => item.piName === opts.piName);
  }
  return undefined;
}

function resolveModelId(provider: CcProvider, preferred: string): string {
  return resolveListedModel(provider.configModels, preferred) ?? preferred;
}

export type ActivationStageResult =
  | { status: "succeeded" }
  | { status: "skipped"; reason?: string }
  | { status: "failed"; error: string };

export type ActivationStages = {
  providerRegistration: ActivationStageResult;
  modelSwitch: ActivationStageResult;
  providerCleanup: ActivationStageResult;
  selectionPersistence: ActivationStageResult;
  recentPersistence: ActivationStageResult;
};

export type ActivationResult =
  | {
      kind: "failed";
      failedStage: "providerRegistration" | "modelSwitch";
      error: string;
      stages: ActivationStages;
    }
  | {
      kind: "activated";
      stages: ActivationStages;
    };

export interface SwitchLifecycle {
  install(): void;
  activate(target: SwitchTarget, ctx: PiSwitchCtx): Promise<ActivationResult>;
}

const SUCCEEDED: ActivationStageResult = { status: "succeeded" };

function skipped(reason?: string): ActivationStageResult {
  return reason ? { status: "skipped", reason } : { status: "skipped" };
}

function failed(error: string): ActivationStageResult {
  return { status: "failed", error };
}

function initialStages(): ActivationStages {
  return {
    providerRegistration: skipped("not attempted"),
    modelSwitch: skipped("not attempted"),
    providerCleanup: skipped("model not activated"),
    selectionPersistence: skipped("model not activated"),
    recentPersistence: skipped("model not activated"),
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSwitchLifecycle(
  pi: ExtensionAPI,
  rt: Runtime,
): SwitchLifecycle {
  const register = (provider: CcProvider, modelId: string): boolean => {
    const ok = registerProvider(asRegisterApi(pi), provider, [modelId], {
      rules: rt.headerRules,
      ...rt.headerOverrideOpts(provider),
      vars: rt.headerVars(),
      debug: rt.config.debug,
      onReject: rt.rejectSink(),
      modelMetaFor: (id) => rt.modelMetaFor(provider, id),
      modelsDevFor: (id) => rt.modelsDevFor?.(id),
      providerWireCompat: rt.providerWireCompatFor?.(provider),
    });
    // Fire-and-forget models.dev refresh after successful registration (issue #39).
    if (ok) rt.scheduleModelsDevRefresh?.(modelId);
    return ok;
  };

  const warnMissingSelection = (ctx?: PiSwitchCtx): void => {
    if (rt.warnedMissingDbId) return;
    rt.warnedMissingDbId = true;
    if (ctx) {
      ctx.ui?.setStatus?.("pi-switch", "⚠ 已保存的 Provider 不可用");
      ctx.ui?.notify?.(
        "pi-switch: 已保存的 Provider 在当前数据库中不可用，未自动切换",
        "warning",
      );
      return;
    }
    console.warn("[pi-switch] saved dbId not available; keeping selection, not auto-switching");
  };

  /**
   * Register one or more models on a provider; track piName for later cleanup.
   * Multiple model ids are required so continue/resume can restore any recent
   * session model without re-registering mid-restore (Pi restores before
   * session_start).
   */
  const registerModels = (provider: CcProvider, modelIds: string[]): boolean => {
    const ids = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))];
    if (!ids.length) return false;
    const ok = registerProvider(asRegisterApi(pi), provider, ids, {
      rules: rt.headerRules,
      ...rt.headerOverrideOpts(provider),
      vars: rt.headerVars(),
      debug: rt.config.debug,
      onReject: rt.rejectSink(),
      modelMetaFor: (id) => rt.modelMetaFor(provider, id),
      modelsDevFor: (id) => rt.modelsDevFor?.(id),
      providerWireCompat: rt.providerWireCompatFor?.(provider),
    });
    if (!ok) return false;
    for (const id of ids) rt.scheduleModelsDevRefresh?.(id);
    if (!rt.registeredPsNames.includes(provider.piName)) {
      rt.registeredPsNames = [...rt.registeredPsNames, provider.piName];
    }
    return true;
  };

  /** Merge selection + recent into per-provider model id sets for install. */
  const collectInstallTargets = (
    providers: CcProvider[],
    selection: PiSwitchSelection | undefined,
    recent: RecentEntry[],
  ): Map<string, { provider: CcProvider; modelIds: Set<string> }> => {
    const byId = new Map<string, { provider: CcProvider; modelIds: Set<string> }>();
    const add = (entry: { dbId: string; model: string; appType?: string }) => {
      const provider = matchProvider(providers, {
        dbId: entry.dbId,
        appType: entry.appType,
      });
      if (!provider || !isSwitchable(provider)) return;
      const modelId = resolveModelId(provider, entry.model);
      let slot = byId.get(provider.id);
      if (!slot) {
        slot = { provider, modelIds: new Set() };
        byId.set(provider.id, slot);
      }
      slot.modelIds.add(modelId);
    };
    if (selection) add(selection);
    for (const entry of recent) add(entry);
    return byId;
  };

  /**
   * Prefer the session's last model when it is a known pi-switch provider
   * (continue/resume continuity). Fall back to saved selection for new sessions
   * or non-ps models. Session restore does not rewrite selection.
   */
  const resolveSessionTarget = (
    ctx: PiSwitchCtx,
  ): { provider: CcProvider; modelId: string; source: "session" | "selection" } | undefined => {
    const providers = rt.lastGoodProviders;
    const sessionModel = sessionModelFromBranch(ctx.sessionManager?.getBranch?.());
    if (sessionModel) {
      const sessionProvider = matchProvider(providers, {
        piName: sessionModel.provider,
      });
      if (sessionProvider && isSwitchable(sessionProvider)) {
        return {
          provider: sessionProvider,
          modelId: resolveModelId(sessionProvider, sessionModel.modelId),
          source: "session",
        };
      }
    }

    const current = rt.state.readSelection();
    if (!current) return undefined;
    const provider = matchProvider(providers, {
      dbId: current.dbId,
      appType: current.appType,
    });
    if (!provider || !isSwitchable(provider)) return undefined;
    return {
      provider,
      modelId: resolveModelId(provider, current.model),
      source: "selection",
    };
  };

  let installed = false;

  const install = (): void => {
    if (installed) return;
    installed = true;
    const { providers } = rt.refreshSnapshot();
    // One-shot identity migration to { appType, id } (issue #16); no-op once
    // the marker is present. Runs before selection resolution so migrated
    // entries carry appType for pairing.
    rt.migrateIdentity(providers);
    const selection = rt.state.readOrMigrateSelection(providers);
    const recent = rt.state.readConfig().recent ?? [];

    // Pre-register selection + recent so Pi can restore session models that
    // happen before session_start (createAgentSession runs restore first).
    const targets = collectInstallTargets(providers, selection, recent);
    if (selection && !targets.size) {
      warnMissingSelection();
    }
    // Fresh process install: replace any leftover tracking names.
    rt.registeredPsNames = [];
    for (const { provider, modelIds } of targets.values()) {
      registerModels(provider, [...modelIds]);
    }
    // Normalize selection model id if it still holds a filtered [1M] tag.
    if (selection) {
      const provider = matchProvider(providers, {
        dbId: selection.dbId,
        appType: selection.appType,
      });
      if (provider && isSwitchable(provider)) {
        const modelId = resolveModelId(provider, selection.model);
        if (modelId !== selection.model) {
          rt.state.saveSelection({
            ...selection,
            model: modelId,
            tab: selection.tab ?? provider.appType,
            appType: selection.appType ?? provider.appType,
            provider: provider.piName,
          });
        }
      }
    }

    pi.on("session_start", async (event, ctx) => {
      if (!SESSION_ACTIVATE_REASONS.has(event.reason)) return;
      if (rt.lastGoodProviders.length) {
        ctx.ui?.setStatus?.(
          "pi-switch",
          `pi-switch: ${rt.lastGoodProviders.length} providers`,
        );
      }

      const target = resolveSessionTarget(ctx as PiSwitchCtx);
      if (!target) {
        // Only warn when a selection exists but is unusable; bare new sessions
        // with no selection are fine.
        if (rt.state.readSelection()) {
          warnMissingSelection(ctx as PiSwitchCtx);
        }
        return;
      }

      const { provider, modelId, source } = target;
      if (!registerModels(provider, [modelId])) return;
      const model = findRegisteredModel(ctx, provider.piName, modelId);
      if (!model) return;

      // Already on the desired model (Pi restore succeeded) — status only.
      const active = (ctx as PiSwitchCtx).model;
      if (
        active?.provider === provider.piName &&
        active?.id === modelId
      ) {
        ctx.ui?.setStatus?.(
          "pi-switch",
          `${modelId} @ ${provider.appType}/${provider.displayName}`,
        );
        return;
      }

      const activated = await pi.setModel(model as never);
      if (!activated) return;

      // Selection path may normalize [1M] tags; session path is runtime-only
      // so continue/resume does not clobber the user's default selection.
      if (source === "selection") {
        const current = rt.state.readSelection();
        if (current && modelId !== current.model) {
          rt.state.saveSelection({
            ...current,
            model: modelId,
            tab: current.tab ?? provider.appType,
            appType: current.appType ?? provider.appType,
            provider: provider.piName,
          });
        }
      }
      ctx.ui?.setStatus?.(
        "pi-switch",
        `${modelId} @ ${provider.appType}/${provider.displayName}`,
      );
    });
  };

  const activate = async (
    target: SwitchTarget,
    ctx: PiSwitchCtx,
  ): Promise<ActivationResult> => {
    const { provider, modelId } = target;
    const start = initialStages();
    let registered = false;
    try {
      registered = register(provider, modelId);
    } catch (error) {
      const message = formatError(error);
      return {
        kind: "failed",
        failedStage: "providerRegistration",
        error: message,
        stages: { ...start, providerRegistration: failed(message) },
      };
    }
    if (!registered) {
      const message = provider.parseError ?? "cannot register provider";
      return {
        kind: "failed",
        failedStage: "providerRegistration",
        error: message,
        stages: { ...start, providerRegistration: failed(message) },
      };
    }

    const registeredStages: ActivationStages = {
      ...start,
      providerRegistration: SUCCEEDED,
    };

    const model = findRegisteredModel(ctx, provider.piName, modelId);
    if (!model) {
      const message = `model not found after register: ${provider.piName} / ${modelId}`;
      return {
        kind: "failed",
        failedStage: "providerRegistration",
        error: message,
        stages: { ...registeredStages, providerRegistration: failed(message) },
      };
    }

    let activated = false;
    try {
      activated = await pi.setModel(model as never);
    } catch (error) {
      const message = formatError(error);
      return {
        kind: "failed",
        failedStage: "modelSwitch",
        error: message,
        stages: { ...registeredStages, modelSwitch: failed(message) },
      };
    }
    if (!activated) {
      const message = `setModel failed: ${provider.piName} / ${modelId}`;
      return {
        kind: "failed",
        failedStage: "modelSwitch",
        error: message,
        stages: { ...registeredStages, modelSwitch: failed(message) },
      };
    }

    const previousNames = rt.registeredPsNames;
    const cleanupErrors: string[] = [];
    const retainedNames: string[] = [];
    if (pi.unregisterProvider) {
      for (const name of previousNames) {
        if (name === provider.piName) continue;
        try {
          pi.unregisterProvider(name);
        } catch (error) {
          retainedNames.push(name);
          cleanupErrors.push(`${name}: ${formatError(error)}`);
        }
      }
    } else {
      retainedNames.push(...previousNames.filter((name) => name !== provider.piName));
    }
    rt.registeredPsNames = [...new Set([provider.piName, ...retainedNames])];

    const providerCleanup: ActivationStageResult = cleanupErrors.length
      ? failed(cleanupErrors.join("; "))
      : retainedNames.length
        ? skipped("unregisterProvider is unavailable; old registrations were retained")
        : SUCCEEDED;
    const activatedStages: ActivationStages = {
      ...registeredStages,
      modelSwitch: SUCCEEDED,
      providerCleanup,
    };

    if (target.commit === "runtime-only") {
      return {
        kind: "activated",
        stages: {
          ...activatedStages,
          selectionPersistence: skipped("runtime-only activation"),
          recentPersistence: skipped("runtime-only activation"),
        },
      };
    }

    const selection: PiSwitchSelection = {
      dbId: provider.id,
      model: modelId,
      tab: provider.appType,
      appType: provider.appType,
      provider: provider.piName,
    };
    const persisted = rt.state.saveSelection(selection);

    const recentWritten = rt.state.recordRecent({
      dbId: provider.id,
      model: modelId,
      // Composite identity (#16): appType-less recents dedupe wrong in /ps.
      appType: provider.appType,
    });
    if (!recentWritten.ok && rt.config.debug) {
      console.warn("[pi-switch] write recent failed:", recentWritten.error);
    }

    return {
      kind: "activated",
      stages: {
        ...activatedStages,
        selectionPersistence: persisted.ok
          ? SUCCEEDED
          : failed(persisted.error ?? "unknown selection persistence error"),
        recentPersistence: recentWritten.ok
          ? SUCCEEDED
          : failed(recentWritten.error ?? "unknown recent persistence error"),
      },
    };
  };

  return { install, activate };
}
