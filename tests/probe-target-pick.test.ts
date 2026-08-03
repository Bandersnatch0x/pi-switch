/**
 * Probe Target pick + post-success switch action (issue #51 / ticket 8).
 * External behavior only; providers + lifecycle activate injected — zero network.
 * Selecting a Probe Target never calls setModel; only explicit post-repair switch may.
 */
import { describe, expect, test } from "bun:test";
import { isSwitchable } from "../src/parse/index.ts";
import type { CcProvider, PiSwitchSelection } from "../src/types.ts";
import {
  buildRepairPlan,
  defaultProbeTargetHighlight,
  executeRepairSwitchAction,
  hasRepairSwitchAction,
  resolveProbeTarget,
  runRepair,
  selectProbeTarget,
  type LifecycleActivationResult,
  type LifecycleSwitchTarget,
  type ProbeRequest,
  type ProbeTransport,
  type ProbeTransportResult,
  type RepairConfigStore,
  type RepairSwitchAction,
} from "../src/probe/index.ts";
import type { NormalizedProbeRunEvidence } from "../src/probe/index.ts";

function mkProvider(
  partial: Partial<CcProvider> & Pick<CcProvider, "id" | "displayName" | "appType">,
): CcProvider {
  return {
    piName: `ps-${partial.appType}-${partial.id}`,
    api: "anthropic-messages",
    baseUrl: "https://example.com",
    apiKey: "sk-test",
    authHeader: true,
    configModels: ["claude-sonnet-probe", "claude-haiku-probe"],
    meta: {},
    isCurrentInCc: false,
    ...partial,
  };
}

const switchable = mkProvider({
  id: "relay-1",
  displayName: "Claude Relay",
  appType: "claude",
  piName: "ps-claude-relay-1",
});

const other = mkProvider({
  id: "relay-2",
  displayName: "Other Relay",
  appType: "claude",
  piName: "ps-claude-relay-2",
  configModels: ["other-model"],
});

const broken = mkProvider({
  id: "broken",
  displayName: "Broken Relay",
  appType: "claude",
  piName: "ps-claude-broken",
  api: null,
  baseUrl: "",
  apiKey: "",
  parseError: "missing base_url / api_key",
  configModels: ["broken-model"],
});

function okText(text = "probe_ok"): ProbeTransportResult {
  return {
    httpStatus: 200,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    },
  };
}

function okTool(): ProbeTransportResult {
  return {
    httpStatus: 200,
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc1",
          name: "probe_echo",
          arguments: { msg: "probe_ok" },
        },
      ],
      stopReason: "toolUse",
    },
  };
}

function recordingTransport(
  handler: (
    req: ProbeRequest,
    n: number,
  ) => ProbeTransportResult | Promise<ProbeTransportResult>,
): { transport: ProbeTransport; calls: ProbeRequest[] } {
  const calls: ProbeRequest[] = [];
  const transport: ProbeTransport = async (req) => {
    calls.push(req);
    return handler(req, calls.length);
  };
  return { transport, calls };
}

function memoryConfigStore(opts?: { initialVersion?: string }): {
  store: RepairConfigStore;
  commits: Array<{ expectedVersion: string; patch: unknown }>;
} {
  let version = opts?.initialVersion ?? "v1";
  const commits: Array<{ expectedVersion: string; patch: unknown }> = [];
  return {
    commits,
    store: {
      read: () => ({ version }),
      commit: (input) => {
        if (input.expectedVersion !== version) {
          return { ok: false, reason: "conflict" as const };
        }
        commits.push({ expectedVersion: input.expectedVersion, patch: input.patch });
        version = `v${commits.length + 1}`;
        return { ok: true, version };
      },
    },
  };
}

function reasoningRejectedEvidence(
  provider = switchable.piName,
  modelId = "claude-sonnet-probe",
): NormalizedProbeRunEvidence {
  return {
    target: { provider, modelId, reasoning: true },
    stages: [
      {
        contract: "basic",
        status: "pass",
        category: "ok",
        signatureId: "pass",
        allowedHeaderNames: [],
        summary: "basic text response received",
        requestCount: 1,
        httpStatus: 200,
      },
      {
        contract: "reasoning",
        status: "fail",
        category: "protocol",
        signatureId: "reasoning_param_rejected",
        allowedHeaderNames: ["content-type"],
        summary: "HTTP 400: reasoning / thinking parameter not supported",
        requestCount: 1,
        httpStatus: 400,
      },
      {
        contract: "tool",
        status: "stopped",
        category: "unknown",
        signatureId: "stopped",
        allowedHeaderNames: [],
        summary: "stopped: previous stage failed",
        requestCount: 0,
      },
    ],
    ok: false,
    stoppedReason: "failure",
    requestCount: 2,
    budget: { maxRequests: 9, used: 2, maxTokens: 32, timeoutMs: 15_000 },
    capturedAt: "2026-08-04T00:00:00.000Z",
  };
}

