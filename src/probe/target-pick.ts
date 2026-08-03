/**
 * Probe Target selection (ticket 8 / #51).
 *
 * Defaults to the current Session Model or saved selection; picker may reselect.
 * Selecting or reselecting a Probe Target never calls setModel — Session Model
 * stays independent from the evaluated target.
 *
 * Unresolvable targets (missing, parseError, not switchable) are rejected with
 * a clear message so callers never probe a broken registration.
 */

import { isSwitchable } from "../parse/index.ts";
import type { CcProvider, PiSwitchSelection } from "../types.ts";
import type { ProbeTarget } from "./types.ts";

/** Where the resolved Probe Target came from. */
export type ProbeTargetSource = "explicit" | "session" | "selection";

/**
 * Picker highlight defaults (mirrors three-level-pick preferred fields).
 * Never activates Session Model.
 */
export interface ProbeTargetPickHint {
  preferredTab?: string;
  lastDbId?: string;
  lastModel?: string;
  activePiName?: string;
}

export type ResolveProbeTargetOk = {
  ok: true;
  target: ProbeTarget;
  provider: CcProvider;
  modelId: string;
  source: ProbeTargetSource;
  /** Defaults for a read-only picker reopen/highlight. */
  highlight: ProbeTargetPickHint;
  /** Always true — this API never switches Session Model. */
  sessionModelUnchanged: true;
};

export type ResolveProbeTargetReason =
  | "not-found"
  | "not-switchable"
  | "parse-error"
  | "missing-model"
  | "no-default";

export type ResolveProbeTargetErr = {
  ok: false;
  reason: ResolveProbeTargetReason;
  message: string;
  provider?: CcProvider;
  requested?: { providerKey?: string; modelId?: string };
};

export type ResolveProbeTargetResult = ResolveProbeTargetOk | ResolveProbeTargetErr;

export type ProbeTargetEnrichment = Pick<
  ProbeTarget,
  "reasoning" | "geminiToolCompat" | "fingerprint" | "claudeCodeCompat"
>;

export interface ExplicitProbeTargetPick {
  /** piName, db id, or displayName. */
  providerKey?: string;
  dbId?: string;
  appType?: string;
  modelId: string;
}

/**
 * Optional setModel spy for tests: pick path must never invoke it.
 * Production callers omit this.
 */
export type OnSetModelSpy = () => void;

export interface ResolveProbeTargetInput {
  providers: CcProvider[];
  /** Explicit picker reselect — highest priority. */
  explicit?: ExplicitProbeTargetPick | null;
  /** Current Session Model (ctx.model). Used only as default highlight/source. */
  sessionModel?: { provider?: string; id?: string } | null;
  /** Saved pi-switch selection. */
  selection?: PiSwitchSelection | null;
  /**
   * Optional enrichment (reasoning / geminiToolCompat) from config.
   * Injected so unit tests stay pure.
   */
  enrichTarget?: (
    provider: CcProvider,
    modelId: string,
  ) => ProbeTargetEnrichment | undefined;
  /**
   * Test-only spy. Must never be called by resolve/select — documents the
   * "never setModel on target pick" contract for external behavior tests.
   */
  onSetModel?: OnSetModelSpy;
}

export interface DefaultProbeTargetHighlightInput {
  providers: CcProvider[];
  sessionModel?: { provider?: string; id?: string } | null;
  selection?: PiSwitchSelection | null;
}

export interface SelectProbeTargetOptions {
  enrichTarget?: ResolveProbeTargetInput["enrichTarget"];
  onSetModel?: OnSetModelSpy;
}

/**
 * Find a provider by piName, id, displayName, or (appType + dbId).
 * Mirrors precheck resolution so probe/repair share one identity rule.
 */
