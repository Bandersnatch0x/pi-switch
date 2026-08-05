/**
 * Recipe 3 — Gemini tool compat empty-args/schema (issue #49 / ticket 6).
 * External behavior only; transport + config store injected — zero network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildRepairPlan,
  evaluateContract,
  isRecipeAdmitted,
  matchRepairRecipes,
  normalizeStageEvidence,
  resetRecipeRegistry,
  resolveSignatureId,
  runRepair,
  type NormalizedProbeRunEvidence,
  type ProbeRequest,
  type ProbeTransport,
  type ProbeTransportResult,
  type RepairConfigStore,
} from "../src/probe/index.ts";
import emptyArgsFixture from "./fixtures/probe/gemini-tool-empty-args.json";

afterEach(() => {
  resetRecipeRegistry();
});

const target = {
  provider: "ps-gemini-relay",
  modelId: "gemini-2.0-flash",
  reasoning: false as boolean | undefined,
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

function okTool(args: Record<string, unknown> = { msg: "probe_ok" }): ProbeTransportResult {
  return {
    httpStatus: 200,
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc1",
          name: "probe_echo",
          arguments: args,
        },
      ],
      stopReason: "toolUse",
    },
  };
}

function emptyArgsTool(): ProbeTransportResult {
  return okTool(emptyArgsFixture.toolCall.arguments as Record<string, unknown>);
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
  return { store, commits };
}

/** Durable evidence: tool stage failed with empty-args signature. */
function geminiToolEmptyArgsEvidence(options?: {
  geminiToolCompat?: boolean;
}): NormalizedProbeRunEvidence {
  return {
    target: {
      ...target,
      ...(options?.geminiToolCompat !== undefined
        ? { geminiToolCompat: options.geminiToolCompat }
        : {}),
    },
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
        status: "skip",
        category: "unknown",
        signatureId: "skip",
        allowedHeaderNames: [],
        summary: "skipped: target does not claim reasoning support",
        requestCount: 0,
      },
      {
        contract: "tool",
        status: "fail",
        category: "tool",
        signatureId: "gemini_tool_empty_args",
        allowedHeaderNames: [],
        summary:
          "tool contract: probe_echo called with empty or missing arguments (schema not enforced)",
        requestCount: 1,
        httpStatus: 200,
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

describe("tool empty-args / schema evidence (ticket 6)", () => {
  test("evaluateContract fails when probe_echo has empty arguments", () => {
    const result = evaluateContract("tool", emptyArgsTool());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe("tool");
      expect(result.summary.toLowerCase()).toMatch(/empty|missing/);
    }
  });

  test("evaluateContract fails when probe_echo msg is empty string", () => {
    const result = evaluateContract("tool", okTool({ msg: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe("tool");
    }
  });

  test("evaluateContract still passes filled probe_echo args", () => {
    const result = evaluateContract("tool", okTool({ msg: "probe_ok" }));
    expect(result.ok).toBe(true);
  });

  test("empty-args tool observation → gemini_tool_empty_args signature", () => {
    const stage = normalizeStageEvidence({
      stage: {
        contract: "tool",
        status: "fail",
        category: "tool",
        httpStatus: 200,
        summary:
          "tool contract: probe_echo called with empty or missing arguments (schema not enforced)",
        requestCount: 1,
      },
      observation: {
        contract: "tool",
        response: {
          httpStatus: 200,
          message: emptyArgsTool().message,
        },
      },
    });

    expect(stage.signatureId).toBe(emptyArgsFixture.expectedSignatureId);
    expect(stage.category).toBe("tool");
    expect(stage.unrepairable).toBeUndefined();
  });

  test("schema-related error text also maps to gemini_tool_empty_args", () => {
    const sig = resolveSignatureId({
      stage: {
        contract: "tool",
        status: "fail",
        category: "tool",
        httpStatus: 400,
        summary: "HTTP 400: invalid functionDeclarations parametersJsonSchema",
        requestCount: 1,
      },
      observation: {
        contract: "tool",
        response: {
          httpStatus: 400,
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage:
              "toolConfig.functionCallingConfig required; parametersJsonSchema not supported",
          },
        },
      },
    });
    expect(sig).toBe("gemini_tool_empty_args");
  });

  test("generic missing probe_echo (no empty-args evidence) stays contract_tool_missing_echo", () => {
    const stage = normalizeStageEvidence({
      stage: {
        contract: "tool",
        status: "fail",
        category: "tool",
        httpStatus: 200,
        summary: "tool contract: expected probe_echo tool call",
        requestCount: 1,
      },
    });
    expect(stage.signatureId).toBe("contract_tool_missing_echo");
  });
});

describe("matchRepairRecipes Recipe3 (ticket 6)", () => {
  test("gemini-tool-compat recipe is gate-admitted (relay-specific with fixture)", () => {
    expect(isRecipeAdmitted("gemini-tool-compat")).toBe(true);
  });

  test("empty-args signature → provider-level geminiToolCompat=true candidate", () => {
    const evidence = geminiToolEmptyArgsEvidence();
    const matches = matchRepairRecipes(evidence);

    expect(matches).toHaveLength(1);
    const m = matches[0]!;
    expect(m.recipeId).toBe("gemini-tool-compat");
    expect(m.signatureId).toBe("gemini_tool_empty_args");
    expect(m.sourceContract).toBe("tool");
    expect(m.patch.kind).toBe("geminiToolCompat");
    expect(m.patch.scope).toBe("provider");
    if (m.patch.kind === "geminiToolCompat") {
      expect(m.patch.provider).toBe(target.provider);
      expect(m.patch.geminiToolCompat).toBe(true);
    }
    // Provider scope only — never global, never model field
    expect(m.patch).not.toHaveProperty("modelId");
    expect(m.patch).not.toHaveProperty("global");
    expect(m.verifyContracts).toContain("tool");
    expect(m.verifyContracts).toContain("basic");

    const plan = buildRepairPlan(evidence);
    expect(plan.preview.recipeOrder).toEqual(["gemini-tool-compat"]);
    expect(plan.preview.patches[0]!.scope).toMatch(/provider/i);
  });

  test("already-enabled geminiToolCompat still failing → no candidate (report only)", () => {
    const evidence = geminiToolEmptyArgsEvidence({ geminiToolCompat: true });
    const matches = matchRepairRecipes(evidence);
    expect(matches).toHaveLength(0);

    const plan = buildRepairPlan(evidence);
    expect(plan.recipes).toHaveLength(0);

    // Plan still surfaces the target so UI can report "already enabled"
    expect(plan.target.geminiToolCompat).toBe(true);
  });

  test("unknown / non-tool evidence does not match Recipe3", () => {
    const evidence = geminiToolEmptyArgsEvidence();
    evidence.stages[2]!.signatureId = "unknown";
    evidence.stages[2]!.category = "unknown";
    expect(matchRepairRecipes(evidence)).toHaveLength(0);
  });

  test("contract_tool_missing_echo without empty-args signature does not match", () => {
    const evidence = geminiToolEmptyArgsEvidence();
    evidence.stages[2]!.signatureId = "contract_tool_missing_echo";
    evidence.stages[2]!.summary = "tool contract: expected probe_echo tool call";
    expect(matchRepairRecipes(evidence)).toHaveLength(0);
  });
});

describe("runRepair reuses ticket 4 pipeline for Recipe3 (ticket 6)", () => {
  test("empty-args candidate: two passes → CAS commit provider geminiToolCompat; no setModel", async () => {
    const plan = buildRepairPlan(geminiToolEmptyArgsEvidence());
    expect(plan.recipes[0]!.recipeId).toBe("gemini-tool-compat");

    const { transport, calls } = recordingTransport((req) => {
      if (req.contract === "basic") return okText();
      if (req.contract === "tool") return okTool();
      throw new Error(`unexpected contract: ${req.contract}`);
    });
    const { store, commits } = memoryConfigStore({ initialVersion: "cfg-gtc-1" });

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
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.expectedVersion).toBe("cfg-gtc-1");

    // Every verify request carries the candidate geminiToolCompat flag, so the
    // production transport can inject toolConfig via onPayload per request.
    expect(calls.every((c) => c.target.geminiToolCompat === true)).toBe(true);

    const patch = commits[0]!.patch as {
      kind: string;
      scope: string;
      provider: string;
      geminiToolCompat: boolean;
      modelId?: string;
    };
    expect(patch.kind).toBe("geminiToolCompat");
    expect(patch.scope).toBe("provider");
    expect(patch.provider).toBe(target.provider);
    expect(patch.geminiToolCompat).toBe(true);
    expect(patch.modelId).toBeUndefined();

    if (outcome.status === "committed") {
      expect(outcome.sessionModelUnchanged).toBe(true);
      expect(outcome.switchAction.kind).toBe("switch-to-repaired-target");
      expect(outcome.recipe.recipeId).toBe("gemini-tool-compat");
      // Candidate applied to repaired target in memory
      expect(outcome.switchAction.target.geminiToolCompat).toBe(true);
    }
  });

  test("verification failure discards geminiToolCompat candidate: zero persist", async () => {
    const plan = buildRepairPlan(geminiToolEmptyArgsEvidence());
    const { transport, calls } = recordingTransport(() => emptyArgsTool());
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
  });

  test("unconfirmed plan: zero network for gemini tool recipe", async () => {
    const plan = buildRepairPlan(geminiToolEmptyArgsEvidence());
    const { transport, calls } = recordingTransport(() => okText());
    const { store, commits } = memoryConfigStore();

    const outcome = await runRepair({
      mode: "interactive",
      confirmed: false,
      plan,
      model: {},
      transport,
      configStore: store,
    });

    expect(outcome.status).toBe("needs-confirmation");
    expect(calls).toHaveLength(0);
    expect(commits).toHaveLength(0);
  });

  test("already enabled: runRepair reports no-recipe and never writes", async () => {
    const plan = buildRepairPlan(
      geminiToolEmptyArgsEvidence({ geminiToolCompat: true }),
    );
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
    expect(outcome.persisted).toBe(false);
    expect(calls).toHaveLength(0);
    expect(commits).toHaveLength(0);
  });
});
