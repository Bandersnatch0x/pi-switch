/**
 * Production probe wiring: transport reads request.target (fingerprint /
 * claudeCodeCompat / geminiToolCompat) + CAS repair config store.
 * Zero network — complete() and fs are injected.
 */
import { describe, expect, test } from "bun:test";
import {
  createProbeTransport,
  createRepairConfigStore,
} from "../extensions/probe-commands.ts";
import type { FsLike } from "../src/json-file.ts";
import { piSwitchConfigPath } from "../src/settings.ts";
import type { CcProvider } from "../src/types.ts";
import type {
  ProbeRequest,
  ProbeTransportResult,
} from "../src/probe/index.ts";

function memFs(
  initial: Record<string, string> = {},
): FsLike & { store: Record<string, string> } {
  const store = { ...initial };
  return {
    store,
    existsSync: (p) => p in store,
    readFileSync: (p) => {
      if (!(p in store)) throw new Error("missing");
      return store[p];
    },
    writeFileSync: (p, data) => {
      store[p] = data;
    },
    renameSync: (from, to) => {
      store[to] = store[from];
      delete store[from];
    },
  };
}

function provider(id: string, name: string, appType = "codex"): CcProvider {
  return {
    id,
    piName: `ps-${id}`,
    displayName: name,
    appType,
    api: "openai-responses",
    baseUrl: "https://x",
    apiKey: "k",
    authHeader: true,
    configModels: ["m1"],
    meta: {},
    isCurrentInCc: false,
  };
}

type FakeModel = { api: string; id: string };

const anthropicModel: FakeModel = { api: "anthropic-messages", id: "m1" };
const geminiModel: FakeModel = { api: "google-generative-ai", id: "m1" };

