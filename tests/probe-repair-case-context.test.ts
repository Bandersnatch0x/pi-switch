/**
 * Repair Case summary into session context (issue #50 / ticket 7).
 *
 * After a Session Model switch, the next model still sees short redacted
 * summaries (custom_message). Detailed normalized evidence (custom) never
 * enters model context, so repeated repairs cannot bloat context with details.
 * External behavior only; zero network.
 */
import { describe, expect, test } from "bun:test";
import {
  REPAIR_CASE_DETAIL_CUSTOM_TYPE,
  REPAIR_CASE_SUMMARY_CUSTOM_TYPE,
  buildRepairCaseLayers,
  createRepairCaseSession,
  formatRepairCaseSummaryText,
  normalizeProbeRun,
  projectSessionModelContext,
  recordRepairCase,
  switchSessionModel,
  type NormalizedProbeRunEvidence,
  type ProbeRunResult,
  type RepairCaseSession,
} from "../src/probe/index.ts";

const target = {
  provider: "ps-claude-relay",
  modelId: "claude-sonnet-probe",
  reasoning: true as boolean | undefined,
};

function failAuthRun(): ProbeRunResult {
  return {
    target: { ...target },
    stages: [
      {
        contract: "basic",
        status: "fail",
        category: "auth",
        unrepairable: true,
        httpStatus: 401,
        summary: "HTTP 401 authentication failed",
        requestCount: 1,
      },
      {
        contract: "reasoning",
        status: "stopped",
        summary: "stopped after hard failure",
        requestCount: 0,
      },
      {
        contract: "tool",
        status: "stopped",
        summary: "stopped after hard failure",
        requestCount: 0,
      },
    ],
    ok: false,
    requestCount: 1,
    stoppedReason: "unrepairable",
    budget: { maxRequests: 9, used: 1, maxTokens: 32, timeoutMs: 15000 },
  };
}

