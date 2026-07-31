import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveListedModel } from "../src/models-fetch.ts";
import { isSwitchable } from "../src/parse/index.ts";
import {
  asRegisterApi,
  findRegisteredModel,
  type PiSwitchCtx,
} from "../src/pi-context.ts";
import { registerProvider } from "../src/register.ts";
import type { CcProvider, PiSwitchSelection } from "../src/types.ts";
import type { Runtime } from "./runtime.ts";

export type SwitchTarget = {
  provider: CcProvider;
  modelId: string;
  commit: "selection" | "runtime-only";
};

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
  const register = (provider: CcProvider, modelId: string): boolean =>
    registerProvider(asRegisterApi(pi), provider, [modelId], {
      rules: rt.headerRules,
      ...rt.headerOverrideOpts(provider),
      vars: rt.headerVars(),
      debug: rt.config.debug,
      onReject: rt.rejectSink(),
      modelMetaFor: (id) => rt.modelMetaFor(provider, id),
    });

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

    if (selection) {
      const provider = providers.find(
        (item) =>
          item.id === selection.dbId &&
          (!selection.appType || item.appType === selection.appType),
      );
      if (provider && isSwitchable(provider)) {
        const modelId =
          resolveListedModel(provider.configModels, selection.model) ?? selection.model;
        if (register(provider, modelId)) {
          rt.registeredPsNames = [provider.piName];
          // Persist plain id when selection still holds a filtered [1M] tag.
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
      } else {
        warnMissingSelection();
      }
    }

    pi.on("session_start", async (event, ctx) => {
      if (event.reason !== "startup") return;
      if (rt.lastGoodProviders.length) {
        ctx.ui?.setStatus?.(
          "pi-switch",
          `pi-switch: ${rt.lastGoodProviders.length} providers`,
        );
      }

      const current = rt.state.readSelection();
      if (!current) return;
      const provider = rt.lastGoodProviders.find(
        (item) =>
          item.id === current.dbId &&
          (!current.appType || item.appType === current.appType),
      );
      if (!provider || !isSwitchable(provider)) {
        warnMissingSelection(ctx as PiSwitchCtx);
        return;
      }

      const modelId =
        resolveListedModel(provider.configModels, current.model) ?? current.model;
      if (!register(provider, modelId)) return;
      rt.registeredPsNames = [provider.piName];
      const model = findRegisteredModel(ctx, provider.piName, modelId);
      if (!model) return;
      const activated = await pi.setModel(model as never);
      if (activated) {
        if (modelId !== current.model) {
          rt.state.saveSelection({
            ...current,
            model: modelId,
            tab: current.tab ?? provider.appType,
            appType: current.appType ?? provider.appType,
            provider: provider.piName,
          });
        }
        ctx.ui?.setStatus?.(
          "pi-switch",
          `${modelId} @ ${provider.appType}/${provider.displayName}`,
        );
      }
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
