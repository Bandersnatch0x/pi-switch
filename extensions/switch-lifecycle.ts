import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveListedModel } from "../src/models-fetch.ts";
import { isSwitchable } from "../src/parse/index.ts";
import {
  asRegisterApi,
  findRegisteredModel,
  type PiSwitchCtx,
} from "../src/pi-context.ts";
import { registerProvider } from "../src/register.ts";
import type {
  CcProvider,
  PiSwitchConfig,
  PiSwitchSelection,
  RecentEntry,
  SessionModelStrategy,
} from "../src/types.ts";
import type { IdentityMigrationSummary } from "../src/migration.ts";
import type { LocalState } from "../src/local-state.ts";
import type { ProviderSnapshotResult } from "../src/provider-snapshot.ts";
import type { RegistrationOperations } from "./registration-operations.ts";
import { matchProvider } from "./runtime-facades.ts";

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

export interface SwitchLifecycleRuntime {
  config: PiSwitchConfig;
  lastGoodProviders: CcProvider[];
  migrateIdentity(providers: CcProvider[]): IdentityMigrationSummary | undefined;
  refreshSnapshot(): ProviderSnapshotResult;
  registeredPsNames: string[];
  registration: RegistrationOperations;
  scheduleModelsDevRefresh(modelId: string): void;
  state: LocalState;
  warnedMissingDbId: boolean;
}

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

function resolveModelId(provider: CcProvider, preferred: string): string {
  return resolveListedModel(provider.configModels, preferred) ?? preferred;
}

/**
 * Resolve target model for session_start events (startup/resume/fork/reload).
 *
 * Why this exists: the session branch used to win unconditionally, so resumed
 * sessions and subagent forks ignored a newer /ps selection. The strategy makes
 * the saved selection authoritative by default while keeping the old behavior
 * reachable ("session-first"). Pure so the strategy matrix is directly testable
 * without faking a Runtime.
 */
export type SessionTarget = {
  provider: CcProvider;
  modelId: string;
  source: "session" | "selection";
};

