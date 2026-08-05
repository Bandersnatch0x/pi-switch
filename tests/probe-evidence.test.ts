/**
 * Evidence normalization + Repair Case dual-layer (issue #44 / ticket 2).
 * External behavior only; zero network.
 */
import { describe, expect, test } from "bun:test";
import {
  REPAIR_CASE_DETAIL_CUSTOM_TYPE,
  REPAIR_CASE_SUMMARY_CUSTOM_TYPE,
  buildRepairCaseLayers,
  createCaseId,
  normalizeProbeRun,
  normalizeStageEvidence,
  projectRepairCaseIntoContext,
  redactProbeText,
  type NormalizedProbeRunEvidence,
  type ProbeRunResult,
  type ProbeTransportResult,
  type RawProbeObservation,
  type RepairCaseDetailData,
  type RepairCaseSessionLayers,
} from "../src/probe/index.ts";

const target = {
  provider: "ps-claude-relay",
  modelId: "claude-sonnet-probe",
  reasoning: true as boolean | undefined,
};

function passRun(): ProbeRunResult {
  return {
    target: { ...target },
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
    budget: {
      maxRequests: 9,
      used: 3,
      maxTokens: 32,
      timeoutMs: 15_000,
    },
  };
}

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
        summary: "HTTP 401: authentication or authorization failed",
        requestCount: 1,
      },
      {
        contract: "reasoning",
        status: "stopped",
        summary: "stopped: unrepairable (auth)",
        requestCount: 0,
      },
      {
        contract: "tool",
        status: "stopped",
        summary: "stopped: unrepairable (auth)",
        requestCount: 0,
      },
    ],
    ok: false,
    stoppedReason: "unrepairable",
    requestCount: 1,
    budget: {
      maxRequests: 9,
      used: 1,
      maxTokens: 32,
      timeoutMs: 15_000,
    },
  };
}

/** Keys / substrings that must never appear in durable evidence JSON. */
function assertNoSensitivePayload(serialized: string): void {
  const lower = serialized.toLowerCase();
  // prompt / response body markers from synthetic fixtures
  expect(lower).not.toContain("probe_basic:");
  expect(lower).not.toContain("probe_reasoning:");
  expect(lower).not.toContain("probe_tool:");
  expect(lower).not.toContain("secret-api-key");
  expect(lower).not.toContain("sk-live-");
  expect(lower).not.toContain("bearer sk-");
  expect(lower).not.toContain("rawbody");
  expect(lower).not.toContain("raw_body");
  expect(lower).not.toContain("responsebody");
  expect(lower).not.toContain("\"content\":[{");
  // query strings must be stripped from any URL-like text
  expect(serialized).not.toMatch(/[?&](key|api_key|token|access_token)=/i);
}

