/**
 * Repair pipeline + Recipe 1 reasoning=false (issue #46 / ticket 4).
 * External behavior only; transport + config store injected — zero network.
 */
import { describe, expect, test } from "bun:test";
import {
  buildRepairPlan,
  matchRepairRecipes,
  runRepair,
  type NormalizedProbeRunEvidence,
  type ProbeRequest,
  type ProbeTarget,
  type ProbeTransport,
  type ProbeTransportResult,
  type RepairConfigStore,
  type RepairPlan,
} from "../src/probe/index.ts";

const target = {
  provider: "ps-claude-relay",
  modelId: "claude-sonnet-probe",
  reasoning: true as boolean | undefined,
};

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

/** Evidence where reasoning contract was rejected for unsupported param. */
function reasoningRejectedEvidence(): NormalizedProbeRunEvidence {
  return {
    target: { ...target },
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
    budget: {
      maxRequests: 9,
      used: 2,
      maxTokens: 32,
      timeoutMs: 15_000,
    },
    capturedAt: "2026-08-04T00:00:00.000Z",
  };
}

function unknownFailureEvidence(): NormalizedProbeRunEvidence {
  return {
    target: { ...target },
    stages: [
      {
        contract: "basic",
        status: "fail",
        category: "unknown",
        signatureId: "unknown",
        allowedHeaderNames: [],
        summary: "HTTP 418: client error",
        requestCount: 1,
        httpStatus: 418,
      },
      {
        contract: "reasoning",
        status: "stopped",
        category: "unknown",
        signatureId: "stopped",
        allowedHeaderNames: [],
        summary: "stopped: previous stage failed",
        requestCount: 0,
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
    requestCount: 1,
    budget: {
      maxRequests: 9,
      used: 1,
      maxTokens: 32,
      timeoutMs: 15_000,
    },
    capturedAt: "2026-08-04T00:00:00.000Z",
  };
}

function memoryConfigStore(options?: {
  initialVersion?: string;
  onCommit?: (input: {
    expectedVersion: string;
    patch: unknown;
  }) =>
    | { ok: true; version: string }
    | { ok: false; reason: "conflict" | "error"; message?: string };
}): {
  store: RepairConfigStore;
  commits: Array<{ expectedVersion: string; patch: unknown }>;
  version: string;
} {
  let version = options?.initialVersion ?? "v1";
  const commits: Array<{ expectedVersion: string; patch: unknown }> = [];
  const store: RepairConfigStore = {
    read: () => ({ version }),
    commit: (input) => {
      commits.push({ expectedVersion: input.expectedVersion, patch: input.patch });
      if (options?.onCommit) {
        const r = options.onCommit(input);
        if (r.ok) version = r.version;
        return r;
      }
      if (input.expectedVersion !== version) {
        return { ok: false, reason: "conflict", message: "config changed externally" };
      }
      version = `v${commits.length + 1}`;
      return { ok: true, version };
    },
  };
  return { store, commits, get version() { return version; } };
}

describe("matchRepairRecipes / buildRepairPlan (ticket 4)", () => {
  test("Recipe1 matches reasoning_param_rejected → exact-model reasoning=false", () => {
    const evidence = reasoningRejectedEvidence();
    const matches = matchRepairRecipes(evidence);

    expect(matches).toHaveLength(1);
    const m = matches[0]!;
    expect(m.recipeId).toBe("reasoning-false");
    expect(m.signatureId).toBe("reasoning_param_rejected");
    expect(m.sourceContract).toBe("reasoning");
    expect(m.patch.kind).toBe("modelMeta");
    expect(m.patch.scope).toBe("model");
    expect(m.patch.provider).toBe(target.provider);
    if (m.patch.kind === "modelMeta") {
      expect(m.patch.modelId).toBe(target.modelId);
      expect(m.patch.modelMeta).toEqual({ reasoning: false });
    }
    // Exact model only — never provider-level
    expect(m.patch).not.toHaveProperty("providerMeta");
    expect(m.affectedModels).toEqual([target.modelId]);

    const plan = buildRepairPlan(evidence);
    expect(plan.target).toEqual({
      provider: target.provider,
      modelId: target.modelId,
      reasoning: true,
    });
    expect(plan.recipes).toHaveLength(1);
    expect(plan.preview.recipeOrder).toEqual(["reasoning-false"]);
    expect(plan.preview.patches[0]!.scope).toMatch(/model/i);
    expect(plan.preview.patches[0]!.affectedModels).toEqual([target.modelId]);
    expect(plan.preview.target).toContain(target.provider);
    expect(plan.preview.target).toContain(target.modelId);
  });

  test("plan preserves existing fingerprint and compat flags", () => {
    const evidence = reasoningRejectedEvidence();
    evidence.target = {
      ...evidence.target,
      fingerprint: "codex",
      claudeCodeCompat: true,
      geminiToolCompat: true,
    };

    const plan = buildRepairPlan(evidence);
    expect(plan.target).toEqual(evidence.target);
  });

  test("unknown evidence yields no recipe (no guessing)", () => {
    const plan = buildRepairPlan(unknownFailureEvidence());
    expect(plan.recipes).toHaveLength(0);
    expect(plan.preview.recipeOrder).toEqual([]);
  });
});

describe("runRepair pipeline (ticket 4)", () => {
  test("headless mode is rejected without transport or commit", async () => {
    const plan = buildRepairPlan(reasoningRejectedEvidence());
    const { transport, calls } = recordingTransport(() => okText());
    const { store, commits } = memoryConfigStore();

    const outcome = await runRepair({
      mode: "headless",
      confirmed: true,
      plan,
      model: { id: target.modelId },
      transport,
      configStore: store,
    });

    expect(outcome.status).toBe("headless-rejected");
    expect(calls).toHaveLength(0);
    expect(commits).toHaveLength(0);
    expect(outcome.persisted).toBe(false);
  });

  test("unconfirmed plan: zero network and zero persist (plan preview only)", async () => {
    const plan = buildRepairPlan(reasoningRejectedEvidence());
    const { transport, calls } = recordingTransport(() => okText());
    const { store, commits } = memoryConfigStore();

    const outcome = await runRepair({
      mode: "interactive",
      confirmed: false,
      plan,
      model: { id: target.modelId },
      transport,
      configStore: store,
    });

    expect(outcome.status).toBe("needs-confirmation");
    expect(calls).toHaveLength(0);
    expect(commits).toHaveLength(0);
    if (outcome.status === "needs-confirmation") {
      expect(outcome.plan.recipes[0]!.recipeId).toBe("reasoning-false");
      expect(outcome.plan.preview.patches.length).toBeGreaterThan(0);
    }
    expect(outcome.persisted).toBe(false);
  });

  test("no matching recipe: no network, no persist", async () => {
    const plan = buildRepairPlan(unknownFailureEvidence());
    const { transport, calls } = recordingTransport(() => okText());
    const { store, commits } = memoryConfigStore();

    const outcome = await runRepair({
      mode: "interactive",
      confirmed: true,
      plan,
      model: {},
      transport,
      configStore: store,
    });

    expect(outcome.status).toBe("no-recipe");
    expect(calls).toHaveLength(0);
    expect(commits).toHaveLength(0);
    expect(outcome.persisted).toBe(false);
  });

  test("candidate verified twice then CAS commit; session model unchanged; switch action offered", async () => {
    const plan = buildRepairPlan(reasoningRejectedEvidence());
    const { transport, calls } = recordingTransport((req) => {
      // After Recipe1, reasoning is disabled on the in-memory target — engine skips it.
      // Verification uses remaining contracts (basic + tool).
      if (req.contract === "basic") return okText();
      if (req.contract === "tool") return okTool();
      throw new Error(`unexpected contract during verify: ${req.contract}`);
    });
    const { store, commits } = memoryConfigStore({ initialVersion: "cfg-v1" });

    const outcome = await runRepair({
      mode: "interactive",
      confirmed: true,
      plan,
      model: { id: target.modelId },
      transport,
      configStore: store,
    });

    expect(outcome.status).toBe("committed");
    expect(outcome.persisted).toBe(true);
    // Two consecutive verification passes → each runs basic+tool (reasoning skipped)
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((c) => c.contract !== "reasoning" || c.options.reasoning === undefined)).toBe(
      true,
    );
    // Every verify request carries the in-memory candidate target (reasoning=false)
    // so a production transport sees the patched target, not the original plan target.
    expect(calls.every((c) => c.target.reasoning === false)).toBe(true);
    expect(calls.every((c) => c.target.provider === target.provider)).toBe(true);
    // At most one recipe committed
    expect(commits).toHaveLength(1);
    expect(commits[0]!.expectedVersion).toBe("cfg-v1");
    const patch = commits[0]!.patch as {
      kind: string;
      scope: string;
      provider: string;
      modelId: string;
      modelMeta: { reasoning: boolean };
    };
    expect(patch.kind).toBe("modelMeta");
    expect(patch.scope).toBe("model");
    expect(patch.provider).toBe(target.provider);
    expect(patch.modelId).toBe(target.modelId);
    expect(patch.modelMeta).toEqual({ reasoning: false });

    if (outcome.status === "committed") {
      expect(outcome.sessionModelUnchanged).toBe(true);
      expect(outcome.switchAction).toEqual({
        kind: "switch-to-repaired-target",
        target: {
          provider: target.provider,
          modelId: target.modelId,
          reasoning: false,
        },
      });
      expect(outcome.recipe.recipeId).toBe("reasoning-false");
      // Exactly one recipe in the successful outcome
      expect(outcome.plan.recipes.filter((r) => r.recipeId === "reasoning-false")).toHaveLength(1);
    }
  });

  test("verification failure discards candidate: zero persist, no rollback needed", async () => {
    const plan = buildRepairPlan(reasoningRejectedEvidence());
    let n = 0;
    const { transport, calls } = recordingTransport(() => {
      n += 1;
      // First verify attempt fails basic
      if (n === 1) {
        return {
          httpStatus: 200,
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "still broken",
          },
        };
      }
      return okText();
    });
    const { store, commits } = memoryConfigStore();

    const outcome = await runRepair({
      mode: "interactive",
      confirmed: true,
      plan,
      model: {},
      transport,
      configStore: store,
    });

    expect(outcome.status).toBe("verification-failed");
    expect(outcome.persisted).toBe(false);
    expect(commits).toHaveLength(0);
    expect(calls.length).toBeGreaterThan(0);
    if (outcome.status === "verification-failed") {
      expect(outcome.recipe.recipeId).toBe("reasoning-false");
    }
  });

  test("any of the two consecutive passes failing discards candidate", async () => {
    const plan = buildRepairPlan(reasoningRejectedEvidence());
    let pass = 0;
    const { transport } = recordingTransport((req) => {
      if (req.contract === "basic") {
        pass += 1;
        // First full pass ok, second pass fails
        if (pass <= 1) return okText();
        return {
          httpStatus: 500,
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "flaky",
          },
        };
      }
      if (req.contract === "tool") return okTool();
      throw new Error(`unexpected ${req.contract}`);
    });
    const { store, commits } = memoryConfigStore();

    const outcome = await runRepair({
      mode: "interactive",
      confirmed: true,
      plan,
      model: {},
      transport,
      configStore: store,
    });

    expect(outcome.status).toBe("verification-failed");
    expect(commits).toHaveLength(0);
    expect(outcome.persisted).toBe(false);
  });

  test("CAS conflict aborts without overwriting external changes", async () => {
    const plan = buildRepairPlan(reasoningRejectedEvidence());
    const { transport } = recordingTransport((req) => {
      if (req.contract === "basic") return okText();
      if (req.contract === "tool") return okTool();
      throw new Error(`unexpected ${req.contract}`);
    });
    const { store, commits } = memoryConfigStore({
      initialVersion: "v-original",
      onCommit: () => ({
        ok: false,
        reason: "conflict",
        message: "config changed externally",
      }),
    });

    const outcome = await runRepair({
      mode: "interactive",
      confirmed: true,
      plan,
      model: {},
      transport,
      configStore: store,
    });

    expect(outcome.status).toBe("cas-conflict");
    expect(outcome.persisted).toBe(false);
    // Commit was attempted once with the expected version (CAS check), but rejected
    expect(commits).toHaveLength(1);
    expect(commits[0]!.expectedVersion).toBe("v-original");
    if (outcome.status === "cas-conflict") {
      expect(outcome.summary.toLowerCase()).toMatch(/conflict|changed|external/);
    }
  });

  test("candidate only affects in-memory probe target during verify (reasoning off)", async () => {
    const evidence = reasoningRejectedEvidence();
    evidence.target = {
      ...evidence.target,
      fingerprint: "codex",
      claudeCodeCompat: true,
      geminiToolCompat: true,
    };
    const plan = buildRepairPlan(evidence);
    const seenTargets: ProbeTarget[] = [];
    const { transport } = recordingTransport((req) => {
      // Every verify request carries the in-memory candidate target (reasoning=false),
      // never the original plan target (reasoning=true).
      seenTargets.push(req.target);
      expect(req.target.reasoning).toBe(false);
      expect(req.target.fingerprint).toBe("codex");
      expect(req.target.claudeCodeCompat).toBe(true);
      expect(req.target.geminiToolCompat).toBe(true);
      if (req.contract === "basic") return okText();
      if (req.contract === "tool") return okTool();
      throw new Error(`reasoning must not be probed under candidate: ${req.contract}`);
    });
    const { store, commits } = memoryConfigStore();

    const outcome = await runRepair({
      mode: "interactive",
      confirmed: true,
      plan,
      model: {},
      transport,
      configStore: store,
    });

    expect(outcome.status).toBe("committed");
    expect(commits).toHaveLength(1);
    const patch = commits[0]!.patch as { modelMeta: { reasoning: boolean }; scope: string };
    expect(patch.scope).toBe("model");
    expect(patch.modelMeta.reasoning).toBe(false);
    expect(seenTargets.length).toBeGreaterThan(0);
  });

  test("at most one recipe is committed even if plan lists more (first only)", async () => {
    // Manually craft a plan with two recipes to assert isolation
    const base = buildRepairPlan(reasoningRejectedEvidence());
    const plan: RepairPlan = {
      ...base,
      recipes: [
        base.recipes[0]!,
        {
          ...base.recipes[0]!,
          recipeId: "reasoning-false",
          summary: "duplicate should not run",
        },
      ],
      preview: {
        ...base.preview,
        recipeOrder: ["reasoning-false", "reasoning-false"],
      },
    };

    const { transport } = recordingTransport((req) => {
      if (req.contract === "basic") return okText();
      if (req.contract === "tool") return okTool();
      throw new Error(`unexpected ${req.contract}`);
    });
    const { store, commits } = memoryConfigStore();

    const outcome = await runRepair({
      mode: "interactive",
      confirmed: true,
      plan,
      model: {},
      transport,
      configStore: store,
    });

    expect(outcome.status).toBe("committed");
    expect(commits).toHaveLength(1);
  });
});