export function findProviderForProbeTarget(
  providers: CcProvider[],
  key: string,
  opts?: { appType?: string; dbId?: string },
): CcProvider | undefined {
  if (opts?.dbId) {
    const byId = providers.find(
      (p) =>
        p.id === opts.dbId &&
        (!opts.appType || p.appType === opts.appType),
    );
    if (byId) return byId;
    // Legacy: first provider with matching dbId when appType omitted.
    const any = providers.find((p) => p.id === opts.dbId);
    if (any) return any;
  }

  const k = key.trim();
  if (!k) return undefined;
  return (
    providers.find((p) => p.piName === k) ??
    providers.find((p) => p.id === k) ??
    providers.find((p) => p.displayName === k)
  );
}

function rejectUnswitchable(
  provider: CcProvider,
  requested?: { providerKey?: string; modelId?: string },
): ResolveProbeTargetErr {
  const detail = provider.parseError?.trim();
  if (detail) {
    return {
      ok: false,
      reason: "parse-error",
      message: `Probe Target not switchable (parseError): ${detail}`,
      provider,
      requested,
    };
  }
  return {
    ok: false,
    reason: "not-switchable",
    message: `Probe Target not switchable: ${provider.appType}/${provider.displayName} (${provider.piName})`,
    provider,
    requested,
  };
}

function buildTarget(
  provider: CcProvider,
  modelId: string,
  enrich?: ResolveProbeTargetInput["enrichTarget"],
): ProbeTarget {
  const base: ProbeTarget = {
    provider: provider.piName,
    modelId,
  };
  const extra = enrich?.(provider, modelId);
  if (!extra) return base;
  return {
    ...base,
    ...(extra.reasoning !== undefined ? { reasoning: extra.reasoning } : {}),
    ...(extra.geminiToolCompat !== undefined
      ? { geminiToolCompat: extra.geminiToolCompat }
      : {}),
    ...(extra.fingerprint !== undefined ? { fingerprint: extra.fingerprint } : {}),
    ...(extra.claudeCodeCompat !== undefined
      ? { claudeCodeCompat: extra.claudeCodeCompat }
      : {}),
  };
}

function highlightFor(
  provider: CcProvider,
  modelId: string,
  opts?: { activePiName?: string; preferredTab?: string },
): ProbeTargetPickHint {
  return {
    preferredTab: opts?.preferredTab ?? provider.appType,
    lastDbId: provider.id,
    lastModel: modelId,
    ...(opts?.activePiName ? { activePiName: opts.activePiName } : {}),
  };
}

function okResult(
  provider: CcProvider,
  modelId: string,
  source: ProbeTargetSource,
  input: ResolveProbeTargetInput,
  highlight: ProbeTargetPickHint,
): ResolveProbeTargetOk {
  return {
    ok: true,
    target: buildTarget(provider, modelId, input.enrichTarget),
    provider,
    modelId,
    source,
    highlight,
    sessionModelUnchanged: true,
  };
}

function resolveFromProvider(
  provider: CcProvider | undefined,
  modelId: string,
  source: ProbeTargetSource,
  input: ResolveProbeTargetInput,
  requested: { providerKey?: string; modelId?: string },
  highlightExtras?: { activePiName?: string; preferredTab?: string },
): ResolveProbeTargetResult {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return {
      ok: false,
      reason: "missing-model",
      message: "Probe Target model id is required",
      provider,
      requested: { ...requested, modelId },
    };
  }
  if (!provider) {
    return {
      ok: false,
      reason: "not-found",
      message: `Probe Target provider not found: ${requested.providerKey ?? "(unknown)"}`,
      requested: { ...requested, modelId: trimmed },
    };
  }
  if (!isSwitchable(provider)) {
    return rejectUnswitchable(provider, { ...requested, modelId: trimmed });
  }
  return okResult(
    provider,
    trimmed,
    source,
    input,
    highlightFor(provider, trimmed, highlightExtras),
  );
}

/**
 * Build default picker highlight from session model and/or saved selection.
 * Does not resolve switchability and never calls setModel.
 */
