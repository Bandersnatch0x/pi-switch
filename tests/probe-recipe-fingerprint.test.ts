/**
 * Recipe 2 — client fingerprint unique signature (issue #48 / ticket 5).
 * External behavior only; transport + config store injected — zero network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildRepairPlan,
  detectUniqueClientGate,
  isRecipeAdmitted,
  matchRepairRecipes,
  normalizeStageEvidence,
  resetRecipeRegistry,
  runRepair,
  type NormalizedProbeRunEvidence,
  type ProbeRequest,
  type ProbeTransport,
  type ProbeTransportResult,
  type RepairConfigStore,
} from "../src/probe/index.ts";
import claudeGateFixture from "./fixtures/probe/client-gate-claude-code.json";
import codexGateFixture from "./fixtures/probe/client-gate-codex.json";
import geminiGateFixture from "./fixtures/probe/client-gate-gemini.json";
import ambiguousGateFixture from "./fixtures/probe/client-gate-ambiguous.json";

afterEach(() => {
  resetRecipeRegistry();
});

const target = {
  provider: "ps-fingerprint-relay",
  modelId: "relay-model-1",
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

/** Durable evidence for a unique client-gate fail on basic. */
function clientGateEvidence(
  signatureId: string,
  summary: string,
): NormalizedProbeRunEvidence {
  return {
    target: { ...target },
    stages: [
      {
        contract: "basic",
        status: "fail",
        category: "client-gate",
        signatureId,
        allowedHeaderNames: [],
        summary,
        requestCount: 1,
        httpStatus: 403,
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

describe("detectUniqueClientGate (ticket 5)", () => {
  test("maps Claude Code distinctive rejection uniquely", () => {
    expect(detectUniqueClientGate(claudeGateFixture.errorMessage)).toBe("claude-code");
    expect(detectUniqueClientGate("requires Claude Code Agent SDK device_id")).toBe(
      "claude-code",
    );
  });

  test("maps Codex distinctive rejection uniquely", () => {
    expect(detectUniqueClientGate(codexGateFixture.errorMessage)).toBe("codex");
    expect(
      detectUniqueClientGate("missing X-Codex-Window-ID for codex_cli_rs channel"),
    ).toBe("codex");
  });

  test("maps Gemini distinctive rejection uniquely", () => {
    expect(detectUniqueClientGate(geminiGateFixture.errorMessage)).toBe("gemini");
    expect(detectUniqueClientGate("x-goog-api-client must be gemini-cli")).toBe("gemini");
  });

  test("ambiguous / multi-match / generic UA errors stay undefined (no guess)", () => {
    expect(detectUniqueClientGate(ambiguousGateFixture.errorMessage)).toBeUndefined();
    expect(detectUniqueClientGate("invalid User-Agent")).toBeUndefined();
    expect(detectUniqueClientGate("Forbidden")).toBeUndefined();
    // Mentions two distinct clients → not unique
    expect(
      detectUniqueClientGate(
        "use claude-cli or codex_cli_rs; GeminiCLI also accepted",
      ),
    ).toBeUndefined();
  });
});

describe("evidence signatures for client-gate (ticket 5)", () => {
  test("unique Claude Code body → client_gate_claude_code category client-gate", () => {
    const stage = normalizeStageEvidence({
      stage: {
        contract: "basic",
        status: "fail",
        category: "client-gate",
        httpStatus: 403,
        summary: claudeGateFixture.errorMessage,
        requestCount: 1,
      },
      observation: {
        contract: "basic",
        response: {
          httpStatus: 403,
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: claudeGateFixture.errorMessage,
          },
        },
      },
    });

    expect(stage.signatureId).toBe(claudeGateFixture.expectedSignatureId);
    expect(stage.category).toBe("client-gate");
    expect(stage.unrepairable).toBeUndefined();
  });

  test("unique Codex / Gemini fixtures → matching signature ids", () => {
    for (const fixture of [codexGateFixture, geminiGateFixture]) {
      const stage = normalizeStageEvidence({
        stage: {
          contract: "basic",
          status: "fail",
          category: "client-gate",
          httpStatus: 403,
          summary: fixture.errorMessage,
          requestCount: 1,
        },
        observation: {
          contract: "basic",
          response: {
            httpStatus: 403,
            message: {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: fixture.errorMessage,
            },
          },
        },
      });
      expect(stage.signatureId).toBe(fixture.expectedSignatureId);
    }
  });

  test("ambiguous body is not a unique client-gate signature", () => {
    const stage = normalizeStageEvidence({
      stage: {
        contract: "basic",
        status: "fail",
        category: "unknown",
        httpStatus: 403,
        summary: ambiguousGateFixture.errorMessage,
        requestCount: 1,
      },
      observation: {
        contract: "basic",
        response: {
          httpStatus: 403,
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: ambiguousGateFixture.errorMessage,
          },
        },
      },
    });

    // Either unknown or generic auth 403 — never a unique client_gate_* fingerprint
    expect(stage.signatureId).not.toMatch(/^client_gate_/);
    expect(["unknown", "http_auth_403"]).toContain(stage.signatureId);
  });

  test("generic 403 without distinctive body stays http_auth_403 (not fingerprint)", () => {
    const stage = normalizeStageEvidence({
      stage: {
        contract: "basic",
        status: "fail",
        category: "auth",
        unrepairable: true,
        httpStatus: 403,
        summary: "HTTP 403: authentication or authorization failed",
        requestCount: 1,
      },
    });
    expect(stage.signatureId).toBe("http_auth_403");
  });
});

describe("matchRepairRecipes Recipe2 (ticket 5)", () => {
  test("client-fingerprint recipe is gate-admitted (relay-specific with fixture)", () => {
    expect(isRecipeAdmitted("client-fingerprint")).toBe(true);
  });

  test("unique Claude Code signature → provider-level fingerprint claude-code (+ compat)", () => {
    const evidence = clientGateEvidence(
      "client_gate_claude_code",
      "client fingerprint gate: requires claude-code identity",
    );
    const matches = matchRepairRecipes(evidence);

    expect(matches).toHaveLength(1);
    const m = matches[0]!;
    expect(m.recipeId).toBe("client-fingerprint");
    expect(m.signatureId).toBe("client_gate_claude_code");
    expect(m.patch.kind).toBe("fingerprint");
    expect(m.patch.scope).toBe("provider");
    if (m.patch.kind === "fingerprint") {
      expect(m.patch.provider).toBe(target.provider);
      expect(m.patch.fingerprint).toBe("claude-code");
      expect(m.patch.claudeCodeCompat).toBe(true);
    }
    // Provider scope — never global, never model-only field
    expect(m.patch).not.toHaveProperty("modelId");
    expect(m.patch).not.toHaveProperty("global");

    const plan = buildRepairPlan(evidence);
    expect(plan.preview.recipeOrder).toEqual(["client-fingerprint"]);
    expect(plan.preview.patches[0]).toEqual({
      recipeId: "client-fingerprint",
      description: m.summary,
      scope: "provider-wide",
      provider: target.provider,
    });
    expect(plan.preview.patches[0]).not.toHaveProperty("affectedModels");
  });

  test("unique Codex / Gemini signatures map to matching fingerprint presets", () => {
    const cases = [
      { sig: "client_gate_codex", fingerprint: "codex" as const },
      { sig: "client_gate_gemini", fingerprint: "gemini" as const },
    ];
    for (const c of cases) {
      const matches = matchRepairRecipes(
        clientGateEvidence(c.sig, `client fingerprint gate: requires ${c.fingerprint}`),
      );
      expect(matches).toHaveLength(1);
      const m = matches[0]!;
      expect(m.recipeId).toBe("client-fingerprint");
      expect(m.signatureId).toBe(c.sig);
      expect(m.patch.kind).toBe("fingerprint");
      if (m.patch.kind === "fingerprint") {
        expect(m.patch.scope).toBe("provider");
        expect(m.patch.fingerprint).toBe(c.fingerprint);
        expect(m.patch.provider).toBe(target.provider);
        // codex/gemini do not force claudeCodeCompat
        expect(m.patch.claudeCodeCompat).toBeUndefined();
      }
    }
  });

  test("non-unique / unknown evidence → no recipe (no fingerprint guess)", () => {
    const evidence = clientGateEvidence(
      "unknown",
      "HTTP 403: invalid User-Agent; official client required",
    );
    // Force category unknown as durable evidence would
    evidence.stages[0]!.category = "unknown";
    expect(matchRepairRecipes(evidence)).toHaveLength(0);
    expect(buildRepairPlan(evidence).recipes).toHaveLength(0);
  });

  test("http_auth_403 without unique client-gate signature does not match Recipe2", () => {
    const evidence = clientGateEvidence(
      "http_auth_403",
      "HTTP 403: authentication or authorization failed",
    );
    evidence.stages[0]!.category = "auth";
    evidence.stages[0]!.unrepairable = true;
    expect(matchRepairRecipes(evidence)).toHaveLength(0);
  });
});

describe("runRepair reuses ticket 4 pipeline for Recipe2 (ticket 5)", () => {
  test("unique fingerprint candidate: two passes → CAS commit provider fingerprint; no setModel", async () => {
    const plan = buildRepairPlan(
      clientGateEvidence(
        "client_gate_claude_code",
        "client fingerprint gate: requires claude-code identity",
      ),
    );
    expect(plan.recipes[0]!.recipeId).toBe("client-fingerprint");

    const { transport, calls } = recordingTransport((req) => {
      if (req.contract === "basic") return okText();
      if (req.contract === "tool") return okTool();
      throw new Error(`unexpected contract: ${req.contract}`);
    });
    const { store, commits } = memoryConfigStore({ initialVersion: "cfg-fp-1" });

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
    expect(commits[0]!.expectedVersion).toBe("cfg-fp-1");

    // Every verify request carries the candidate fingerprint on the target,
    // so the production transport can apply fingerprint headers per request.
    expect(calls.every((c) => c.target.fingerprint === "claude-code")).toBe(true);
    expect(calls.every((c) => c.target.claudeCodeCompat === true)).toBe(true);

    const patch = commits[0]!.patch as {
      kind: string;
      scope: string;
      provider: string;
      fingerprint: string;
      claudeCodeCompat?: boolean;
      modelId?: string;
    };
    expect(patch.kind).toBe("fingerprint");
    expect(patch.scope).toBe("provider");
    expect(patch.provider).toBe(target.provider);
    expect(patch.fingerprint).toBe("claude-code");
    expect(patch.claudeCodeCompat).toBe(true);
    // No model-scoped field on fingerprint patch
    expect(patch.modelId).toBeUndefined();

    if (outcome.status === "committed") {
      expect(outcome.sessionModelUnchanged).toBe(true);
      expect(outcome.switchAction.kind).toBe("switch-to-repaired-target");
      expect(outcome.recipe.recipeId).toBe("client-fingerprint");
    }
  });

  test("verification failure discards fingerprint candidate: zero persist", async () => {
    const plan = buildRepairPlan(
      clientGateEvidence("client_gate_codex", "requires codex_cli_rs"),
    );
    const { transport, calls } = recordingTransport(() => ({
      httpStatus: 403,
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "still gated",
      },
    }));
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

  test("unconfirmed plan: zero network for fingerprint recipe", async () => {
    const plan = buildRepairPlan(
      clientGateEvidence("client_gate_gemini", "requires GeminiCLI"),
    );
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
});