describe("normalizeProbeRun / normalizeStageEvidence (ticket 2)", () => {
  test("normalized evidence contains only durable facts (no prompt, body, secrets, query)", () => {
    const raw: RawProbeObservation = {
      contract: "basic",
      request: {
        messages: [
          {
            role: "user",
            content:
              "probe_basic: reply with exactly probe_ok and nothing else; key=secret-api-key",
          },
        ],
        headers: {
          Authorization: "Bearer sk-live-ABC123",
          "x-api-key": "secret-api-key",
          "User-Agent": "claude-cli/1.0 (external, cli)",
        },
        url: "https://relay.example/v1/messages?api_key=secret-api-key&token=abc",
      },
      response: {
        httpStatus: 401,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Unauthorized: invalid key secret-api-key" }],
          stopReason: "error",
          errorMessage: "HTTP 401 Unauthorized",
        },
        responseHeaders: {
          "www-authenticate": "Bearer",
          "x-request-id": "req-1",
          authorization: "should-not-persist-value",
          "set-cookie": "session=secret",
          "content-type": "application/json",
        },
        rawBody: '{"error":"invalid_api_key","message":"secret-api-key"}',
      },
    };

    const stage = normalizeStageEvidence({
      stage: {
        contract: "basic",
        status: "fail",
        category: "auth",
        unrepairable: true,
        httpStatus: 401,
        summary: "HTTP 401: authentication or authorization failed",
        requestCount: 1,
      },
      observation: raw,
    });

    const json = JSON.stringify(stage);
    assertNoSensitivePayload(json);

    // Normalized shape: wide category, signature, allowlisted header names, redacted summary
    expect(stage.category).toBe("auth");
    expect(stage.signatureId).toBeTruthy();
    expect(stage.signatureId).not.toBe("");
    expect(stage.unrepairable).toBe(true);
    expect(stage.httpStatus).toBe(401);
    expect(stage.contract).toBe("basic");
    expect(stage.status).toBe("fail");
    expect(typeof stage.summary).toBe("string");
    expect(stage.summary.length).toBeGreaterThan(0);

    // Header *names* only (allowlist); never sensitive header names or any values
    expect(stage.allowedHeaderNames).toEqual(
      expect.arrayContaining(["content-type", "www-authenticate", "x-request-id"]),
    );
    expect(stage.allowedHeaderNames.every((n) => typeof n === "string")).toBe(true);
    expect(stage.allowedHeaderNames.map((n) => n.toLowerCase())).not.toContain(
      "authorization",
    );
    expect(stage.allowedHeaderNames.map((n) => n.toLowerCase())).not.toContain(
      "set-cookie",
    );

    // Must not retain request/response bodies or prompts as fields
    expect(stage).not.toHaveProperty("rawBody");
    expect(stage).not.toHaveProperty("request");
    expect(stage).not.toHaveProperty("response");
    expect(stage).not.toHaveProperty("messages");
    expect(stage).not.toHaveProperty("content");
  });

  test("full probe run normalizes without embedding raw transport payloads", () => {
    const run = failAuthRun();
    const observations: RawProbeObservation[] = [
      {
        contract: "basic",
        request: {
          messages: [{ role: "user", content: "probe_basic: secret-api-key" }],
          url: "https://x.example/v1?api_key=sk-live-1",
        },
        response: {
          httpStatus: 401,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "nope" }],
            stopReason: "error",
          },
          rawBody: "secret-api-key in body",
        },
      },
    ];

    const evidence = normalizeProbeRun({
      result: run,
      observations,
      capturedAt: "2026-08-04T00:00:00.000Z",
    });

    const json = JSON.stringify(evidence);
    assertNoSensitivePayload(json);

    expect(evidence.ok).toBe(false);
    expect(evidence.target).toEqual({
      provider: target.provider,
      modelId: target.modelId,
      reasoning: true,
    });
    expect(evidence.stages).toHaveLength(3);
    expect(evidence.stages[0]!.category).toBe("auth");
    expect(evidence.stages[0]!.signatureId).toMatch(/auth|401|http/i);
    expect(evidence.capturedAt).toBe("2026-08-04T00:00:00.000Z");
    expect(evidence.requestCount).toBe(1);
    expect(evidence.budget.used).toBe(1);

    // Durable evidence must not have a place for raw bodies
    expect(json).not.toContain("rawBody");
    expect(json).not.toContain("observations");
  });

  test("normalization preserves effective target compat flags", () => {
    const run: ProbeRunResult = {
      ...failAuthRun(),
      target: {
        ...failAuthRun().target,
        fingerprint: "codex",
        claudeCodeCompat: true,
        geminiToolCompat: true,
      },
    };

    const evidence = normalizeProbeRun({ result: run });
    expect(evidence.target.fingerprint).toBe("codex");
    expect(evidence.target.claudeCodeCompat).toBe(true);
    expect(evidence.target.geminiToolCompat).toBe(true);
  });

  test("ambiguous evidence yields signature unknown — no guessing", () => {
    const stage = normalizeStageEvidence({
      stage: {
        contract: "basic",
        status: "fail",
        category: "unknown",
        httpStatus: 418,
        summary: "HTTP 418: client error",
        requestCount: 1,
      },
      observation: {
        contract: "basic",
        response: {
          httpStatus: 418,
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "I'm a teapot — something odd happened",
          },
        },
      },
    });

    expect(stage.category).toBe("unknown");
    expect(stage.signatureId).toBe("unknown");
  });

  test("error without distinctive pattern stays unknown (no fingerprint guess)", () => {
    const stage = normalizeStageEvidence({
      stage: {
        contract: "basic",
        status: "fail",
        category: "unknown",
        summary: "provider returned stopReason=error",
        requestCount: 1,
      },
      observation: {
        contract: "basic",
        response: {
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "upstream failed in a vague way",
          } satisfies ProbeTransportResult["message"],
        },
      },
    });

    expect(stage.signatureId).toBe("unknown");
    expect(stage.category).toBe("unknown");
  });

  test("known HTTP statuses map to stable signature ids without leaking bodies", () => {
    const s401 = normalizeStageEvidence({
      stage: {
        contract: "basic",
        status: "fail",
        category: "auth",
        unrepairable: true,
        httpStatus: 401,
        summary: "HTTP 401",
        requestCount: 1,
      },
    });
    const s429 = normalizeStageEvidence({
      stage: {
        contract: "basic",
        status: "fail",
        category: "auth",
        unrepairable: true,
        httpStatus: 429,
        summary: "HTTP 429",
        requestCount: 1,
      },
    });
    const s503 = normalizeStageEvidence({
      stage: {
        contract: "basic",
        status: "fail",
        category: "protocol",
        unrepairable: true,
        httpStatus: 503,
        summary: "HTTP 503",
        requestCount: 1,
      },
    });

    expect(s401.signatureId).not.toBe("unknown");
    expect(s429.signatureId).not.toBe("unknown");
    expect(s503.signatureId).not.toBe("unknown");
    expect(s401.signatureId).not.toBe(s429.signatureId);
    expect(JSON.stringify([s401, s429, s503])).not.toMatch(/secret|bearer/i);
  });

  test("redactProbeText strips secrets, query strings, and bearer tokens", () => {
    const raw =
      "fail at https://relay.example/v1/messages?api_key=sk-live-XYZ&token=abc Authorization: Bearer sk-live-XYZ secret-api-key";
    const redacted = redactProbeText(raw);
    expect(redacted.toLowerCase()).not.toContain("sk-live-");
    expect(redacted.toLowerCase()).not.toContain("secret-api-key");
    expect(redacted).not.toMatch(/[?&](api_key|token)=/i);
    expect(redacted.toLowerCase()).not.toContain("bearer sk-");
  });

  test("pass stages normalize to ok without inventing a failure signature", () => {
    const evidence = normalizeProbeRun({ result: passRun() });
    expect(evidence.ok).toBe(true);
    for (const s of evidence.stages) {
      expect(s.status).toBe("pass");
      expect(s.category).toBe("ok");
      expect(s.signatureId).toBe("pass");
    }
  });
});

