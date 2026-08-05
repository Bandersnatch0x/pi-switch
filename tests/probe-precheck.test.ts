/**
 * Target Doctor precheck subset (issue #45 / ticket 3).
 * Precheck is injectable; transport/doctor never hit network in unit tests.
 */
import { describe, expect, test } from "bun:test";
import { isSwitchable } from "../src/parse/index.ts";
import type { CcProvider } from "../src/types.ts";
import {
  PROBE_TARGET_PRECHECK_DIMENSIONS,
  formatProbeResultJson,
  runProbe,
  runTargetDoctorPrecheck,
  type ProbePrecheckResult,
  type ProbeRequest,
  type ProbeTransport,
  type ProbeTransportResult,
  type TargetDoctorPrecheckInput,
} from "../src/probe/index.ts";

function mkProvider(
  partial: Partial<CcProvider> & Pick<CcProvider, "id" | "displayName" | "appType">,
): CcProvider {
  return {
    piName: `ps-${partial.appType}-${partial.id}`,
    api: "anthropic-messages",
    baseUrl: "https://example.com",
    apiKey: "sk-test",
    authHeader: true,
    configModels: ["claude-sonnet-probe"],
    meta: {},
    isCurrentInCc: false,
    ...partial,
  };
}

const targetBase = {
  provider: "ps-claude-1",
  modelId: "claude-sonnet-probe",
};

function healthyInput(
  overrides: Partial<TargetDoctorPrecheckInput> = {},
): TargetDoctorPrecheckInput {
  const p = mkProvider({
    id: "1",
    displayName: "relay",
    appType: "claude",
    piName: "ps-claude-1",
  });
  return {
    target: { ...targetBase, reasoning: true },
    dbExists: true,
    dbPath: "/db/cc-switch.db",
    providers: [p],
    ...overrides,
  };
}

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

function okTool(name = "probe_echo"): ProbeTransportResult {
  return {
    httpStatus: 200,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc1", name, arguments: { msg: "probe_ok" } }],
      stopReason: "toolUse",
    },
  };
}

function recordingTransport(
  handler: (req: ProbeRequest, n: number) => ProbeTransportResult | Promise<ProbeTransportResult>,
): { transport: ProbeTransport; calls: ProbeRequest[] } {
  const calls: ProbeRequest[] = [];
  const transport: ProbeTransport = async (req) => {
    calls.push(req);
    return handler(req, calls.length);
  };
  return { transport, calls };
}

