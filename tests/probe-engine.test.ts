/**
 * Probe engine external behavior (issue #43 / ticket 1).
 * Transport is always injected — zero network.
 */
import { describe, expect, test } from "bun:test";
import {
  PROBE_MAX_REQUESTS,
  PROBE_MAX_TOKENS,
  PROBE_TIMEOUT_MS,
  formatProbeResultJson,
  runProbe,
  type ProbeContractId,
  type ProbeRequest,
  type ProbeTransport,
  type ProbeTransportResult,
} from "../src/probe/index.ts";

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

function okThinking(text = "probe_ok"): ProbeTransportResult {
  return {
    httpStatus: 200,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "brief" },
        { type: "text", text },
      ],
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

function httpError(status: number, errorMessage?: string): ProbeTransportResult {
  return {
    httpStatus: status,
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: errorMessage ?? `HTTP ${status}`,
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

const targetBase = {
  provider: "ps-claude-relay",
  modelId: "claude-sonnet-probe",
};

describe("runProbe (ticket 1)", () => {
  test("headless default stages: basic → reasoning → tool, structured ok result", async () => {
    const { transport, calls } = recordingTransport((req) => {
      if (req.contract === "basic") return okText();
      if (req.contract === "reasoning") return okThinking();
      if (req.contract === "tool") return okTool();
      throw new Error(`unexpected contract ${req.contract}`);
    });

    const result = await runProbe({
      target: { ...targetBase, reasoning: true },
      model: { id: targetBase.modelId },
      transport,
      now: () => 1_700_000_000_000,
    });

    expect(result.ok).toBe(true);
    expect(result.stages.map((s) => s.contract)).toEqual(["basic", "reasoning", "tool"]);
    expect(result.stages.every((s) => s.status === "pass")).toBe(true);
    expect(result.requestCount).toBe(3);
    expect(result.stoppedReason).toBeUndefined();
    expect(calls.map((c) => c.contract)).toEqual(["basic", "reasoning", "tool"]);

    // headless structured output is JSON-serializable
    const json = formatProbeResultJson(result);
    const parsed = JSON.parse(json);
    expect(parsed.ok).toBe(true);
    expect(parsed.target).toEqual({
      provider: targetBase.provider,
      modelId: targetBase.modelId,
      reasoning: true,
    });
    expect(parsed.stages).toHaveLength(3);
    expect(parsed.budget).toEqual({
      maxRequests: PROBE_MAX_REQUESTS,
      used: 3,
      maxTokens: PROBE_MAX_TOKENS,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  });

  test("transport receives the target on every request (candidate flags included)", async () => {
    const { transport, calls } = recordingTransport((req) => {
      if (req.contract === "basic") return okText();
      if (req.contract === "reasoning") return okThinking();
      if (req.contract === "tool") return okTool();
      throw new Error(`unexpected contract ${req.contract}`);
    });

    const targetWithFlags = {
      ...targetBase,
      reasoning: true,
      fingerprint: "gemini" as const,
      geminiToolCompat: true,
    };
    const result = await runProbe({
      target: targetWithFlags,
      model: { id: targetBase.modelId },
      transport,
    });

    expect(result.ok).toBe(true);
    // Every request carries the full target, so a production transport can
    // apply fingerprint / claudeCodeCompat / geminiToolCompat per request.
    expect(calls.length).toBeGreaterThan(0);
    for (const req of calls) {
      expect(req.target).toEqual(targetWithFlags);
    }
  });

  test("skips reasoning when target does not claim reasoning support", async () => {
    const { transport, calls } = recordingTransport((req) => {
      if (req.contract === "basic") return okText();
      if (req.contract === "tool") return okTool();
      throw new Error(`reasoning must be skipped, got ${req.contract}`);
    });

    const result = await runProbe({
      target: { ...targetBase, reasoning: false },
      model: { id: targetBase.modelId },
      transport,
    });

    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.contract)).toEqual(["basic", "tool"]);
    const reasoning = result.stages.find((s) => s.contract === "reasoning");
    expect(reasoning?.status).toBe("skip");
    expect(reasoning?.summary).toMatch(/reasoning/i);
  });

  test("skips reasoning when reasoning claim is omitted", async () => {
    const { transport, calls } = recordingTransport((req) => {
      if (req.contract === "basic") return okText();
      if (req.contract === "tool") return okTool();
      throw new Error(`unexpected ${req.contract}`);
    });

    const result = await runProbe({
      target: { ...targetBase },
      model: {},
      transport,
    });

    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.contract)).toEqual(["basic", "tool"]);
    expect(result.stages.find((s) => s.contract === "reasoning")?.status).toBe("skip");
  });

  test("enforces budget: maxTokens ≤32, timeout signal 15s, max 9 requests", async () => {
    const signals: AbortSignal[] = [];
    const { transport, calls } = recordingTransport((req) => {
      if (req.options.signal) signals.push(req.options.signal);
      if (req.contract === "tool") return okTool();
      if (req.contract === "reasoning") return okThinking();
      return okText();
    });

    const result = await runProbe({
      target: { ...targetBase, reasoning: true },
      model: {},
      transport,
      createSignal: (ms) => {
        expect(ms).toBe(PROBE_TIMEOUT_MS);
        return AbortSignal.timeout(ms);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.budget.maxRequests).toBe(9);
    expect(result.budget.maxTokens).toBe(32);
    expect(result.budget.timeoutMs).toBe(15_000);
    for (const c of calls) {
      expect(c.options.maxTokens).toBe(PROBE_MAX_TOKENS);
      expect(c.options.maxTokens).toBeLessThanOrEqual(32);
      expect(c.options.signal).toBeDefined();
    }
    expect(signals.length).toBe(3);
  });

  test("stops when request budget is exhausted", async () => {
    let n = 0;
    const transport: ProbeTransport = async () => {
      n += 1;
      return okText();
    };

    const result = await runProbe({
      target: { ...targetBase, reasoning: true },
      model: {},
      transport,
      maxRequests: 1,
    });

    expect(n).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("budget");
    expect(result.requestCount).toBe(1);
    expect(result.stages.find((s) => s.contract === "basic")?.status).toBe("pass");
    // subsequent planned stages not executed
    expect(result.stages.find((s) => s.contract === "reasoning")?.status).toBe("stopped");
    expect(result.stages.find((s) => s.contract === "tool")?.status).toBe("stopped");
  });

  test("401 stops immediately and is unrepairable (auth)", async () => {
    const { transport, calls } = recordingTransport(() => httpError(401, "Unauthorized"));

    const result = await runProbe({
      target: { ...targetBase, reasoning: true },
      model: {},
      transport,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.contract).toBe("basic");
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("unrepairable");
    const basic = result.stages.find((s) => s.contract === "basic")!;
    expect(basic.status).toBe("fail");
    expect(basic.category).toBe("auth");
    expect(basic.unrepairable).toBe(true);
    expect(basic.httpStatus).toBe(401);
    expect(result.stages.find((s) => s.contract === "reasoning")?.status).toBe("stopped");
    expect(result.stages.find((s) => s.contract === "tool")?.status).toBe("stopped");
  });

  test("429 stops immediately as unrepairable", async () => {
    const { transport, calls } = recordingTransport(() => httpError(429));

    const result = await runProbe({
      target: { ...targetBase, reasoning: true },
      model: {},
      transport,
    });

    expect(calls).toHaveLength(1);
    expect(result.stoppedReason).toBe("unrepairable");
    const basic = result.stages.find((s) => s.contract === "basic")!;
    expect(basic.unrepairable).toBe(true);
    expect(basic.httpStatus).toBe(429);
    expect(basic.category).toBe("auth");
  });

  test("5xx stops immediately as unrepairable", async () => {
    const { transport, calls } = recordingTransport(() => httpError(503));

    const result = await runProbe({
      target: { ...targetBase, reasoning: true },
      model: {},
      transport,
    });

    expect(calls).toHaveLength(1);
    expect(result.stoppedReason).toBe("unrepairable");
    const basic = result.stages.find((s) => s.contract === "basic")!;
    expect(basic.unrepairable).toBe(true);
    expect(basic.httpStatus).toBe(503);
    expect(basic.category).toBe("protocol");
  });

  test("explicit SSE frame failure is streaming and unrepairable", async () => {
    const { transport, calls } = recordingTransport(() => ({
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "SSE stream frame parse failed: malformed data event",
      },
    }));

    const result = await runProbe({
      target: { ...targetBase, reasoning: true },
      model: {},
      transport,
    });

    expect(calls).toHaveLength(1);
    expect(result.stoppedReason).toBe("unrepairable");
    const basic = result.stages.find((s) => s.contract === "basic")!;
    expect(basic.category).toBe("streaming");
    expect(basic.unrepairable).toBe(true);
  });

  test("auth status retains priority over stream-like error text", async () => {
    const { transport } = recordingTransport(() =>
      httpError(401, "SSE stream frame failed after authentication rejection"),
    );

    const result = await runProbe({
      target: { ...targetBase, reasoning: true },
      model: {},
      transport,
    });

    expect(result.stoppedReason).toBe("unrepairable");
    const basic = result.stages.find((s) => s.contract === "basic")!;
    expect(basic.category).toBe("auth");
    expect(basic.httpStatus).toBe(401);
  });

  test("non-fatal stage failure stops subsequent stages (no skip of earlier)", async () => {
    const { transport, calls } = recordingTransport((req) => {
      if (req.contract === "basic") {
        return {
          httpStatus: 200,
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "empty response",
          },
        };
      }
      throw new Error("must not continue");
    });

    const result = await runProbe({
      target: { ...targetBase, reasoning: true },
      model: {},
      transport,
    });

    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("failure");
    expect(result.stages.find((s) => s.contract === "basic")?.status).toBe("fail");
    expect(result.stages.find((s) => s.contract === "reasoning")?.status).toBe("stopped");
    expect(result.stages.find((s) => s.contract === "tool")?.status).toBe("stopped");
  });

  test("requests never carry session history; payload is minimal synthetic content", async () => {
    const { transport, calls } = recordingTransport((req) => {
      if (req.contract === "tool") return okTool();
      if (req.contract === "reasoning") return okThinking();
      return okText();
    });

    await runProbe({
      target: { ...targetBase, reasoning: true },
      model: {},
      transport,
      now: () => 42,
    });

    for (const c of calls) {
      expect(c.context.messages).toHaveLength(1);
      expect(c.context.messages[0]!.role).toBe("user");
      expect(typeof c.context.messages[0]!.content).toBe("string");
      const text = c.context.messages[0]!.content as string;
      expect(text.startsWith("probe_")).toBe(true);
      expect(text.toLowerCase()).not.toContain("session");
      // no multi-turn history
      expect(c.context.messages.every((m) => m.role === "user")).toBe(true);
      expect(c.context.messages[0]!.timestamp).toBe(42);
    }

    const basic = calls.find((c) => c.contract === "basic")!;
    expect(basic.context.tools).toBeUndefined();
    expect(basic.options.reasoning).toBeUndefined();

    const reasoning = calls.find((c) => c.contract === "reasoning")!;
    expect(reasoning.options.reasoning).toBeDefined();
    expect(reasoning.context.tools).toBeUndefined();

    const tool = calls.find((c) => c.contract === "tool")!;
    expect(tool.context.tools).toBeDefined();
    expect(tool.context.tools![0]!.name).toBe("probe_echo");
    expect(tool.context.tools![0]!.description.toLowerCase()).toMatch(/no side effects|echo/);
  });

  test("contracts option re-runs only selected stages (repair retest seam)", async () => {
    const { transport, calls } = recordingTransport((req) => {
      if (req.contract === "tool") return okTool();
      throw new Error(`unexpected ${req.contract}`);
    });

    const only: ProbeContractId[] = ["tool"];
    const result = await runProbe({
      target: { ...targetBase, reasoning: true },
      model: {},
      transport,
      contracts: only,
    });

    expect(calls.map((c) => c.contract)).toEqual(["tool"]);
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]!.status).toBe("pass");
    expect(result.ok).toBe(true);
  });

  test("tool stage fails when model returns text without tool call", async () => {
    const { transport } = recordingTransport((req) => {
      if (req.contract === "basic") return okText();
      return okText("I cannot call tools");
    });

    const result = await runProbe({
      target: { ...targetBase, reasoning: false },
      model: {},
      transport,
    });

    expect(result.ok).toBe(false);
    const tool = result.stages.find((s) => s.contract === "tool")!;
    expect(tool.status).toBe("fail");
    expect(tool.category).toBe("tool");
  });

  test("transport is the only I/O surface (injectable faux complete)", async () => {
    let hit = 0;
    const transport: ProbeTransport = async () => {
      hit += 1;
      return okText();
    };
    // maxRequests 0 would not call; with default and reasoning false: basic+tool = 2
    await runProbe({
      target: { ...targetBase, reasoning: false },
      model: "opaque-model-handle",
      transport,
    });
    expect(hit).toBe(2);
  });
});
