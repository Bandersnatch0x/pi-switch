import { describe, expect, test } from "bun:test";
import {
  advance,
  buildRepairPlan,
  createInvestigation,
  createRepairInvestigation,
  InvalidInvestigationTransitionError,
  type NormalizedProbeRunEvidence,
  type ProbeRunResult,
  type ProbeTarget,
} from "../src/probe/index.ts";

const target: ProbeTarget = {
  provider: "relay",
  modelId: "model",
  reasoning: true,
};

const evidence: NormalizedProbeRunEvidence = {
  target,
  stages: [
    {
      contract: "basic",
      status: "pass",
      category: "ok",
      signatureId: "pass",
      allowedHeaderNames: [],
      summary: "ok",
      requestCount: 1,
    },
    {
      contract: "reasoning",
      status: "fail",
      category: "protocol",
      signatureId: "reasoning_param_rejected",
      allowedHeaderNames: [],
      summary: "reasoning unsupported",
      requestCount: 1,
    },
  ],
  ok: false,
  stoppedReason: "failure",
  requestCount: 2,
  budget: { maxRequests: 9, used: 2, maxTokens: 2048, timeoutMs: 15_000 },
  capturedAt: "2026-01-01T00:00:00.000Z",
};

const noRecipeEvidence: NormalizedProbeRunEvidence = {
  ...evidence,
  stages: [{ ...evidence.stages[0]!, contract: "basic" }],
};

function result(ok: boolean, t: ProbeTarget = target): ProbeRunResult {
  return {
    target: t,
    stages: [],
    ok,
    requestCount: 1,
    budget: { maxRequests: 9, used: 1, maxTokens: 2048, timeoutMs: 15_000 },
  };
}

function repairFlow() {
  let transition = createInvestigation(target, { kind: "repair" });
  transition = advance(transition.state, {
    kind: "probe-completed",
    result: result(false),
    evidence,
  });
  transition = advance(transition.state, { kind: "confirm", accepted: true });
  transition = advance(transition.state, { kind: "config-snapshot", version: "v1" });
  return transition;
}

