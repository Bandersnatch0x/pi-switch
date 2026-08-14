import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiRepairCaseWriteAdapter } from "../extensions/repair-case-adapter.ts";
import {
  REPAIR_CASE_DETAIL_CUSTOM_TYPE,
  REPAIR_CASE_SUMMARY_CUSTOM_TYPE,
  buildRepairPlan,
  createInMemoryRepairCaseWriteAdapter,
  createRepairCaseRecorder,
  createRepairCaseRepairEvent,
  type NormalizedProbeRunEvidence,
  type ProbeRunResult,
  type RepairCaseEvent,
  type RepairCaseVerificationAttemptInput,
  type RepairCaseWrite,
  type RepairCaseWriteAdapter,
  type RepairOutcome,
} from "../src/probe/index.ts";

const CASE_ID = "case_20260814010203_000000";

function reasoningRejectedEvidence(): NormalizedProbeRunEvidence {
  return {
    target: {
      provider: "ps-claude-relay",
      modelId: "claude-sonnet-probe",
      reasoning: true,
    },
    stages: [
      {
        contract: "basic",
        status: "pass",
        category: "ok",
        signatureId: "pass",
        allowedHeaderNames: ["content-type"],
        summary: "basic text response received",
        requestCount: 1,
        httpStatus: 200,
      },
      {
        contract: "reasoning",
        status: "fail",
        category: "protocol",
        signatureId: "reasoning_param_rejected",
        allowedHeaderNames: ["x-request-id"],
        summary: "reasoning parameter not supported",
        requestCount: 1,
        httpStatus: 400,
      },
      {
        contract: "tool",
        status: "stopped",
        category: "unknown",
        signatureId: "stopped",
        allowedHeaderNames: [],
        summary: "stopped after failure",
        requestCount: 0,
      },
    ],
    ok: false,
    stoppedReason: "failure",
    requestCount: 2,
    budget: {
      maxRequests: 9,
      used: 2,
      maxTokens: 2_048,
      timeoutMs: 15_000,
    },
    capturedAt: "2026-08-14T01:00:00.000Z",
  };
}

function verificationRun(): ProbeRunResult {
  return {
    target: {
      provider: "ps-claude-relay",
      modelId: "claude-sonnet-probe",
      reasoning: false,
    },
    stages: [
      {
        contract: "basic",
        status: "pass",
        summary:
          "verified at https://relay.example/v1?api_key=sk-live-VERIFY Authorization: Bearer sk-live-VERIFY",
        requestCount: 1,
        httpStatus: 200,
      },
      {
        contract: "reasoning",
        status: "skip",
        summary: "reasoning disabled",
        requestCount: 0,
      },
      {
        contract: "tool",
        status: "pass",
        summary: "probe_echo tool call received",
        requestCount: 1,
        httpStatus: 200,
      },
    ],
    ok: true,
    requestCount: 2,
    budget: {
      maxRequests: 9,
      used: 2,
      maxTokens: 2_048,
      timeoutMs: 15_000,
    },
  };
}

function committedOutcome(
  evidence = reasoningRejectedEvidence(),
): Extract<RepairOutcome, { status: "committed" }> {
  const plan = buildRepairPlan(evidence);
  const recipe = plan.recipes[0];
  if (!recipe) throw new Error("fixture must match a Repair Recipe");
  return {
    status: "committed",
    plan,
    recipe,
    attempts: [verificationRun()],
    summary: "committed fixture",
    persisted: true,
    sessionModelUnchanged: true,
    switchAction: {
      kind: "switch-to-repaired-target",
      target: {
        provider: evidence.target.provider,
        modelId: evidence.target.modelId,
        reasoning: false,
      },
    },
  };
}

function createRecorder(adapter: RepairCaseWriteAdapter) {
  return createRepairCaseRecorder(adapter, {
    now: () => new Date("2026-08-14T01:02:03.000Z"),
    random: () => 0,
  });
}

interface AdapterHarness {
  adapter: RepairCaseWriteAdapter;
  writes: RepairCaseWrite[];
}