describe("Repair Case dual-layer (ticket 2)", () => {
  test("summary and detail share the same Case ID", () => {
    const evidence = normalizeProbeRun({
      result: failAuthRun(),
      capturedAt: "2026-08-04T12:00:00.000Z",
    });
    const caseId = createCaseId(() => new Date("2026-08-04T12:00:00.000Z"));
    const layers = buildRepairCaseLayers({ caseId, evidence });

    expect(layers.caseId).toBe(caseId);
    expect(layers.summary.caseId).toBe(caseId);
    expect(layers.detail.caseId).toBe(caseId);
    expect(layers.summaryEntry.customType).toBe(REPAIR_CASE_SUMMARY_CUSTOM_TYPE);
    expect(layers.detailEntry.customType).toBe(REPAIR_CASE_DETAIL_CUSTOM_TYPE);
    expect(layers.summaryEntry.type).toBe("custom_message");
    expect(layers.detailEntry.type).toBe("custom");
  });

  test("summary enters model context; detail does not (session structure)", () => {
    const evidence = normalizeProbeRun({ result: failAuthRun() });
    const layers = buildRepairCaseLayers({
      caseId: "case_test_1",
      evidence,
    });

    const ctx = projectRepairCaseIntoContext(layers);

    // Summary content is projected into context as text
    expect(ctx.contextMessages.length).toBe(1);
    expect(ctx.contextMessages[0]!.role).toBe("user");
    const text =
      typeof ctx.contextMessages[0]!.content === "string"
        ? ctx.contextMessages[0]!.content
        : JSON.stringify(ctx.contextMessages[0]!.content);
    expect(text).toContain("case_test_1");
    expect(text).toContain(target.provider);
    expect(text).toContain(target.modelId);

    // Detail custom entry is recorded but excluded from context projection
    expect(ctx.excludedFromContext).toHaveLength(1);
    expect(ctx.excludedFromContext[0]!.type).toBe("custom");
    expect(ctx.excludedFromContext[0]!.customType).toBe(
      REPAIR_CASE_DETAIL_CUSTOM_TYPE,
    );
    expect(ctx.excludedFromContext[0]!.data.caseId).toBe("case_test_1");

    // Full context serialization must not include detailed normalized stage signatures
    // beyond the short summary (detail payload stays out)
    const ctxJson = JSON.stringify(ctx.contextMessages);
    const detailJson = JSON.stringify(layers.detail);
    expect(detailJson).toContain("signatureId");
    // context has only the short summary string, not the detail object tree
    expect(ctxJson).not.toContain('"signatureId"');
    expect(ctxJson).not.toContain('"allowedHeaderNames"');
    expect(ctxJson).not.toContain('"budget"');
  });

  test("summary is redacted: target identity + contracts + conclusion, no secrets", () => {
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
    const layers = buildRepairCaseLayers({ caseId: "case_redact", evidence });

    const summaryText = layers.summaryEntry.content;
    expect(typeof summaryText).toBe("string");
    const s = summaryText as string;
    expect(s.toLowerCase()).not.toContain("sk-live-");
    expect(s).not.toMatch(/[?&]api_key=/i);
    expect(s).toContain("case_redact");
    expect(s).toMatch(/basic/i);
    expect(s).toMatch(/fail|auth|unrepairable|FAIL/i);
    expect(s).toContain(target.provider);

    assertNoSensitivePayload(JSON.stringify(layers));
  });

  test("raw body never lands on durable Repair Case detail (persistence shape)", () => {
    const observations: RawProbeObservation[] = [
      {
        contract: "basic",
        request: {
          messages: [{ role: "user", content: "probe_basic: do not persist" }],
        },
        response: {
          httpStatus: 401,
          rawBody: '{"error":"secret-api-key"}',
          message: {
            role: "assistant",
            content: [{ type: "text", text: "body text secret-api-key" }],
            stopReason: "error",
          },
        },
      },
    ];
    const evidence = normalizeProbeRun({
      result: failAuthRun(),
      observations,
    });
    const layers = buildRepairCaseLayers({ caseId: "case_disk", evidence });

    // Simulate "write to session / disk" of both layers
    const persisted = JSON.stringify({
      summaryEntry: layers.summaryEntry,
      detailEntry: layers.detailEntry,
    });
    assertNoSensitivePayload(persisted);
    expect(persisted).not.toContain("rawBody");
    expect(persisted).not.toContain("probe_basic:");
    expect(persisted).not.toContain("do not persist");

    const detail = layers.detailEntry.data as RepairCaseDetailData;
    expect(detail.evidence.stages[0]).not.toHaveProperty("rawBody");
    expect(detail.evidence).not.toHaveProperty("observations");
  });

  test("createCaseId produces non-empty stable-format ids", () => {
    const a = createCaseId(() => new Date("2026-01-01T00:00:00.000Z"), () => 0.123456);
    const b = createCaseId(() => new Date("2026-01-01T00:00:00.000Z"), () => 0.123456);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(8);
    expect(a).toMatch(/^case_/);
  });

  test("layers expose dual customType constants for session scanners", () => {
    expect(REPAIR_CASE_SUMMARY_CUSTOM_TYPE).toBe("ps-repair-case-summary");
    expect(REPAIR_CASE_DETAIL_CUSTOM_TYPE).toBe("ps-repair-case-detail");
  });

  test("multiple cases keep independent case ids on both layers", () => {
    const e1 = normalizeProbeRun({ result: passRun() }) as NormalizedProbeRunEvidence;
    const e2 = normalizeProbeRun({ result: failAuthRun() });
    const l1 = buildRepairCaseLayers({ caseId: "case_a", evidence: e1 });
    const l2 = buildRepairCaseLayers({ caseId: "case_b", evidence: e2 });
    expect(l1.caseId).not.toBe(l2.caseId);
    expect(l1.summary.caseId).toBe("case_a");
    expect(l2.detail.caseId).toBe("case_b");
    const ctx = projectRepairCaseIntoContext(l1 as RepairCaseSessionLayers);
    expect(JSON.stringify(ctx.contextMessages)).toContain("case_a");
    expect(JSON.stringify(ctx.contextMessages)).not.toContain("case_b");
  });
});