/** Resolve all usable targets in the order dictated by the configured strategy. */
export function resolveSessionTargets(
  strategy: SessionModelStrategy | undefined,
  providers: CcProvider[],
  selection: { dbId: string; model: string; appType?: string } | undefined,
  sessionModel: { provider: string; modelId: string } | undefined,
): SessionTarget[] {
  const actualStrategy = strategy ?? "selection-first";
  const sources =
    actualStrategy === "selection-only"
      ? (["selection"] as const)
      : actualStrategy === "session-first"
        ? (["session", "selection"] as const)
        : (["selection", "session"] as const);
  const targets: SessionTarget[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    const target =
      source === "selection"
        ? selection
          ? (() => {
              const provider = matchProvider(providers, {
                dbId: selection.dbId,
                appType: selection.appType,
              });
              return provider && isSwitchable(provider)
                ? {
                    provider,
                    modelId: resolveModelId(provider, selection.model),
                    source: "selection" as const,
                  }
                : undefined;
            })()
          : undefined
        : sessionModel
          ? (() => {
              const provider = matchProvider(providers, {
                piName: sessionModel.provider,
              });
              return provider && isSwitchable(provider)
                ? {
                    provider,
                    modelId: resolveModelId(provider, sessionModel.modelId),
                    source: "session" as const,
                  }
                : undefined;
            })()
          : undefined;
    if (!target) continue;
    const key = `${target.provider.piName}\0${target.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

/** Backwards-compatible first-target resolver for callers that only need a pick. */
export function resolveSessionTarget(
  strategy: SessionModelStrategy | undefined,
  providers: CcProvider[],
  selection: { dbId: string; model: string; appType?: string } | undefined,
  sessionModel: { provider: string; modelId: string } | undefined,
): SessionTarget | undefined {
  return resolveSessionTargets(strategy, providers, selection, sessionModel)[0];
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

export type ProbeTargetResult =
  | { kind: "ready"; source: "existing" | "registered"; model: unknown }
  | { kind: "failed"; error: string };

export interface SwitchLifecycle {
  install(): void;
  activate(target: SwitchTarget, ctx: PiSwitchCtx): Promise<ActivationResult>;
  ensureProbeTarget(
    ctx: PiSwitchCtx,
    provider: CcProvider,
    modelId: string,
  ): ProbeTargetResult;
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

/**
 * Stage recorder: every ActivationStages field is set exactly once on the
 * success path. activate() used to rebuild the stages object with hand
 * spreads at seven return points; adding a sixth stage and missing one spread
 * silently reported skipped("not attempted"). Now activated() throws instead.
 */
function stageRecorder() {
  const stages = initialStages();
  const recorded = new Set<keyof ActivationStages>();
  return {
    set(stage: keyof ActivationStages, result: ActivationStageResult): void {
      stages[stage] = result;
      recorded.add(stage);
    },
    /** Early-exit failure: untouched stages keep their initial semantics. */
    failure(
      stage: "providerRegistration" | "modelSwitch",
      message: string,
    ): ActivationResult {
      stages[stage] = failed(message);
      return { kind: "failed", failedStage: stage, error: message, stages: { ...stages } };
    },
    activated(): ActivationResult {
      const missing = (Object.keys(stages) as (keyof ActivationStages)[]).filter(
        (stage) => !recorded.has(stage),
      );
      if (missing.length) {
        throw new Error(
          `activate() finished without recording stages: ${missing.join(", ")}`,
        );
      }
      return { kind: "activated", stages: { ...stages } };
    },
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSwitchLifecycle(
  pi: ExtensionAPI,
  rt: SwitchLifecycleRuntime,
): SwitchLifecycle {
  type RegistrationOutcome =
    | { kind: "registered" }
    | { kind: "failed"; error: string };

  const registerModels = (
    provider: CcProvider,
    modelIds: string[],
  ): RegistrationOutcome => {
    const ids = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))];
    if (!ids.length) return { kind: "failed", error: "no model ids" };
    try {
      const result = registerProvider(
        asRegisterApi(pi),
        provider,
        ids,
        rt.registration.optionsFor(provider),
      );
      if (result.kind === "skipped") {
        // A #63 skip on a *switchable* provider means "no trusted maxTokens
        // authority yet". Still schedule the models.dev refresh: the
        // success-only hook below (#39) can never fire for these ids, so
        // without this the model stays uncached — and unregisterable — on
        // every launch. Non-switchable providers (parse errors, unsupported
        // api) gain nothing from models.dev, so they skip the refresh too.
        if (isSwitchable(provider)) {
          for (const id of ids) rt.scheduleModelsDevRefresh(id);
        }
        return { kind: "failed", error: result.error };
      }
      // Fire-and-forget models.dev refresh after successful registration (issue #39).
      for (const id of result.modelIds) rt.scheduleModelsDevRefresh(id);
      return { kind: "registered" };
    } catch (error) {
      return { kind: "failed", error: formatError(error) };
    }
  };

  const registerSessionModels = (
    provider: CcProvider,
    modelIds: string[],
  ): RegistrationOutcome => {
    const result = registerModels(provider, modelIds);
    if (result.kind === "registered") {
      if (!rt.registeredPsNames.includes(provider.piName)) {
        rt.registeredPsNames = [...rt.registeredPsNames, provider.piName];
      }
    }
    return result;
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
   * Resolve target model for session_start events.
   * Delegates to the exported pure function for testability.
   */
  const resolveSessionTargetsInternal = (
    ctx: PiSwitchCtx,
  ): SessionTarget[] => {
    const providers = rt.lastGoodProviders;
    const strategy = rt.config.sessionModelStrategy;
    const selection = rt.state.readSelection();
    const sessionModel = sessionModelFromBranch(ctx.sessionManager?.getBranch?.());

    return resolveSessionTargets(strategy, providers, selection, sessionModel);
  };

  // Suppress model_select persistence for pi-switch-owned switches. Native
  // user-driven switches are still persisted by the listener below.
  let internalModelSwitchDepth = 0;

  /**
   * Shared register → find → setModel sequence for session_start and activate.
   * Both paths used to hand-roll this trio with drifting error handling; the
   * discriminated result lets each caller map outcomes to its own reporting
   * (stage recorder in activate, ui.notify in session_start).
   */
  const ensureModelActive = async (
    provider: CcProvider,
    modelId: string,
    ctx: PiSwitchCtx,
    opts: {
      register: (provider: CcProvider, modelIds: string[]) => RegistrationOutcome;
      /** Short-circuit when ctx.model already matches (session restore). */
      skipIfActive?: boolean;
    },
  ): Promise<
    | { kind: "activated" }
    | { kind: "already-active" }
    | { kind: "registration-failed"; error: string }
    | { kind: "model-not-found"; error: string }
    | { kind: "switch-failed"; error: string }
  > => {
    const registration = opts.register(provider, [modelId]);
    if (registration.kind !== "registered") {
      return { kind: "registration-failed", error: registration.error };
    }
    const model = findRegisteredModel(ctx, provider.piName, modelId);
    if (!model) {
      return {
        kind: "model-not-found",
        error: `model not found after register: ${provider.piName} / ${modelId}`,
      };
    }
    if (opts.skipIfActive) {
      const active = ctx.model;
      if (active?.provider === provider.piName && active?.id === modelId) {
        return { kind: "already-active" };
      }
    }
    let activated = false;
    internalModelSwitchDepth += 1;
    try {
      activated = await pi.setModel(model as never);
    } catch (error) {
      return { kind: "switch-failed", error: formatError(error) };
    } finally {
      internalModelSwitchDepth -= 1;
    }
    if (!activated) {
      return {
        kind: "switch-failed",
        error: `setModel failed: ${provider.piName} / ${modelId}`,
      };
    }
    return { kind: "activated" };
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
    // Pre-registration is best-effort cache warming. Only the selection target
    // deserves a launch-time warning — a stale recent entry (provider deleted
    // or #63-unregisterable) would otherwise nag on every startup.
    const selectionProviderId = selection
      ? matchProvider(providers, {
          dbId: selection.dbId,
          appType: selection.appType,
        })?.id
      : undefined;
    for (const { provider, modelIds } of targets.values()) {
      const result = registerSessionModels(provider, [...modelIds]);
      if (result.kind === "failed") {
        if (provider.id === selectionProviderId || rt.config.debug) {
          console.warn(
            `[pi-switch] install registration failed: ${provider.piName}: ${result.error}`,
          );
        }
      }
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

    // Pi's native /model and cycle commands emit this event after a successful
    // switch. Persist only user-driven changes; restore is intentionally
    // ignored so session_start strategy resolution remains authoritative.
    pi.on("model_select", (event, _ctx) => {
      if (internalModelSwitchDepth > 0 || event.source === "restore") return;
      const model = event.model;
      const provider = rt.lastGoodProviders.find((item) => item.piName === model.provider);
      if (!provider || !isSwitchable(provider)) return;
      const persisted = rt.state.saveSelection({
        dbId: provider.id,
        model: model.id,
        tab: provider.appType,
        appType: provider.appType,
        provider: provider.piName,
      });
      if (!persisted.ok && rt.config.debug) {
        console.warn("[pi-switch] native model selection write failed:", persisted.error);
      }
    });

    pi.on("session_start", async (event, ctx) => {
      if (!SESSION_ACTIVATE_REASONS.has(event.reason)) return;
      if (rt.lastGoodProviders.length) {
        ctx.ui?.setStatus?.(
          "pi-switch",
          `pi-switch: ${rt.lastGoodProviders.length} providers`,
        );
      }

      const targets = resolveSessionTargetsInternal(ctx as PiSwitchCtx);
      if (!targets.length) {
        // Only warn when a selection exists but is unusable; bare new sessions
        // with no selection are fine.
        if (rt.state.readSelection()) {
          warnMissingSelection(ctx as PiSwitchCtx);
        }
        return;
      }

      let lastFailure: string | undefined;
      for (const { provider, modelId, source } of targets) {
        const outcome = await ensureModelActive(
          provider,
          modelId,
          ctx as PiSwitchCtx,
          { register: registerSessionModels, skipIfActive: true },
        );
        if (outcome.kind === "activated" || outcome.kind === "already-active") {
          // Selection path may normalize [1M] tags; session path is runtime-only
          // so continue/resume does not clobber the user's default selection.
          if (outcome.kind === "activated" && source === "selection") {
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
          return;
        }
        lastFailure = outcome.error;
      }
      if (lastFailure) {
        ctx.ui?.notify?.(`pi-switch: session model activation failed: ${lastFailure}`, "error");
      }
    });
  };

  const activate = async (
    target: SwitchTarget,
    ctx: PiSwitchCtx,
  ): Promise<ActivationResult> => {
    const { provider, modelId } = target;
    const stages = stageRecorder();

    const outcome = await ensureModelActive(provider, modelId, ctx, {
      register: registerModels,
    });
    // Map the shared sequence's outcome onto the stage recorder.
    switch (outcome.kind) {
      case "registration-failed":
      case "model-not-found":
        // Registered-but-unfindable also surfaces as a providerRegistration
        // failure: callers only see stages, and "we couldn't hand Pi a usable
        // model" is a registration problem regardless of which step tripped.
        return stages.failure("providerRegistration", outcome.error);
      case "switch-failed":
        // Registration itself succeeded before setModel failed — record it,
        // or the report claims skipped("not attempted") for a stage that ran.
        stages.set("providerRegistration", SUCCEEDED);
        return stages.failure("modelSwitch", outcome.error);
      case "already-active":
      case "activated":
        break;
    }
    stages.set("providerRegistration", SUCCEEDED);
    stages.set("modelSwitch", SUCCEEDED);

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

    stages.set(
      "providerCleanup",
      cleanupErrors.length
        ? failed(cleanupErrors.join("; "))
        : retainedNames.length
          ? skipped("unregisterProvider is unavailable; old registrations were retained")
          : SUCCEEDED,
    );

    if (target.commit === "runtime-only") {
      stages.set("selectionPersistence", skipped("runtime-only activation"));
      stages.set("recentPersistence", skipped("runtime-only activation"));
      return stages.activated();
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

    stages.set(
      "selectionPersistence",
      persisted.ok
        ? SUCCEEDED
        : failed(persisted.error ?? "unknown selection persistence error"),
    );
    stages.set(
      "recentPersistence",
      recentWritten.ok
        ? SUCCEEDED
        : failed(recentWritten.error ?? "unknown recent persistence error"),
    );
    return stages.activated();
  };

  const ensureProbeTarget = (
    ctx: PiSwitchCtx,
    provider: CcProvider,
    modelId: string,
  ): ProbeTargetResult => {
    const existing = findRegisteredModel(ctx, provider.piName, modelId);
    if (existing) return { kind: "ready", source: "existing", model: existing };

    const api = asRegisterApi(pi);
    if (typeof api.registerProvider !== "function") {
      return { kind: "failed", error: "registerProvider is unavailable" };
    }

    const registered = registerModels(provider, [modelId]);
    if (registered.kind !== "registered") {
      return { kind: "failed", error: registered.error };
    }

    const model = findRegisteredModel(ctx, provider.piName, modelId);
    return model
      ? { kind: "ready", source: "registered", model }
      : {
          kind: "failed",
          error: `model not found after register: ${provider.piName} / ${modelId}`,
        };
  };

  return { install, activate, ensureProbeTarget };
}