function inMemoryHarness(): AdapterHarness {
  const adapter = createInMemoryRepairCaseWriteAdapter();
  return { adapter, writes: adapter.writes };
}

function piHarness(): AdapterHarness {
  const writes: RepairCaseWrite[] = [];
  const pi = {
    sendMessage: (message: {
      customType: typeof REPAIR_CASE_SUMMARY_CUSTOM_TYPE;
      content: string;
      display: true;
      details: { caseId: string };
    }) => {
      writes.push({ kind: "summary", ...message });
    },
    appendEntry: (
      customType: typeof REPAIR_CASE_DETAIL_CUSTOM_TYPE,
      data: Extract<RepairCaseWrite, { kind: "detail" }>["data"],
    ) => {
      writes.push({ kind: "detail", customType, data });
    },
  } as unknown as Pick<ExtensionAPI, "sendMessage" | "appendEntry">;
  return { adapter: createPiRepairCaseWriteAdapter(pi), writes };
}

const adapterFactories = [
  ["in-memory", inMemoryHarness],
  ["Pi", piHarness],
] as const;

for (const [name, createHarness] of adapterFactories) {
  describe(`${name} Repair Case adapter contract`, () => {
    test("records summary then detail with one Case ID and stable field shapes", () => {
      const harness = createHarness();
      const evidence = reasoningRejectedEvidence();

      createRecorder(harness.adapter).record(evidence, { kind: "probe" });

      expect(harness.writes.map((write) => write.kind)).toEqual([
        "summary",
        "detail",
      ]);
      const summary = harness.writes[0];
      const detail = harness.writes[1];
      expect(summary).toEqual({
        kind: "summary",
        customType: REPAIR_CASE_SUMMARY_CUSTOM_TYPE,
        content:
          `ps-repair-case ${CASE_ID} FAIL ps-claude-relay/claude-sonnet-probe` +
          " [basic=pass, reasoning=protocol, tool=stop] stop=failure",
        display: true,
        details: { caseId: CASE_ID },
      });
      expect(detail).toMatchObject({
        kind: "detail",
        customType: REPAIR_CASE_DETAIL_CUSTOM_TYPE,
        data: {
          caseId: CASE_ID,
          target: evidence.target,
          ok: false,
          evidence,
          recipeAttempts: [],
        },
      });
      if (summary?.kind !== "summary" || detail?.kind !== "detail") {
        throw new Error("adapter contract returned writes in the wrong order");
      }
      expect(summary.details.caseId).toBe(detail.data.caseId);
    });
  });
}