describe("runTargetDoctorPrecheck (ticket 3)", () => {
  test("covers only target-related dimensions (DB/parse/credentials/routing/capabilities/fingerprint)", () => {
    const report = runTargetDoctorPrecheck(
      healthyInput({
        routingProbe: { url: "http://127.0.0.1:9999", reachable: true },
        fingerprint: {
          status: "pass",
          detail: "codex=0.1(local) · claude=2.0(local)",
        },
        capabilities: {
          status: "pass",
          detail: "claude-sonnet-probe: context=200000",
        },
      }),
    );

    const dims = new Set(report.checks.map((c) => c.dimension));
    for (const d of dims) {
      expect(PROBE_TARGET_PRECHECK_DIMENSIONS).toContain(d);
    }
    // All six when data provided
    expect(dims).toEqual(
      new Set(["db", "parse", "credentials", "routing", "capabilities", "fingerprint"]),
    );
    // Never full-doctor extras
    const ids = report.checks.map((c) => c.id);
    expect(ids).not.toContain("sqlite3");
    expect(ids).not.toContain("pins");
    expect(ids).not.toContain("recent");
    expect(ids).not.toContain("sdk");
    expect(ids).not.toContain("headers");
    expect(ids).not.toContain("identity-migration");
    expect(ids.some((id) => id.startsWith("tier-"))).toBe(false);
  });

  test("healthy target: pass, allowProbe true", () => {
    const report = runTargetDoctorPrecheck(healthyInput());
    expect(report.status).toBe("pass");
    expect(report.allowProbe).toBe(true);
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
  });

  test("DB missing: FAIL blocks probe", () => {
    const report = runTargetDoctorPrecheck(
      healthyInput({ dbExists: false, providers: [] }),
    );
    expect(report.status).toBe("fail");
    expect(report.allowProbe).toBe(false);
    const db = report.checks.find((c) => c.dimension === "db");
    expect(db?.status).toBe("fail");
  });

  test("providers unreadable: FAIL", () => {
    const report = runTargetDoctorPrecheck(
      healthyInput({
        providers: [],
        providersError: "sqlite3: database is locked",
      }),
    );
    expect(report.status).toBe("fail");
    expect(report.allowProbe).toBe(false);
    expect(report.checks.some((c) => c.dimension === "db" && c.status === "fail")).toBe(true);
  });

  test("target provider not found: parse FAIL", () => {
    const report = runTargetDoctorPrecheck(
      healthyInput({
        target: { provider: "missing-provider", modelId: "x" },
      }),
    );
    expect(report.status).toBe("fail");
    expect(report.allowProbe).toBe(false);
    const parse = report.checks.find((c) => c.dimension === "parse");
    expect(parse?.status).toBe("fail");
    expect(parse?.detail).toMatch(/not found|missing/i);
  });

  test("parseError on provider: parse FAIL", () => {
    const broken = mkProvider({
      id: "1",
      displayName: "relay",
      appType: "claude",
      piName: "ps-claude-1",
      api: null,
      apiKey: "",
      baseUrl: "",
      parseError: "missing apiKey",
      configModels: ["claude-sonnet-probe"],
    });
    expect(isSwitchable(broken)).toBe(false);

    const report = runTargetDoctorPrecheck(healthyInput({ providers: [broken] }));
    expect(report.status).toBe("fail");
    expect(report.allowProbe).toBe(false);
    expect(report.checks.find((c) => c.dimension === "parse")?.status).toBe("fail");
  });

  test("missing credentials (not switchable): credentials FAIL", () => {
    const noKey = mkProvider({
      id: "1",
      displayName: "relay",
      appType: "claude",
      piName: "ps-claude-1",
      apiKey: "",
      parseError: undefined,
      api: "anthropic-messages",
      baseUrl: "https://example.com",
    });
    // isSwitchable requires apiKey
    expect(isSwitchable(noKey)).toBe(false);

    const report = runTargetDoctorPrecheck(healthyInput({ providers: [noKey] }));
    expect(report.status).toBe("fail");
    expect(report.allowProbe).toBe(false);
    const creds = report.checks.find((c) => c.dimension === "credentials");
    expect(creds?.status).toBe("fail");
  });

  test("model not in provider list: parse WARN, still allowProbe", () => {
    const report = runTargetDoctorPrecheck(
      healthyInput({
        target: { provider: "ps-claude-1", modelId: "remote-only-model" },
      }),
    );
    expect(report.status).toBe("warn");
    expect(report.allowProbe).toBe(true);
    const parse = report.checks.find((c) => c.dimension === "parse");
    expect(parse?.status).toBe("warn");
  });

  test("routing unreachable: WARN, allowProbe true", () => {
    const report = runTargetDoctorPrecheck(
      healthyInput({
        routingProbe: { url: "http://127.0.0.1:1234", reachable: false },
      }),
    );
    expect(report.status).toBe("warn");
    expect(report.allowProbe).toBe(true);
    expect(report.checks.find((c) => c.dimension === "routing")?.status).toBe("warn");
  });

  test("fingerprint fallback: WARN, allowProbe true", () => {
    const report = runTargetDoctorPrecheck(
      healthyInput({
        fingerprint: {
          status: "warn",
          detail: "codex uses fallback version",
          fix: "install CLI or pin vars",
        },
      }),
    );
    expect(report.status).toBe("warn");
    expect(report.allowProbe).toBe(true);
    expect(report.checks.find((c) => c.dimension === "fingerprint")?.status).toBe("warn");
  });

  test("capabilities conflict: WARN, allowProbe true", () => {
    const report = runTargetDoctorPrecheck(
      healthyInput({
        capabilities: {
          status: "warn",
          detail: "context conflict models.dev vs override",
          fix: "pin explicit override",
        },
      }),
    );
    expect(report.status).toBe("warn");
    expect(report.allowProbe).toBe(true);
    expect(report.checks.find((c) => c.dimension === "capabilities")?.status).toBe("warn");
  });

  test("omitted soft dimensions are not invented", () => {
    const report = runTargetDoctorPrecheck(healthyInput());
    const dims = report.checks.map((c) => c.dimension);
    expect(dims).toContain("db");
    expect(dims).toContain("parse");
    expect(dims).toContain("credentials");
    expect(dims).not.toContain("routing");
    expect(dims).not.toContain("capabilities");
    expect(dims).not.toContain("fingerprint");
  });

  test("matches provider by piName, displayName, or id", () => {
    const p = mkProvider({
      id: "42",
      displayName: "My Relay",
      appType: "claude",
      piName: "ps-claude-42",
    });
    for (const provider of ["ps-claude-42", "My Relay", "42"]) {
      const report = runTargetDoctorPrecheck(
        healthyInput({
          target: { provider, modelId: "claude-sonnet-probe" },
          providers: [p],
        }),
      );
      expect(report.allowProbe).toBe(true);
      expect(report.status).toBe("pass");
    }
  });
});