describe("defaultProbeTargetHighlight + resolveProbeTarget (ticket 8)", () => {
  test("defaults highlight to saved selection (lastDbId / lastModel / preferredTab)", () => {
    const selection: PiSwitchSelection = {
      dbId: switchable.id,
      model: "claude-haiku-probe",
      tab: "claude",
      appType: "claude",
      provider: switchable.piName,
    };
    const highlight = defaultProbeTargetHighlight({
      providers: [switchable, other],
      selection,
    });
    expect(highlight.lastDbId).toBe(switchable.id);
    expect(highlight.lastModel).toBe("claude-haiku-probe");
    expect(highlight.preferredTab).toBe("claude");
    expect(highlight.activePiName).toBeUndefined();
  });

  test("defaults highlight prefers session model when present", () => {
    const selection: PiSwitchSelection = {
      dbId: other.id,
      model: "other-model",
      appType: "claude",
    };
    const highlight = defaultProbeTargetHighlight({
      providers: [switchable, other],
      selection,
      sessionModel: { provider: switchable.piName, id: "claude-sonnet-probe" },
    });
    expect(highlight.activePiName).toBe(switchable.piName);
    expect(highlight.lastDbId).toBe(switchable.id);
    expect(highlight.lastModel).toBe("claude-sonnet-probe");
  });

  test("resolve defaults to session model without calling setModel", () => {
    let setModelCalls = 0;
    const result = resolveProbeTarget({
      providers: [switchable, other],
      sessionModel: { provider: switchable.piName, id: "claude-sonnet-probe" },
      selection: { dbId: other.id, model: "other-model", appType: "claude" },
      // Injected spy — pick path must never invoke it.
      onSetModel: () => {
        setModelCalls += 1;
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("session");
    expect(result.target).toEqual({
      provider: switchable.piName,
      modelId: "claude-sonnet-probe",
    });
    expect(result.provider.id).toBe(switchable.id);
    expect(result.sessionModelUnchanged).toBe(true);
    expect(setModelCalls).toBe(0);
  });

  test("resolve falls back to saved selection when session missing", () => {
    const result = resolveProbeTarget({
      providers: [switchable, other],
      selection: {
        dbId: other.id,
        model: "other-model",
        appType: "claude",
        provider: other.piName,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("selection");
    expect(result.target.provider).toBe(other.piName);
    expect(result.target.modelId).toBe("other-model");
    expect(result.highlight.lastDbId).toBe(other.id);
  });

  test("picker reselect (explicit) overrides session/selection without setModel", () => {
    let setModelCalls = 0;
    const result = resolveProbeTarget({
      providers: [switchable, other],
      sessionModel: { provider: switchable.piName, id: "claude-sonnet-probe" },
      selection: { dbId: switchable.id, model: "claude-sonnet-probe", appType: "claude" },
      explicit: { providerKey: other.piName, modelId: "other-model" },
      onSetModel: () => {
        setModelCalls += 1;
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("explicit");
    expect(result.target.provider).toBe(other.piName);
    expect(result.target.modelId).toBe("other-model");
    expect(result.sessionModelUnchanged).toBe(true);
    expect(setModelCalls).toBe(0);
  });

  test("selectProbeTarget accepts a switchable picker pick without setModel", () => {
    let setModelCalls = 0;
    const result = selectProbeTarget(
      [switchable, other],
      { provider: other, modelId: "other-model" },
      {
        onSetModel: () => {
          setModelCalls += 1;
        },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("explicit");
    expect(result.target).toEqual({
      provider: other.piName,
      modelId: "other-model",
    });
    expect(setModelCalls).toBe(0);
  });

  test("enrichTarget fills reasoning / geminiToolCompat on resolved Probe Target", () => {
    const result = resolveProbeTarget({
      providers: [switchable],
      explicit: { providerKey: switchable.piName, modelId: "claude-sonnet-probe" },
      enrichTarget: () => ({ reasoning: true, geminiToolCompat: false }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.reasoning).toBe(true);
    expect(result.target.geminiToolCompat).toBe(false);
  });

  test("rejects parseError / unswitchable target with clear message", () => {
    expect(isSwitchable(broken)).toBe(false);
    const result = resolveProbeTarget({
      providers: [switchable, broken],
      explicit: { providerKey: broken.piName, modelId: "broken-model" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason === "parse-error" || result.reason === "not-switchable").toBe(true);
    expect(result.message.toLowerCase()).toMatch(/parse|switch|不可|missing|base_url|api_key/);
    expect(result.provider?.id).toBe(broken.id);
    expect(result.message).toContain("missing base_url / api_key");
  });

  test("rejects unknown provider with not-found message", () => {
    const result = resolveProbeTarget({
      providers: [switchable],
      explicit: { providerKey: "ps-missing", modelId: "x" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-found");
    expect(result.message).toMatch(/not found|unknown|找不到|不可解析/i);
  });

  test("rejects when no default (no session, no selection, no explicit)", () => {
    const result = resolveProbeTarget({
      providers: [switchable],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-default");
    expect(result.message.length).toBeGreaterThan(0);
  });

  test("rejects empty modelId", () => {
    const result = selectProbeTarget([switchable], {
      provider: switchable,
      modelId: "  ",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing-model");
  });
});

describe("post-success switch action (ticket 8)", () => {
  test("repair commit offers switch-to-repaired-target without activating lifecycle", async () => {
    const plan = buildRepairPlan(reasoningRejectedEvidence());
    const { transport } = recordingTransport((req) => {
      if (req.contract === "basic") return okText();
      if (req.contract === "tool") return okTool();
      throw new Error(`unexpected contract: ${req.contract}`);
    });
    const { store } = memoryConfigStore();
    const activateCalls: LifecycleSwitchTarget[] = [];

    const outcome = await runRepair({
      mode: "interactive",
      confirmed: true,
      plan,
      model: {},
      transport,
      configStore: store,
    });

    expect(outcome.status).toBe("committed");
    expect(hasRepairSwitchAction(outcome)).toBe(true);
    if (outcome.status !== "committed") return;
    expect(outcome.sessionModelUnchanged).toBe(true);
    expect(outcome.switchAction).toEqual({
      kind: "switch-to-repaired-target",
      target: {
        provider: switchable.piName,
        modelId: "claude-sonnet-probe",
        reasoning: false,
      },
    });
    // Commit itself never activates lifecycle / setModel
    expect(activateCalls).toHaveLength(0);
  });

  test("executeRepairSwitchAction routes through existing lifecycle activate", async () => {
    const action: RepairSwitchAction = {
      kind: "switch-to-repaired-target",
      target: {
        provider: switchable.piName,
        modelId: "claude-sonnet-probe",
        reasoning: false,
      },
    };
    const activateCalls: LifecycleSwitchTarget[] = [];
    const activation: LifecycleActivationResult = {
      kind: "activated",
      stages: { modelSwitch: { status: "succeeded" } },
    };

    const result = await executeRepairSwitchAction(action, {
      providers: [switchable, other],
      activate: async (target) => {
        activateCalls.push(target);
        return activation;
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(activateCalls).toHaveLength(1);
    expect(activateCalls[0]!.provider.piName).toBe(switchable.piName);
    expect(activateCalls[0]!.modelId).toBe("claude-sonnet-probe");
    expect(activateCalls[0]!.commit).toBe("selection");
    expect(result.summary).toMatch(/switched|切换|session/i);
    expect(result.provider.id).toBe(switchable.id);
  });

  test("executeRepairSwitchAction rejects unswitchable repaired target", async () => {
    const action: RepairSwitchAction = {
      kind: "switch-to-repaired-target",
      target: { provider: broken.piName, modelId: "broken-model" },
    };
    let activateCalls = 0;
    const result = await executeRepairSwitchAction(action, {
      providers: [broken],
      activate: async () => {
        activateCalls += 1;
        return { kind: "activated" };
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason === "parse-error" || result.reason === "not-switchable").toBe(true);
    expect(result.message).toContain("missing base_url / api_key");
    expect(activateCalls).toBe(0);
  });

  test("executeRepairSwitchAction surfaces lifecycle activate failure", async () => {
    const action: RepairSwitchAction = {
      kind: "switch-to-repaired-target",
      target: { provider: switchable.piName, modelId: "claude-sonnet-probe" },
    };
    const result = await executeRepairSwitchAction(action, {
      providers: [switchable],
      activate: async () => ({
        kind: "failed",
        failedStage: "modelSwitch",
        error: "setModel failed: ps-claude-relay-1 / claude-sonnet-probe",
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("activate-failed");
    expect(result.message).toMatch(/setModel failed/);
  });

  test("selectProbeTarget never invokes lifecycle activate", async () => {
    let activateCalls = 0;
    const pick = selectProbeTarget([switchable], {
      providerKey: switchable.piName,
      modelId: "claude-sonnet-probe",
    });
    expect(pick.ok).toBe(true);

    // Contrast: only executeRepairSwitchAction may activate
    await executeRepairSwitchAction(
      {
        kind: "switch-to-repaired-target",
        target: { provider: switchable.piName, modelId: "claude-sonnet-probe" },
      },
      {
        providers: [switchable],
        activate: async () => {
          activateCalls += 1;
          return { kind: "activated" };
        },
      },
    );
    expect(activateCalls).toBe(1);
  });
});