describe("Repair Case recorder contract", () => {
  test("owns outcome, Recipe, attempt, and switch conversion with redaction", () => {
    const adapter = createInMemoryRepairCaseWriteAdapter();
    const evidence = reasoningRejectedEvidence();
    const outcome = committedOutcome(evidence);
    const event = createRepairCaseRepairEvent(outcome, {
      status: "succeeded",
      target: { ...outcome.switchAction.target },
      summary:
        "switched via https://relay.example/v1?token=sk-live-SWITCH Bearer sk-live-SWITCH",
    });

    createRecorder(adapter).record(evidence, event);

    const summary = adapter.writes[0];
    const detail = adapter.writes[1];
    expect(summary?.kind).toBe("summary");
    expect(detail?.kind).toBe("detail");
    if (summary?.kind !== "summary" || detail?.kind !== "detail") return;

    expect(summary.content).toContain("repair=committed");
    expect(summary.content).toContain("switch=succeeded");
    expect(JSON.stringify(summary)).not.toContain("signatureId");
    expect(JSON.stringify(summary)).not.toContain("allowedHeaderNames");
    expect(JSON.stringify(summary)).not.toContain("budget");

    expect(detail.data.repair).toMatchObject({
      status: "committed",
      persisted: true,
      recipe: {
        recipeId: "reasoning-false",
        signatureId: "reasoning_param_rejected",
        scope: "exact-model",
        affectedModels: ["claude-sonnet-probe"],
      },
      switch: {
        status: "succeeded",
        target: outcome.switchAction.target,
      },
    });
    const repair = detail.data.repair;
    if (!repair) throw new Error("missing Repair Case repair record");
    expect(repair.verificationAttempts).toHaveLength(1);
    expect(detail.data.recipeAttempts).toBe(repair.verificationAttempts);
    const serialized = JSON.stringify(detail.data);
    expect(serialized).not.toContain("sk-live-");
    expect(serialized).not.toContain("Bearer sk-");
    expect(serialized).not.toMatch(/[?&](api_key|token)=/i);
    expect(serialized).not.toContain("rawBody");
    expect(serialized).not.toContain("observations");
  });

  test("projects full RepairOutcome into a narrow event without changing it", () => {
    const outcome = committedOutcome();
    const originalAttempt = outcome.attempts[0];
    expect(originalAttempt?.target.modelId).toBe("claude-sonnet-probe");
    expect(originalAttempt?.budget.maxRequests).toBe(9);

    const event = createRepairCaseRepairEvent(outcome, {
      status: "not-offered",
    });
    const eventJson = JSON.stringify(event);

    expect(eventJson).not.toContain('"target"');
    expect(eventJson).not.toContain('"budget"');
    expect(eventJson).not.toContain('"precheck"');
    expect(outcome.attempts[0]).toBe(originalAttempt);
    expect(outcome.attempts[0]?.budget.maxRequests).toBe(9);
  });

  test("maps provider-wide Recipe scope inside the recorder module", () => {
    const evidence = reasoningRejectedEvidence();
    evidence.stages[1] = {
      contract: "reasoning",
      status: "stopped",
      category: "unknown",
      signatureId: "stopped",
      allowedHeaderNames: [],
      summary: "stopped after client gate",
      requestCount: 0,
    };
    evidence.stages[0] = {
      contract: "basic",
      status: "fail",
      category: "client-gate",
      signatureId: "client_gate_claude_code",
      allowedHeaderNames: [],
      summary: "Claude Code identity required",
      requestCount: 1,
      httpStatus: 403,
    };
    const outcome = committedOutcome(evidence);
    const adapter = createInMemoryRepairCaseWriteAdapter();

    createRecorder(adapter).record(
      evidence,
      createRepairCaseRepairEvent(outcome, { status: "not-offered" }),
    );

    const detail = adapter.writes[1];
    if (detail?.kind !== "detail") throw new Error("missing detail write");
    expect(detail.data.repair?.recipe).toEqual({
      recipeId: "client-fingerprint",
      signatureId: "client_gate_claude_code",
      scope: "provider-wide",
      provider: "ps-claude-relay",
    });
  });

  test("propagates first and second adapter failures without retry or compensation", () => {
    const evidence = reasoningRejectedEvidence();
    let firstCalls = 0;
    const firstFailure = new Error("summary write failed");
    const firstAdapter: RepairCaseWriteAdapter = {
      write: () => {
        firstCalls += 1;
        throw firstFailure;
      },
    };
    expect(() =>
      createRecorder(firstAdapter).record(evidence, { kind: "probe" }),
    ).toThrow(firstFailure);
    expect(firstCalls).toBe(1);

    let secondCalls = 0;
    const completed: RepairCaseWrite[] = [];
    const secondFailure = new Error("detail write failed");
    const secondAdapter: RepairCaseWriteAdapter = {
      write: (write) => {
        secondCalls += 1;
        if (secondCalls === 2) throw secondFailure;
        completed.push(write);
      },
    };
    expect(() =>
      createRecorder(secondAdapter).record(evidence, { kind: "probe" }),
    ).toThrow(secondFailure);
    expect(secondCalls).toBe(2);
    expect(completed.map((write) => write.kind)).toEqual(["summary"]);
  });
});

type ProbeRunCanCrossRecorderSeam =
  ProbeRunResult extends RepairCaseVerificationAttemptInput ? true : false;
const probeRunCanCrossRecorderSeam: ProbeRunCanCrossRecorderSeam = false;

test("type contract rejects ProbeRunResult at the recorder seam", () => {
  expect(probeRunCanCrossRecorderSeam).toBe(false);
  const event: RepairCaseEvent = { kind: "probe" };
  expect(event.kind).toBe("probe");
});