describe("runProbe precheck integration (ticket 3)", () => {
  test("precheck FAIL blocks all transport calls (zero network)", async () => {
    let hit = 0;
    const transport: ProbeTransport = async () => {
      hit += 1;
      return okText();
    };

    const precheck: ProbePrecheckResult = {
      status: "fail",
      allowProbe: false,
      checks: [
        {
          id: "db",
          dimension: "db",
          title: "Database",
          status: "fail",
          detail: "DB missing",
          fix: "create DB",
        },
      ],
      summary: "precheck fail: db",
    };

    const result = await runProbe({
      target: { ...targetBase, reasoning: true },
      model: {},
      transport,
      precheck,
    });

    expect(hit).toBe(0);
    expect(result.requestCount).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("precheck");
    expect(result.precheck?.status).toBe("fail");
    expect(result.precheck?.allowProbe).toBe(false);
    // Stages present as stopped — probe never started
    expect(result.stages.length).toBeGreaterThan(0);
    expect(result.stages.every((s) => s.status === "stopped")).toBe(true);
    expect(result.stages[0]!.summary).toMatch(/precheck/i);
  });

  test("precheck WARN is attached and probe continues", async () => {
    const { transport, calls } = recordingTransport((req) => {
      if (req.contract === "basic") return okText();
      if (req.contract === "tool") return okTool();
      throw new Error(`unexpected ${req.contract}`);
    });

    const precheck: ProbePrecheckResult = {
      status: "warn",
      allowProbe: true,
      checks: [
        {
          id: "fingerprint",
          dimension: "fingerprint",
          title: "Fingerprint",
          status: "warn",
          detail: "fallback versions",
        },
      ],
      summary: "precheck warn: fingerprint",
    };

    const result = await runProbe({
      target: { ...targetBase, reasoning: false },
      model: {},
      transport,
      precheck,
    });

    expect(calls.length).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.stoppedReason).toBeUndefined();
    expect(result.precheck?.status).toBe("warn");
    expect(result.precheck?.allowProbe).toBe(true);
  });

  test("precheck can be an async injectable function", async () => {
    let precheckCalls = 0;
    let transportCalls = 0;

    const result = await runProbe({
      target: { ...targetBase, reasoning: false },
      model: {},
      transport: async (req) => {
        transportCalls += 1;
        if (req.contract === "tool") return okTool();
        return okText();
      },
      precheck: async () => {
        precheckCalls += 1;
        return runTargetDoctorPrecheck(healthyInput());
      },
    });

    expect(precheckCalls).toBe(1);
    expect(transportCalls).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.precheck?.allowProbe).toBe(true);
  });

  test("async precheck FAIL still blocks transport", async () => {
    let transportCalls = 0;
    const result = await runProbe({
      target: { ...targetBase, reasoning: true },
      model: {},
      transport: async () => {
        transportCalls += 1;
        return okText();
      },
      precheck: async () =>
        runTargetDoctorPrecheck(healthyInput({ dbExists: false, providers: [] })),
    });

    expect(transportCalls).toBe(0);
    expect(result.stoppedReason).toBe("precheck");
    expect(result.ok).toBe(false);
  });

  test("omitted precheck keeps prior engine behavior (no precheck field)", async () => {
    const { transport, calls } = recordingTransport((req) => {
      if (req.contract === "tool") return okTool();
      return okText();
    });

    const result = await runProbe({
      target: { ...targetBase, reasoning: false },
      model: {},
      transport,
    });

    expect(calls.length).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.precheck).toBeUndefined();
    expect(result.stoppedReason).toBeUndefined();
  });

  test("headless JSON includes precheck when present", async () => {
    const precheck: ProbePrecheckResult = {
      status: "fail",
      allowProbe: false,
      checks: [
        {
          id: "credentials",
          dimension: "credentials",
          title: "Credentials",
          status: "fail",
          detail: "missing apiKey",
        },
      ],
      summary: "precheck fail: credentials",
    };

    const result = await runProbe({
      target: { ...targetBase },
      model: {},
      transport: async () => okText(),
      precheck,
    });

    const parsed = JSON.parse(formatProbeResultJson(result));
    expect(parsed.precheck.status).toBe("fail");
    expect(parsed.precheck.allowProbe).toBe(false);
    expect(parsed.stoppedReason).toBe("precheck");
    expect(parsed.requestCount).toBe(0);
  });
});