describe("Compatibility investigation state machine", () => {
  test("probe-only terminates after probe/evidence and emits no repair effects", () => {
    const started = createInvestigation(target, { kind: "probe-only" });
    const done = advance(started.state, {
      kind: "probe-completed",
      result: result(false),
      evidence,
    });
    expect(done.state.status).toBe("probe-complete");
    expect(done.effects).toEqual([]);
  });

  test("repair with no recipe terminates without repair effects", () => {
    const started = createInvestigation(target, { kind: "repair" });
    const done = advance(started.state, {
      kind: "probe-completed",
      result: result(false),
      evidence: noRecipeEvidence,
    });
    expect(done.state.status).toBe("no-recipe");
    expect(done.effects).toEqual([]);
  });

  test("plan entry keeps the durable probe result absent instead of fabricating one", () => {
    const plan = buildRepairPlan(evidence);
    const started = createRepairInvestigation(plan);

    expect(started.state).not.toHaveProperty("result");
  });

  test("confirmation pending and decline have no network/config effects", () => {
    const started = createInvestigation(target, { kind: "repair" });
    const pending = advance(started.state, {
      kind: "probe-completed",
      result: result(false),
      evidence,
    });
    expect(pending.state.status).toBe("awaiting-confirmation");
    expect(pending.effects.map((e) => e.kind)).toEqual(["confirm-repair"]);
    const declined = advance(pending.state, { kind: "confirm", accepted: false });
    expect(declined.state.status).toBe("confirmation-declined");
    expect(declined.effects).toEqual([]);
  });

  test("snapshot schedules exactly two sequential candidate verifications", () => {
    const first = repairFlow();
    expect(first.state.status).toBe("awaiting-verification");
    expect(first.effects).toHaveLength(1);
    expect(first.effects[0]).toMatchObject({ kind: "verify-candidate", sequence: 1, maxTokens: 2048 });
    const second = advance(first.state, { kind: "verification-completed", sequence: 1, result: result(true, { ...target, reasoning: false }) });
    expect(second.effects[0]).toMatchObject({ kind: "verify-candidate", sequence: 2 });
    const commit = advance(second.state, { kind: "verification-completed", sequence: 2, result: result(true, { ...target, reasoning: false }) });
    expect(commit.state.status).toBe("awaiting-commit");
    expect(commit.effects.map((e) => e.kind)).toEqual(["commit-repair"]);
  });

  test("first or second verification failure terminates and never commits", () => {
    const first = repairFlow();
    const failedFirst = advance(first.state, { kind: "verification-completed", sequence: 1, result: result(false, { ...target, reasoning: false }) });
    expect(failedFirst.state.status).toBe("verification-failed");
    expect(failedFirst.effects.map((e) => e.kind)).toEqual(["persist-repair-case"]);

    const pass1 = advance(first.state, { kind: "verification-completed", sequence: 1, result: result(true, { ...target, reasoning: false }) });
    const failedSecond = advance(pass1.state, { kind: "verification-completed", sequence: 2, result: result(false, { ...target, reasoning: false }) });
    expect(failedSecond.state.status).toBe("verification-failed");
    expect(failedSecond.effects.map((e) => e.kind)).toEqual(["persist-repair-case"]);
  });

  test("CAS conflict/error and committed outcome with optional switch offer", () => {
    const ready = advance(repairFlow().state, { kind: "verification-completed", sequence: 1, result: result(true, { ...target, reasoning: false }) });
    const committing = advance(ready.state, { kind: "verification-completed", sequence: 2, result: result(true, { ...target, reasoning: false }) });
    const conflict = advance(committing.state, { kind: "commit-completed", result: { ok: false, reason: "conflict" } });
    expect(conflict.state.status).toBe("cas-conflict");
    const error = advance(committing.state, { kind: "commit-completed", result: { ok: false, reason: "error", message: "disk" } });
    expect(error.state.status).toBe("commit-error");

    const offered = advance(committing.state, { kind: "commit-completed", result: { ok: true, version: "v2" } });
    expect(offered.state.status).toBe("awaiting-switch");
    expect(offered.effects.map((e) => e.kind)).toEqual(["offer-switch"]);
    const committed = advance(offered.state, { kind: "switch-decision", accepted: false });
    expect(committed.state.status).toBe("committed");
    expect(committed.effects.map((e) => e.kind)).toEqual(["persist-repair-case"]);
  });

  test("successful repair can omit the optional switch offer", () => {
    let transition = createInvestigation(target, { kind: "repair", offerSwitch: false });
    transition = advance(transition.state, { kind: "probe-completed", result: result(false), evidence });
    transition = advance(transition.state, { kind: "confirm", accepted: true });
    transition = advance(transition.state, { kind: "config-snapshot", version: "v1" });
    transition = advance(transition.state, { kind: "verification-completed", sequence: 1, result: result(true, { ...target, reasoning: false }) });
    transition = advance(transition.state, { kind: "verification-completed", sequence: 2, result: result(true, { ...target, reasoning: false }) });
    transition = advance(transition.state, { kind: "commit-completed", result: { ok: true, version: "v2" } });
    expect(transition.state.status).toBe("committed");
    expect(transition.effects.map((effect) => effect.kind)).toEqual(["persist-repair-case"]);
  });

  test("accepted switch emits lifecycle action before Repair Case persistence", () => {
    const ready = advance(repairFlow().state, { kind: "verification-completed", sequence: 1, result: result(true, { ...target, reasoning: false }) });
    const committing = advance(ready.state, { kind: "verification-completed", sequence: 2, result: result(true, { ...target, reasoning: false }) });
    const offered = advance(committing.state, { kind: "commit-completed", result: { ok: true, version: "v2" } });
    const committed = advance(offered.state, { kind: "switch-decision", accepted: true });

    expect(committed.state.status).toBe("committed");
    expect(committed.effects.map((effect) => effect.kind)).toEqual([
      "switch-to-repaired-target",
      "persist-repair-case",
    ]);
  });

  test("out-of-order events throw and state has no Session Model or side-effect objects", () => {
    const started = createInvestigation(target, { kind: "repair" });
    expect(() => advance(started.state, { kind: "confirm", accepted: true })).toThrow();
    const keys = Object.keys(started.state);
    expect(keys).not.toContain("sessionModel");
    expect(keys).not.toContain("transport");
    expect(keys).not.toContain("configStore");
    expect(keys).not.toContain("repairCase");
    expect(keys).not.toContain("ui");
  });

  test("rejects a probe result for a different target with the transition error", () => {
    const started = createInvestigation(target, { kind: "probe-only" });

    expect(() =>
      advance(started.state, {
        kind: "probe-completed",
        result: result(false, { ...target, modelId: "other-model" }),
        evidence,
      }),
    ).toThrow(InvalidInvestigationTransitionError);
  });

  test("does not share a mutable plan between state and confirmation effect", () => {
    const plan = buildRepairPlan(evidence);
    const started = createRepairInvestigation(plan);
    const confirmation = started.effects[0];

    if (confirmation?.kind !== "confirm-repair") throw new Error("expected confirmation effect");
    if (started.state.status !== "awaiting-confirmation") throw new Error("expected pending confirmation state");
    confirmation.plan.recipes[0]!.verifyContracts.push("reasoning");

    expect(started.state.plan.recipes[0]?.verifyContracts).not.toContain("reasoning");
  });

  test("rejects an out-of-range recipe selection instead of falling back", () => {
    const started = createRepairInvestigation(buildRepairPlan(evidence), {}, 99);

    expect(() =>
      advance(started.state, { kind: "confirm", accepted: true }),
    ).toThrow(InvalidInvestigationTransitionError);
  });
});