function fakeComplete() {
  const calls: Array<{
    model: unknown;
    context: unknown;
    options: Record<string, unknown>;
  }> = [];
  return {
    calls,
    fn: async (model: unknown, context: unknown, options: Record<string, unknown>) => {
      calls.push({ model, context, options });
      (options as { onResponse?: (r: { status: number; headers: Record<string, string> }) => void }).onResponse?.({
        status: 200,
        headers: { "content-type": "application/json" },
      });
      return {
        role: "assistant",
        content: [{ type: "text", text: "probe_ok" }],
        stopReason: "stop",
        api: (model as FakeModel).api,
        provider: "ps",
        model: (model as FakeModel).id,
        usage: { input: 1, output: 1, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: 1,
      };
    },
  };
}

function makeRequest(overrides: Partial<ProbeRequest> = {}): ProbeRequest {
  return {
    contract: "basic",
    target: { provider: "ps-p1", modelId: "m1" },
    model: anthropicModel,
    context: { messages: [{ role: "user", content: "probe_basic: reply probe_ok", timestamp: 1 }] },
    options: { maxTokens: 32, signal: new AbortController().signal },
    ...overrides,
  };
}

describe("createProbeTransport reads request.target (issue #42 fix)", () => {
  test("fingerprint preset expands into request headers", async () => {
    const comp = fakeComplete();
    const transport = createProbeTransport({
      headerVars: () => ({
        claudeCodeVersion: "2.0.0",
        anthropicVersion: "2023-06-01",
        anthropicBeta: "claude-code-20250219",
        codexVersion: "1.2.3",
        codexOriginator: "pi",
        osInfo: "Linux x64",
        geminiVersion: "1.5.0",
      }),
      resolveAuth: async () => ({ ok: true, apiKey: "sk-test" }),
      completeFn: comp.fn as never,
    });

    const result = await transport(
      makeRequest({
        target: { provider: "ps-p1", modelId: "m1", fingerprint: "claude-code" },
      }),
    );

    expect(result.message.content[0]).toEqual({ type: "text", text: "probe_ok" });
    const opts = comp.calls[0]!.options as {
      headers?: Record<string, string>;
      apiKey?: string;
      maxTokens?: number;
      maxRetries?: number;
    };
    expect(opts.apiKey).toBe("sk-test");
    expect(opts.maxTokens).toBe(32);
    expect(opts.maxRetries).toBe(0);
    expect(opts.headers?.["User-Agent"]).toContain("claude-cli/2.0.0");
    expect(opts.headers?.["anthropic-version"]).toBe("2023-06-01");
  });

  test("header template with missing variable is skipped (no literal upstream)", async () => {
    const comp = fakeComplete();
    const transport = createProbeTransport({
      // claudeCodeVersion is NOT provided → claude-code preset headers must
      // be dropped, not emitted as "claude-cli/{claudeCodeVersion}" literals.
      headerVars: () => ({
        anthropicVersion: "2023-06-01",
        anthropicBeta: "x",
      }),
      resolveAuth: async () => ({ ok: true }),
      completeFn: comp.fn as never,
    });

    await transport(
      makeRequest({
        target: {
          provider: "ps-p1",
          modelId: "m1",
          fingerprint: "claude-code",
        },
      }),
    );

    const opts = comp.calls[0]!.options as { headers?: Record<string, string> };
    expect(opts.headers?.["User-Agent"]).toBeUndefined();
    expect(opts.headers?.["anthropic-version"]).toBe("2023-06-01");
    expect(opts.headers?.["anthropic-beta"]).toBe("x");
  });

  test("claudeCodeCompat adds Claude Code request-shape headers (anthropic only)", async () => {
    const comp = fakeComplete();
    const transport = createProbeTransport({
      resolveAuth: async () => ({ ok: true }),
      completeFn: comp.fn as never,
    });

    await transport(
      makeRequest({
        target: {
          provider: "ps-p1",
          modelId: "m1",
          fingerprint: "claude-code",
          claudeCodeCompat: true,
        },
      }),
    );

    const opts = comp.calls[0]!.options as { headers?: Record<string, string> };
    expect(opts.headers?.["x-app"]).toBe("cli");
    expect(opts.headers?.["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(opts.headers?.["anthropic-beta"]).toContain("claude-code-20250219");
  });

  test("geminiToolCompat injects toolConfig via onPayload (gemini api only)", async () => {
    const comp = fakeComplete();
    const transport = createProbeTransport({
      resolveAuth: async () => ({ ok: true }),
      completeFn: comp.fn as never,
    });

    const result = await transport(
      makeRequest({
        model: geminiModel,
        target: { provider: "ps-p1", modelId: "m1", geminiToolCompat: true },
      }),
    );

    const opts = comp.calls[0]!.options as {
      onPayload?: (payload: unknown) => unknown;
      onResponse?: (res: { status: number; headers: Record<string, string> }) => void;
    };
    expect(typeof opts.onPayload).toBe("function");
    expect(result.httpStatus).toBe(200);

    const payload = {
      model: "m1",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      config: {
        generationConfig: {},
        tools: [{ functionDeclarations: [{ name: "probe_echo" }] }],
      },
    };
    const next = opts.onPayload?.(payload);
    expect(next).not.toBe(payload);
    const cfg = (next as { config?: Record<string, unknown> }).config;
    expect(cfg?.toolConfig).toBeDefined();
  });

  test("geminiToolCompat is a no-op for non-gemini api", async () => {
    const comp = fakeComplete();
    const transport = createProbeTransport({
      resolveAuth: async () => ({ ok: true }),
      completeFn: comp.fn as never,
    });

    await transport(
      makeRequest({
        target: { provider: "ps-p1", modelId: "m1", geminiToolCompat: true },
      }),
    );

    const opts = comp.calls[0]!.options as { onPayload?: unknown };
    expect(opts.onPayload).toBeUndefined();
  });

  test("claudeCodeCompat is a no-op for non-anthropic api", async () => {
    const comp = fakeComplete();
    const transport = createProbeTransport({
      resolveAuth: async () => ({ ok: true }),
      completeFn: comp.fn as never,
    });

    // geminiModel is google-generative-ai, so claudeCodeCompat must NOT inject
    // Claude Code request-shape headers even when the flag is on.
    await transport(
      makeRequest({
        model: geminiModel,
        target: {
          provider: "ps-p1",
          modelId: "m1",
          claudeCodeCompat: true,
        },
      }),
    );

    const opts = comp.calls[0]!.options as { headers?: Record<string, string> };
    expect(opts.headers?.["x-app"]).toBeUndefined();
    expect(
      opts.headers?.["anthropic-dangerous-direct-browser-access"],
    ).toBeUndefined();
  });

  test("observations are captured per request for durable evidence", async () => {
    const comp = fakeComplete();
    const observations: unknown[] = [];
    const transport = createProbeTransport({
      headerVars: () => ({
        codexVersion: "1.2.3",
        codexOriginator: "pi",
        osInfo: "Linux x64",
      }),
      resolveAuth: async () => ({ ok: true, headers: { "x-custom": "1" } }),
      completeFn: comp.fn as never,
      onObservation: (obs) => observations.push(obs),
    });

    const result = await transport(
      makeRequest({
        target: { provider: "ps-p1", modelId: "m1", fingerprint: "codex" },
      }),
    );

    expect(observations).toHaveLength(1);
    const obs = observations[0] as {
      contract: string;
      request?: { headers?: Record<string, string> };
      response?: { message?: unknown; httpStatus?: number };
    };
    expect(obs.contract).toBe("basic");
    // Observation request headers include the candidate fingerprint expansion.
    expect(obs.request?.headers?.["User-Agent"]).toContain("codex_cli_rs/");
    expect(obs.response?.message).toEqual(result.message);
  });

  test("reasoning contract forwards the simple reasoning level", async () => {
    const comp = fakeComplete();
    const transport = createProbeTransport({
      resolveAuth: async () => ({ ok: true }),
      completeFn: comp.fn as never,
    });

    await transport(
      makeRequest({
        contract: "reasoning",
        options: {
          maxTokens: 32,
          signal: new AbortController().signal,
          reasoning: "low",
        },
      }),
    );

    const opts = comp.calls[0]!.options as { reasoning?: string };
    expect(opts.reasoning).toBe("low");
  });

  test("thrown provider error retains status captured by onResponse", async () => {
    const observations: Array<{ response?: { httpStatus?: number } }> = [];
    const transport = createProbeTransport({
      resolveAuth: async () => ({ ok: true }),
      onObservation: (obs) => observations.push(obs),
      completeFn: (async (
        _model: unknown,
        _context: unknown,
        options: {
          onResponse?: (
            response: { status: number; headers: Record<string, string> },
            model: unknown,
          ) => void | Promise<void>;
        },
      ) => {
        await options?.onResponse?.({ status: 429, headers: { "retry-after": "30" } }, anthropicModel as never);
        throw new Error("rate limited");
      }) as never,
    });

    const result = await transport(makeRequest());
    expect(result.httpStatus).toBe(429);
    expect(result.responseHeaders?.["retry-after"]).toBe("30");
    expect(observations[0]?.response?.httpStatus).toBe(429);
  });

  test("claudeCodeCompat applies the same payload shape as the live hook", async () => {
    const comp = fakeComplete();
    const transport = createProbeTransport({
      resolveAuth: async () => ({ ok: true }),
      completeFn: comp.fn as never,
      claudeCompat: {
        config: {},
        deviceId: "a".repeat(64),
        systemPrefix: "You are a Claude agent.",
      },
    });

    await transport(
      makeRequest({
        target: {
          provider: "ps-p1",
          modelId: "m1",
          claudeCodeCompat: true,
        },
      }),
    );

    const opts = comp.calls[0]!.options as {
      onPayload?: (payload: unknown) => unknown;
    };
    const payload = {
      model: "m1",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "probe_echo", input_schema: { type: "object" } }],
    };
    const next = opts.onPayload?.(payload) as Record<string, unknown>;
    expect(next).not.toBe(payload);
    expect(next.metadata).toBeDefined();
    expect(Array.isArray(next.system)).toBe(true);
    expect((next.tools as unknown[]).length).toBeGreaterThan(1);
  });

  test("geminiToolCompat uses configured AUTO mode instead of hard-coded VALIDATED", async () => {
    const comp = fakeComplete();
    const transport = createProbeTransport({
      resolveAuth: async () => ({ ok: true }),
      completeFn: comp.fn as never,
      geminiCompat: { forceToolConfigMode: "AUTO" },
    });

    await transport(
      makeRequest({
        model: geminiModel,
        target: { provider: "ps-p1", modelId: "m1", geminiToolCompat: true },
      }),
    );

    const opts = comp.calls[0]!.options as {
      onPayload?: (payload: unknown) => unknown;
    };
    const next = opts.onPayload?.({
      model: "m1",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      config: { tools: [{ functionDeclarations: [{ name: "probe_echo" }] }] },
    }) as {
      config: {
        toolConfig: { functionCallingConfig: { mode: string } };
      };
    };
    expect(next.config.toolConfig.functionCallingConfig.mode).toBe("AUTO");
  });

  test("auth failure returns explicit error result (no complete call, no anonymous 401)", async () => {
    const comp = fakeComplete();
    const transport = createProbeTransport({
      resolveAuth: async () => ({
        ok: false,
        error: "missing API key for ps-p1",
      }),
      completeFn: comp.fn as never,
    });

    const result = await transport(makeRequest());
    expect(result.message.stopReason).toBe("error");
    expect(result.message.errorMessage).toMatch(/local auth resolution failed: missing API key/);
    expect(result.httpStatus).toBeUndefined();
    // The wire was never touched.
    expect(comp.calls).toHaveLength(0);
  });

  test("missing getApiKeyAndHeaders on registry surfaces as auth failure", async () => {
    const comp = fakeComplete();
    const transport = createProbeTransport({
      resolveAuth: async () => ({ ok: false, error: "modelRegistry.getApiKeyAndHeaders unavailable" }),
      completeFn: comp.fn as never,
    });

    const result = await transport(makeRequest());
    expect(result.message.stopReason).toBe("error");
    expect(result.message.errorMessage).toMatch(/unavailable/);
    expect(comp.calls).toHaveLength(0);
  });

  test("resolveAuth throwing is caught — transport returns error result, never rejects", async () => {
    const comp = fakeComplete();
    const transport = createProbeTransport({
      resolveAuth: async () => {
        throw new Error("provider unregistered");
      },
      completeFn: comp.fn as never,
    });

    const result = await transport(makeRequest());
    expect(result.message.stopReason).toBe("error");
    expect(result.message.errorMessage).toMatch(/local auth resolution failed: provider unregistered/);
    expect(comp.calls).toHaveLength(0);
  });

  test("complete throwing (network failure) is caught — transport returns error result", async () => {
    const transport = createProbeTransport({
      resolveAuth: async () => ({ ok: true }),
      completeFn: (async () => {
        throw new Error("ECONNRESET");
      }) as never,
    });

    const result = await transport(makeRequest());
    expect(result.message.stopReason).toBe("error");
    expect(result.message.errorMessage).toMatch(/provider request failed: ECONNRESET/);
  });

  test("request without apiKey still reaches complete when auth resolves ok", async () => {
    const comp = fakeComplete();
    const transport = createProbeTransport({
      resolveAuth: async () => ({ ok: true }),
      completeFn: comp.fn as never,
    });

    const result = await transport(makeRequest());
    expect(result.message.stopReason).toBe("stop");
    expect(comp.calls).toHaveLength(1);
    const opts = comp.calls[0]!.options as { apiKey?: string };
    expect(opts.apiKey).toBeUndefined();
  });
});

describe("createRepairConfigStore (CAS)", () => {
  const home = "/home/user";
  const path = piSwitchConfigPath(home);

  function baseConfig(): Record<string, unknown> {
    return {
      providerOverrides: {
        codex: {
          p1: { label: "Relay One" },
        },
      },
    };
  }

  function makeStore(store: Record<string, string>) {
    const fs = memFs(store);
    const storeImpl = createRepairConfigStore({
      home,
      fs,
      providers: [provider("p1", "Relay One")],
    });
    return { fs, storeImpl };
  }

  test("read returns stable version; commit with matching version applies fingerprint patch", async () => {
    const initial: Record<string, string> = {
      [path]: JSON.stringify(baseConfig(), null, 2),
    };
    const { fs, storeImpl } = makeStore(initial);

    const snap = await storeImpl.read();
    expect((await storeImpl.read()).version).toBe(snap.version);

    const result = await storeImpl.commit({
      expectedVersion: snap.version,
      patch: {
        kind: "fingerprint",
        scope: "provider",
        provider: "ps-p1",
        fingerprint: "codex",
      },
    });

    expect(result.ok).toBe(true);
    const doc = JSON.parse(fs.store[path]!) as {
      providerOverrides: Record<
        string,
        Record<string, { fingerprint?: string; label?: string }>
      >;
    };
    expect(doc.providerOverrides.codex?.p1?.fingerprint).toBe("codex");
    // Label preserved.
    expect(doc.providerOverrides.codex?.p1?.label).toBe("Relay One");
  });

  test("stale version → conflict, file untouched", async () => {
    const initial: Record<string, string> = {
      [path]: JSON.stringify(baseConfig(), null, 2),
    };
    const { fs, storeImpl } = makeStore(initial);
    const before = fs.store[path]!;

    const result = await storeImpl.commit({
      expectedVersion: "hstale",
      patch: {
        kind: "fingerprint",
        scope: "provider",
        provider: "ps-p1",
        fingerprint: "claude-code",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
    expect(fs.store[path]).toBe(before);
  });

  test("external change between read and commit → conflict", async () => {
    const initial: Record<string, string> = {
      [path]: JSON.stringify(baseConfig(), null, 2),
    };
    const { fs, storeImpl } = makeStore(initial);
    const snap = await storeImpl.read();

    // Simulate an external edit landing after the snapshot.
    const doc = JSON.parse(fs.store[path]!) as Record<string, unknown>;
    fs.store[path] = JSON.stringify({ ...doc, tabs: ["changed"] }, null, 2);

    const result = await storeImpl.commit({
      expectedVersion: snap.version,
      patch: {
        kind: "geminiToolCompat",
        scope: "provider",
        provider: "ps-p1",
        geminiToolCompat: true,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
  });

  test("edit landing after version check aborts instead of being merged", async () => {
    const initial: Record<string, string> = {
      [path]: JSON.stringify(baseConfig(), null, 2),
    };
    const base = memFs(initial);
    let sourceReads = 0;
    const fs: FsLike = {
      ...base,
      readFileSync: (p, encoding) => {
        sourceReads += 1;
        // read(): 1, commit version check: 2, atomic unchanged check: 3.
        if (p === path && sourceReads === 3) {
          const doc = JSON.parse(base.store[path]!) as Record<string, unknown>;
          base.store[path] = JSON.stringify({ ...doc, marker: "external" }, null, 2);
        }
        return base.readFileSync(p, encoding);
      },
    };
    const storeImpl = createRepairConfigStore({
      home,
      fs,
      providers: [provider("p1", "Relay One")],
    });
    const snap = await storeImpl.read();

    const result = await storeImpl.commit({
      expectedVersion: snap.version,
      patch: {
        kind: "fingerprint",
        scope: "provider",
        provider: "ps-p1",
        fingerprint: "codex",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
    const doc = JSON.parse(base.store[path]!) as {
      marker?: string;
      providerOverrides: Record<string, Record<string, { fingerprint?: string }>>;
    };
    expect(doc.marker).toBe("external");
    expect(doc.providerOverrides.codex?.p1?.fingerprint).toBeUndefined();
  });

  test("modelMeta patch writes exact-model reasoning=false through existing path", async () => {
    const initial: Record<string, string> = {
      [path]: JSON.stringify(baseConfig(), null, 2),
    };
    const { fs, storeImpl } = makeStore(initial);
    const snap = await storeImpl.read();

    const result = await storeImpl.commit({
      expectedVersion: snap.version,
      patch: {
        kind: "modelMeta",
        scope: "model",
        provider: "ps-p1",
        modelId: "m1",
        modelMeta: { reasoning: false },
      },
    });

    expect(result.ok).toBe(true);
    const doc = JSON.parse(fs.store[path]!) as {
      providerOverrides: Record<string, Record<string, { modelOverrides?: Record<string, { reasoning?: boolean }> }>>;
    };
    expect(doc.providerOverrides.codex?.p1?.modelOverrides?.m1).toEqual({
      reasoning: false,
    });
  });

  test("geminiToolCompat-only patch on empty entry survives commit + fresh re-read", async () => {
    // Regression: entryIsEmpty must recognize geminiToolCompat, otherwise a
    // compat-only patch is silently dropped on commit while result says ok.
    const initial: Record<string, string> = {
      [path]: JSON.stringify({ providerOverrides: {} }, null, 2),
    };
    const { fs, storeImpl } = makeStore(initial);
    const snap = await storeImpl.read();

    const result = await storeImpl.commit({
      expectedVersion: snap.version,
      patch: {
        kind: "geminiToolCompat",
        scope: "provider",
        provider: "ps-p1",
        geminiToolCompat: true,
      },
    });

    expect(result.ok).toBe(true);

    // Fresh store (new session) re-reads the same disk state.
    const fresh = createRepairConfigStore({
      home,
      fs,
      providers: [provider("p1", "Relay One")],
    });
    const snap2 = await fresh.read();
    expect(snap2.version).not.toBe(snap.version);
    const doc = JSON.parse(fs.store[path]!) as {
      providerOverrides: Record<
        string,
        Record<string, { geminiToolCompat?: boolean; claudeCodeCompat?: boolean }>
      >;
    };
    expect(doc.providerOverrides.codex?.p1?.geminiToolCompat).toBe(true);
  });

  test("claudeCodeCompat-only entry survives commit (Recipe2 candidate on empty provider)", async () => {
    const initial: Record<string, string> = {
      [path]: JSON.stringify({ providerOverrides: {} }, null, 2),
    };
    const { fs, storeImpl } = makeStore(initial);
    const snap = await storeImpl.read();

    const result = await storeImpl.commit({
      expectedVersion: snap.version,
      patch: {
        kind: "fingerprint",
        scope: "provider",
        provider: "ps-p1",
        fingerprint: "claude-code",
        claudeCodeCompat: true,
      },
    });

    expect(result.ok).toBe(true);
    const doc = JSON.parse(fs.store[path]!) as {
      providerOverrides: Record<
        string,
        Record<string, { fingerprint?: string; claudeCodeCompat?: boolean }>
      >;
    };
    expect(doc.providerOverrides.codex?.p1?.fingerprint).toBe("claude-code");
    expect(doc.providerOverrides.codex?.p1?.claudeCodeCompat).toBe(true);
  });

  test("nested scalar values win over legacy flat entry on commit (no flat-clobber)", async () => {
    // Regression: a provider has BOTH a legacy top-level entry (flat) AND an
    // appType-scoped nested entry. Absorbing the flat entry must let the
    // nested scalars (label, fingerprint) win — otherwise the repair path
    // and the manual-edit path write different results for the same provider.
    const initial: Record<string, string> = {
      [path]: JSON.stringify(
        {
          providerOverrides: {
            // AppType-scoped nested (canonical) slot.
            codex: {
              p1: { label: "Nested Label", fingerprint: "codex" },
            },
            // Legacy flat top-level slot, shadowed by the nested one.
            p1: { label: "Flat Label", fingerprint: "gemini" },
          },
        },
        null,
        2,
      ),
    };
    const { fs, storeImpl } = makeStore(initial);
    const snap = await storeImpl.read();

    const result = await storeImpl.commit({
      expectedVersion: snap.version,
      patch: {
        kind: "geminiToolCompat",
        scope: "provider",
        provider: "ps-p1",
        geminiToolCompat: true,
      },
    });

    expect(result.ok).toBe(true);
    const doc = JSON.parse(fs.store[path]!) as {
      providerOverrides: Record<
        string,
        Record<
          string,
          {
            label?: string;
            fingerprint?: string;
            geminiToolCompat?: boolean;
          }
        >
      >;
    };
    // Nested scalars survive (NOT overwritten by the legacy flat values).
    expect(doc.providerOverrides.codex?.p1?.label).toBe("Nested Label");
    expect(doc.providerOverrides.codex?.p1?.fingerprint).toBe("codex");
    // New flag applied.
    expect(doc.providerOverrides.codex?.p1?.geminiToolCompat).toBe(true);
    // Legacy flat entry absorbed (deleted).
    expect(doc.providerOverrides.p1).toBeUndefined();
  });
});
