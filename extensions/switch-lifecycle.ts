import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

export type ActivationResult =
  | { kind: "failed"; error: string }
  | {
      kind: "activated";
      persistence: "saved" | "skipped" | "failed";
      persistenceError?: string;
    };

export interface SwitchLifecycle {
  install(): void;
  activate(target: SwitchTarget, ctx: PiSwitchCtx): Promise<ActivationResult>;
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
    const selection = rt.state.readOrMigrateSelection(providers);

    if (selection) {
      const provider = providers.find((item) => item.id === selection.dbId);
      if (provider && isSwitchable(provider)) {
        if (register(provider, selection.model)) {
          rt.registeredPsNames = [provider.piName];
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
        (item) => item.id === current.dbId,
      );
      if (!provider || !isSwitchable(provider)) {
        warnMissingSelection(ctx as PiSwitchCtx);
        return;
      }

      if (!register(provider, current.model)) return;
      rt.registeredPsNames = [provider.piName];
      const model = findRegisteredModel(ctx, provider.piName, current.model);
      if (!model) return;
      const activated = await pi.setModel(model as never);
      if (activated) {
        ctx.ui?.setStatus?.(
          "pi-switch",
          `${current.model} @ ${provider.appType}/${provider.displayName}`,
        );
      }
    });
  };

  const activate = async (
    target: SwitchTarget,
    ctx: PiSwitchCtx,
  ): Promise<ActivationResult> => {
    const { provider, modelId } = target;
    if (!register(provider, modelId)) {
      return {
        kind: "failed",
        error: provider.parseError ?? "cannot register provider",
      };
    }

    const model = findRegisteredModel(ctx, provider.piName, modelId);
    if (!model) {
      return {
        kind: "failed",
        error: `model not found after register: ${provider.piName} / ${modelId}`,
      };
    }

    const activated = await pi.setModel(model as never);
    if (!activated) {
      return {
        kind: "failed",
        error: `setModel failed: ${provider.piName} / ${modelId}`,
      };
    }

    const previousNames = rt.registeredPsNames;
    if (pi.unregisterProvider) {
      for (const name of previousNames) {
        if (name === provider.piName) continue;
        try {
          pi.unregisterProvider(name);
        } catch {
          // Cleanup is best-effort after activation has committed.
        }
      }
    }
    rt.registeredPsNames = [provider.piName];

    if (target.commit === "runtime-only") {
      return { kind: "activated", persistence: "skipped" };
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

    return persisted.ok
      ? { kind: "activated", persistence: "saved" }
      : {
          kind: "activated",
          persistence: "failed",
          persistenceError: persisted.error,
        };
  };

  return { install, activate };
}
