/**
 * Evidence normalization + Repair Case dual-layer (issue #44 / ticket 2).
 * External behavior only; zero network.
 */
import { describe, expect, test } from "bun:test";
import {
  normalizeProbeRun,
  normalizeStageEvidence,
  redactProbeText,
  type ProbeRunResult,
  type ProbeTransportResult,
  type RawProbeObservation,
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

  test("explicit streaming frame evidence normalizes as unrepairable without persisting raw data", () => {
    const stage = normalizeStageEvidence({
      stage: {
        contract: "basic",
        status: "fail",
        category: "unknown",
        summary:
          "provider request failed: malformed SSE stream frame at https://relay.example/v1?api_key=sk-live-STREAM",
        requestCount: 1,
      },
      observation: {
        contract: "basic",
        response: {
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "failed to parse server-sent event stream frame",
          },
          rawBody: "data: sk-live-STREAM secret-api-key",
        },
      },
    });

    expect(stage.category).toBe("streaming");
    expect(stage.signatureId).toBe("streaming_failure");
    expect(stage.unrepairable).toBe(true);
    assertNoSensitivePayload(JSON.stringify(stage));
  });

  test("adjacent non-stream protocol evidence remains protocol", () => {
    const stage = normalizeStageEvidence({
      stage: {
        contract: "basic",
        status: "fail",
        category: "protocol",
        summary: "basic contract: no text content in assistant response",
        requestCount: 1,
      },
      observation: {
        contract: "basic",
        response: {
          message: {
            role: "assistant",
            content: [],
            stopReason: "stop",
          },
          rawBody: "invalid JSON response payload",
        },
      },
    });

    expect(stage.category).toBe("protocol");
    expect(stage.signatureId).toBe("contract_basic_no_text");
    expect(stage.unrepairable).toBeUndefined();
  });

  test("ambiguous connection failure remains unknown", () => {
    const stage = normalizeStageEvidence({
      stage: {
        contract: "basic",
        status: "fail",
        category: "unknown",
        summary: "provider request failed: connection closed unexpectedly",
        requestCount: 1,
      },
    });

    expect(stage.category).toBe("unknown");
    expect(stage.signatureId).toBe("unknown");
    expect(stage.unrepairable).toBeUndefined();
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
