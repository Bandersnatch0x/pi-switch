import { describe, expect, test } from "bun:test";
import {
  createCompatibilityProbeExecutor,
  type CompatibilityProbeExecution,
} from "../extensions/probe-executor.ts";
import type { CcProvider } from "../src/types.ts";
import type {
  ProbeRequest,
  ProbeRunPrecheckSnapshot,
  ProbeTarget,
  ProbeTransport,
  ProbeTransportResult,
  RawProbeObservation,
} from "../src/probe/index.ts";

const provider = {
  id: "p1",
  piName: "ps-p1",
  displayName: "Relay One",
  appType: "codex",
} as CcProvider;

const target: ProbeTarget = {
  provider: provider.piName,
  modelId: "m1",
};

const precheckFail: ProbeRunPrecheckSnapshot = {
  status: "fail",
  allowProbe: false,
  checks: [],
  summary: "doctor failed",
};

const precheckPass: ProbeRunPrecheckSnapshot = {
  status: "pass",
  allowProbe: true,
  checks: [],
  summary: "doctor passed",
};

function okResult(request: ProbeRequest): ProbeTransportResult {
  if (request.contract === "tool") {
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
  return {
    httpStatus: 200,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "probe_ok" }],
      stopReason: "stop",
    },
  };
}

function expectRun(
  outcome: CompatibilityProbeExecution,
): asserts outcome is Extract<CompatibilityProbeExecution, { kind: "completed" }> {
  expect(outcome.kind).toBe("completed");
  if (outcome.kind !== "completed") {
    throw new Error(`expected completed execution, received ${outcome.kind}`);
  }
}

describe("Compatibility Probe Executor", () => {
  test("precheck stop does not register or create transport", async () => {
    let registrations = 0;
    let transports = 0;
    const executor = createCompatibilityProbeExecutor({
      buildPrecheck: async () => precheckFail,
      ensureProbeTarget: () => {
        registrations += 1;
        return { kind: "ready", source: "existing", model: {} };
      },
      createTransport: () => {
        transports += 1;
        return async (request) => okResult(request);
      },
      capturedAt: () => "2026-08-10T00:00:00.000Z",
    });

    const outcome = await executor.execute({ target, provider });

    expect(outcome.kind).toBe("precheck-stopped");
    if (outcome.kind !== "precheck-stopped") return;
    expect(registrations).toBe(0);
    expect(transports).toBe(0);
    expect(outcome).not.toHaveProperty("observations");
    expect(outcome.result).toMatchObject({
      ok: false,
      stages: [],
      requestCount: 0,
      stoppedReason: "precheck",
      budget: { maxRequests: 0, used: 0, maxTokens: 0, timeoutMs: 0 },
      precheck: precheckFail,
    });
    expect(outcome.evidence.stoppedReason).toBe("precheck");
  });

  test("registration failure is explicit and does not create transport", async () => {
    const events: string[] = [];
    const executor = createCompatibilityProbeExecutor({
      buildPrecheck: async () => {
        events.push("precheck");
        return precheckPass;
      },
      ensureProbeTarget: () => {
        events.push("registry");
        return { kind: "failed", error: "model unavailable" };
      },
      createTransport: () => {
        events.push("transport");
        return async (request) => okResult(request);
      },
    });

    const outcome = await executor.execute({ target, provider });

    expect(outcome).toEqual({
      kind: "registration-failed",
      error: "model unavailable",
    });
    expect(events).toEqual(["precheck", "registry"]);
  });

  test("completed execution normalizes once and exposes a verifier over the same run dependencies", async () => {
    const events: string[] = [];
    const requests: ProbeRequest[] = [];
    const model = { id: "registry-model" };
    let precheckBuilds = 0;
    let registrations = 0;
    let transportBuilds = 0;
    let normalizations = 0;
    const transport: ProbeTransport = async (request) => {
      events.push(`request:${request.contract}`);
      requests.push(request);
      return okResult(request);
    };
    const executor = createCompatibilityProbeExecutor({
      buildPrecheck: async () => {
        precheckBuilds += 1;
        events.push("precheck");
        return precheckPass;
      },
      ensureProbeTarget: () => {
        registrations += 1;
        events.push("registry");
        return { kind: "ready", source: "existing", model };
      },
      createTransport: () => {
        transportBuilds += 1;
        events.push("transport");
        return transport;
      },
      capturedAt: () => {
        normalizations += 1;
        return "2026-08-10T00:00:00.000Z";
      },
    });

    const outcome = await executor.execute({ target, provider });
    expectRun(outcome);
    expect(events.slice(0, 3)).toEqual(["precheck", "registry", "transport"]);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.evidence.target).toEqual(target);
    expect(outcome).not.toHaveProperty("observations");
    expect(normalizations).toBe(1);

    await outcome.verify({
      target: { ...target, claudeCodeCompat: true },
      contracts: ["basic"],
    });

    expect(precheckBuilds).toBe(1);
    expect(registrations).toBe(1);
    expect(transportBuilds).toBe(1);
    expect(normalizations).toBe(1);
    expect(requests.every((request) => request.model === model)).toBe(true);
    expect(requests[requests.length - 1]!.target.claudeCodeCompat).toBe(true);
  });

  test("normalization failures reject the execution", async () => {
    const executor = createCompatibilityProbeExecutor({
      buildPrecheck: async () => precheckPass,
      ensureProbeTarget: () => ({
        kind: "ready",
        source: "existing",
        model: {},
      }),
      createTransport: (captureObservation) => async (request) => {
        const observation = {} as RawProbeObservation;
        Object.defineProperty(observation, "contract", {
          get() {
            throw new Error("evidence normalization failed");
          },
        });
        captureObservation(observation);
        return okResult(request);
      },
    });

    await expect(executor.execute({ target, provider })).rejects.toThrow(
      "evidence normalization failed",
    );
  });
});