function passRun(modelId = target.modelId): ProbeRunResult {
  return {
    target: { ...target, modelId },
    stages: [
      {
        contract: "basic",
        status: "pass",
        summary: "basic text response received",
        requestCount: 1,
        httpStatus: 200,
      },
      {
        contract: "reasoning",
        status: "pass",
        summary: "reasoning request completed without error",
        requestCount: 1,
        httpStatus: 200,
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
    requestCount: 3,
    budget: { maxRequests: 9, used: 3, maxTokens: 32, timeoutMs: 15000 },
  };
}

function fatFailEvidence(caseTag: string): NormalizedProbeRunEvidence {
  // Intentionally large durable detail (headers + multi-stage signatures)
  // so bloat assertions can distinguish summary vs detail payload size.
  const run: ProbeRunResult = {
    target: {
      provider: "ps-claude-relay",
      modelId: `model-${caseTag}`,
      reasoning: true,
    },
    stages: [
      {
        contract: "basic",
        status: "fail",
        category: "protocol",
        unrepairable: false,
        httpStatus: 400,
        summary: `protocol fail ${caseTag} with url https://relay.example/v1?api_key=sk-live-SECRET-${caseTag}`,
        requestCount: 1,
      },
      {
        contract: "reasoning",
        status: "fail",
        category: "protocol",
        unrepairable: false,
        httpStatus: 400,
        summary: `reasoning rejected ${caseTag}`,
        requestCount: 1,
      },
      {
        contract: "tool",
        status: "fail",
        category: "tool",
        unrepairable: false,
        httpStatus: 200,
        summary: `tool empty args ${caseTag}`,
        requestCount: 1,
      },
    ],
    ok: false,
    requestCount: 3,
    budget: { maxRequests: 9, used: 3, maxTokens: 32, timeoutMs: 15000 },
  };
  return normalizeProbeRun({
    result: run,
    observations: [
      {
        contract: "basic",
        request: {
          messages: [{ role: "user", content: `probe body ${caseTag} do-not-leak` }],
        },
        response: {
          httpStatus: 400,
          responseHeaders: {
            "x-request-id": `req-${caseTag}`,
            "content-type": "application/json",
            "set-cookie": `session=secret-${caseTag}`,
            "cf-ray": `ray-${caseTag}`,
            server: "relay",
            "x-ratelimit-remaining": "0",
          },
          rawBody: `{"error":"sk-live-SECRET-${caseTag}","stack":"..."}`,
          message: {
            role: "assistant",
            content: [{ type: "text", text: `err sk-live-SECRET-${caseTag}` }],
            stopReason: "error",
          },
        },
      },
    ],
  });
}

function contextBlob(session: RepairCaseSession): string {
  const projected = projectSessionModelContext(session);
  return JSON.stringify(projected.contextMessages);
}

describe("Repair Case session context (ticket 7 / #50)", () => {
  test("after Session Model switch, summary remains visible to the model", () => {
    const session = createRepairCaseSession({
      sessionModel: { provider: "anthropic", modelId: "claude-opus-session" },
    });
    const evidence = normalizeProbeRun({ result: failAuthRun() });
    const layers = buildRepairCaseLayers({ caseId: "case_switch_1", evidence });
    recordRepairCase(session, layers);

    // User switches Session Model mid-troubleshooting (does not touch Probe Target)
    switchSessionModel(session, "openai", "gpt-session-switch");

    const projected = projectSessionModelContext(session);

    expect(projected.sessionModel).toEqual({
      provider: "openai",
      modelId: "gpt-session-switch",
    });
    expect(projected.contextMessages.length).toBeGreaterThanOrEqual(1);

    const texts = projected.contextMessages.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
    const joined = texts.join("\n");
    expect(joined).toContain("case_switch_1");
    expect(joined).toContain(target.provider);
    expect(joined).toContain(target.modelId);
    expect(joined).toMatch(/FAIL|auth|fail/i);

    // Probe Target is independent of Session Model
    expect(joined).not.toContain("gpt-session-switch");
    expect(projected.sessionModel?.modelId).toBe("gpt-session-switch");
  });

  test("detailed evidence never enters model context (custom vs custom_message)", () => {
    const session = createRepairCaseSession();
    const evidence = fatFailEvidence("detail");
    const layers = buildRepairCaseLayers({ caseId: "case_detail_x", evidence });
    recordRepairCase(session, layers);

    const projected = projectSessionModelContext(session);
    const ctxJson = JSON.stringify(projected.contextMessages);
    const entriesJson = JSON.stringify(session.entries);

    // Dual-layer still present in session storage
    expect(entriesJson).toContain(REPAIR_CASE_SUMMARY_CUSTOM_TYPE);
    expect(entriesJson).toContain(REPAIR_CASE_DETAIL_CUSTOM_TYPE);
    expect(entriesJson).toContain('"signatureId"');
    expect(entriesJson).toContain("allowedHeaderNames");

    // Context projection only carries custom_message content
    expect(ctxJson).toContain("case_detail_x");
    expect(ctxJson).not.toContain('"signatureId"');
    expect(ctxJson).not.toContain("allowedHeaderNames");
    expect(ctxJson).not.toContain('"budget"');
    expect(ctxJson).not.toContain("rawBody");
    expect(ctxJson).not.toContain("recipeAttempts");
    expect(ctxJson).not.toContain("do-not-leak");
    expect(ctxJson).not.toContain("set-cookie");
    expect(ctxJson).not.toContain("sk-live-SECRET");

    // Excluded details mirror pi buildSessionContext (custom → ignored)
    expect(projected.excludedFromContext.length).toBe(1);
    expect(projected.excludedFromContext[0]!.type).toBe("custom");
    expect(projected.excludedFromContext[0]!.customType).toBe(
      REPAIR_CASE_DETAIL_CUSTOM_TYPE,
    );
    expect(projected.excludedFromContext[0]!.data.caseId).toBe("case_detail_x");
  });

  test("multiple Repair Cases do not bloat context with case details", () => {
    const session = createRepairCaseSession({
      sessionModel: { provider: "anthropic", modelId: "session-a" },
    });

    const caseIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const tag = `n${i}`;
      const evidence = fatFailEvidence(tag);
      const layers = buildRepairCaseLayers({ caseId: `case_multi_${tag}`, evidence });
      caseIds.push(layers.caseId);
      recordRepairCase(session, layers);
    }

    // Mid-run model switch must keep all prior summaries
    switchSessionModel(session, "google", "gemini-session-b");

    const projected = projectSessionModelContext(session);
    const ctxJson = JSON.stringify(projected.contextMessages);

    // All five short summaries remain visible
    for (const id of caseIds) {
      expect(ctxJson).toContain(id);
    }
    expect(projected.contextMessages.length).toBe(5);

    // Context must not carry detail trees for any case
    expect(ctxJson).not.toContain('"signatureId"');
    expect(ctxJson).not.toContain("allowedHeaderNames");
    expect(ctxJson).not.toContain('"budget"');
    expect(ctxJson).not.toContain("rawBody");
    expect(ctxJson).not.toContain("recipeAttempts");
    expect(ctxJson).not.toContain("do-not-leak");
    expect(ctxJson).not.toContain("sk-live-SECRET");

    // Size bound: five short one-liners stay tiny vs full detail payload
    const detailOnly = session.entries
      .filter((e) => e.type === "custom")
      .map((e) => JSON.stringify(e));
    const detailBytes = detailOnly.join("").length;
    const contextBytes = ctxJson.length;
    expect(detailBytes).toBeGreaterThan(contextBytes * 2);
    expect(contextBytes).toBeLessThan(4_000);

    // Session still retains detail entries offline
    expect(session.entries.filter((e) => e.type === "custom")).toHaveLength(5);
    expect(session.entries.filter((e) => e.type === "custom_message")).toHaveLength(5);
    expect(projected.excludedFromContext).toHaveLength(5);
  });

  test("summary includes target identity, contracts, conclusion; no secrets", () => {
    const run: ProbeRunResult = {
      ...failAuthRun(),
      stages: [
        {
          contract: "basic",
          status: "fail",
          category: "auth",
          unrepairable: true,
          httpStatus: 401,
          summary:
            "HTTP 401 at https://relay.example/v1?api_key=sk-live-LEAK Authorization: Bearer sk-live-LEAK",
          requestCount: 1,
        },
        ...failAuthRun().stages.slice(1),
      ],
    };
    const evidence = normalizeProbeRun({ result: run });
    const text = formatRepairCaseSummaryText("case_sum_1", evidence);

    // Target identity
    expect(text).toContain("ps-claude-relay");
    expect(text).toContain("claude-sonnet-probe");
    // Case id
    expect(text).toContain("case_sum_1");
    // Contracts
    expect(text).toMatch(/basic/i);
    expect(text).toMatch(/reasoning|tool/i);
    // Conclusion
    expect(text).toMatch(/FAIL|auth|unrepairable/i);
    // No secrets
    expect(text.toLowerCase()).not.toContain("sk-live-");
    expect(text).not.toMatch(/[?&]api_key=/i);
    expect(text).not.toMatch(/Bearer\s+\S+/i);

    // When recorded into session, projection preserves the same constraints
    const session = createRepairCaseSession();
    recordRepairCase(
      session,
      buildRepairCaseLayers({ caseId: "case_sum_1", evidence }),
    );
    const blob = contextBlob(session);
    expect(blob).toContain("case_sum_1");
    expect(blob).toContain("ps-claude-relay");
    expect(blob.toLowerCase()).not.toContain("sk-live-");
    expect(blob).not.toMatch(/[?&]api_key=/i);
  });

  test("session model change never mutates Probe Target in recorded cases", () => {
    const session = createRepairCaseSession({
      sessionModel: { provider: "a", modelId: "m1" },
    });
    const evidence = normalizeProbeRun({ result: passRun() });
    const layers = buildRepairCaseLayers({ caseId: "case_pt", evidence });
    recordRepairCase(session, layers);
    switchSessionModel(session, "b", "m2");
    switchSessionModel(session, "c", "m3");

    const detail = session.entries.find(
      (e) => e.type === "custom" && e.customType === REPAIR_CASE_DETAIL_CUSTOM_TYPE,
    );
    expect(detail).toBeDefined();
    if (detail?.type === "custom") {
      expect(detail.data.target.provider).toBe(target.provider);
      expect(detail.data.target.modelId).toBe(target.modelId);
    }

    const projected = projectSessionModelContext(session);
    expect(projected.sessionModel).toEqual({ provider: "c", modelId: "m3" });
    // Summary still names the Probe Target, not the latest session model
    const joined = projected.contextMessages.map((m) => m.content).join(" ");
    expect(joined).toContain(target.provider);
    expect(joined).toContain(target.modelId);
    expect(joined).not.toContain("m3");
  });

  test("summary entries use custom_message; detail entries use custom", () => {
    const session = createRepairCaseSession();
    const layers = buildRepairCaseLayers({
      caseId: "case_types",
      evidence: normalizeProbeRun({ result: failAuthRun() }),
    });
    recordRepairCase(session, layers);

    const summary = session.entries.find((e) => e.type === "custom_message");
    const detail = session.entries.find((e) => e.type === "custom");
    expect(summary).toMatchObject({
      type: "custom_message",
      customType: REPAIR_CASE_SUMMARY_CUSTOM_TYPE,
      display: true,
      details: { caseId: "case_types" },
    });
    expect(detail).toMatchObject({
      type: "custom",
      customType: REPAIR_CASE_DETAIL_CUSTOM_TYPE,
    });
    if (detail?.type === "custom") {
      expect(detail.data.caseId).toBe("case_types");
      expect(detail.data.evidence.stages.length).toBeGreaterThan(0);
    }
  });

  test("empty session projects empty context", () => {
    const session = createRepairCaseSession({
      sessionModel: { provider: "x", modelId: "y" },
    });
    const projected = projectSessionModelContext(session);
    expect(projected.contextMessages).toEqual([]);
    expect(projected.excludedFromContext).toEqual([]);
    expect(projected.sessionModel).toEqual({ provider: "x", modelId: "y" });
  });
});