export function defaultProbeTargetHighlight(
  input: DefaultProbeTargetHighlightInput,
): ProbeTargetPickHint {
  const sessionProviderKey = input.sessionModel?.provider?.trim();
  const sessionModelId = input.sessionModel?.id?.trim();
  if (sessionProviderKey && sessionModelId) {
    const provider = findProviderForProbeTarget(
      input.providers,
      sessionProviderKey,
    );
    if (provider) {
      return highlightFor(provider, sessionModelId, {
        activePiName: sessionProviderKey,
        preferredTab: provider.appType,
      });
    }
    // Session provider not in snapshot — still surface active name for UI.
    return {
      activePiName: sessionProviderKey,
      lastModel: sessionModelId,
      preferredTab: input.selection?.tab ?? input.selection?.appType,
      lastDbId: input.selection?.dbId,
    };
  }

  const sel = input.selection;
  if (sel?.dbId && sel.model?.trim()) {
    const provider = findProviderForProbeTarget(input.providers, sel.dbId, {
      dbId: sel.dbId,
      appType: sel.appType,
    });
    // activePiName is session-only (mirrors three-level-pick); selection
    // drives lastDbId / lastModel / preferredTab without implying Session Model.
    return {
      preferredTab: sel.tab ?? sel.appType ?? provider?.appType,
      lastDbId: sel.dbId,
      lastModel: sel.model.trim(),
    };
  }

  return {};
}

/**
 * Resolve the Probe Target for /ps-probe or /ps-repair.
 * Priority: explicit picker reselect → session model → saved selection.
 * Never calls setModel.
 */
export function resolveProbeTarget(
  input: ResolveProbeTargetInput,
): ResolveProbeTargetResult {
  // Documented contract: pick path must not touch Session Model.
  // onSetModel is a test spy only — we deliberately never call it.

  if (input.explicit) {
    const modelId = input.explicit.modelId;
    const providerKey =
      input.explicit.providerKey?.trim() ||
      input.explicit.dbId?.trim() ||
      "";
    const provider = findProviderForProbeTarget(input.providers, providerKey, {
      dbId: input.explicit.dbId,
      appType: input.explicit.appType,
    });
    return resolveFromProvider(
      provider,
      modelId,
      "explicit",
      input,
      {
        providerKey: providerKey || input.explicit.dbId,
        modelId,
      },
    );
  }

  const sessionProviderKey = input.sessionModel?.provider?.trim();
  const sessionModelId = input.sessionModel?.id?.trim();
  if (sessionProviderKey && sessionModelId) {
    const provider = findProviderForProbeTarget(
      input.providers,
      sessionProviderKey,
    );
    return resolveFromProvider(
      provider,
      sessionModelId,
      "session",
      input,
      { providerKey: sessionProviderKey, modelId: sessionModelId },
      { activePiName: sessionProviderKey },
    );
  }

  const sel = input.selection;
  if (sel?.dbId && sel.model?.trim()) {
    const provider = findProviderForProbeTarget(input.providers, sel.dbId, {
      dbId: sel.dbId,
      appType: sel.appType,
    });
    const providerKey = sel.provider ?? sel.dbId;
    return resolveFromProvider(
      provider,
      sel.model,
      "selection",
      input,
      { providerKey, modelId: sel.model },
      { preferredTab: sel.tab ?? sel.appType },
    );
  }

  return {
    ok: false,
    reason: "no-default",
    message:
      "no default Probe Target: provide an explicit pick, session model, or saved selection",
  };
}

/**
 * Validate a picker selection as a Probe Target (read-only).
 * Same rejection rules as resolve; never calls setModel.
 */
export function selectProbeTarget(
  providers: CcProvider[],
  pick:
    | { provider: CcProvider; modelId: string }
    | { providerKey: string; modelId: string },
  opts: SelectProbeTargetOptions = {},
): ResolveProbeTargetResult {
  const modelId = pick.modelId;
  if ("provider" in pick) {
    return resolveFromProvider(
      pick.provider,
      modelId,
      "explicit",
      {
        providers,
        enrichTarget: opts.enrichTarget,
        onSetModel: opts.onSetModel,
      },
      { providerKey: pick.provider.piName, modelId },
    );
  }
  return resolveProbeTarget({
    providers,
    explicit: { providerKey: pick.providerKey, modelId },
    enrichTarget: opts.enrichTarget,
    onSetModel: opts.onSetModel,
  });
}
