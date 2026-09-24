import { describe, expect, test } from "bun:test";
import { installClaudeCodeCompat } from "../extensions/claude-code-compat.ts";
import { installGeminiToolCompat } from "../extensions/gemini-tool-compat.ts";
import { Runtime, type NodeIo } from "../extensions/runtime.ts";
import { isModelsDevMiss, makeMiss, MODELS_DEV_API_URL } from "../src/capabilities/models-dev.ts";
import { resolveRegistrationCapability } from "../src/capabilities/registration.ts";
import { parseCodexReasoningCatalog } from "../src/capabilities/reasoning-profile-registry.ts";
import { piSwitchCachePath } from "../src/paths.ts";
import type { CcProvider } from "../src/types.ts";

const SAMPLE_CATALOG = {
  vivgrid: {
    models: {
      "gpt-5.6-sol": {
        id: "gpt-5.6-sol",
        limit: { context: 1000000, output: 384000 },
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        last_updated: "2026-04-24",
      },
    },
  },
};

function memFs(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    store,
    existsSync: (path: string) => path in store,
    readFileSync: (path: string, _enc?: string) => {
      if (!(path in store)) throw new Error(`ENOENT: ${path}`);
      return store[path];
    },
    writeFileSync: (path: string, data: string | Buffer, _enc?: string) => {
      store[path] = String(data);
    },
    renameSync: (from: string, to: string) => {
      store[to] = store[from];
      delete store[from];
    },
    unlinkSync: (path: string) => {
      delete store[path];
    },
  };
}

function makeIo(opts?: {
  home?: string;
  fs?: ReturnType<typeof memFs>;
  fetchJson?: (url: string) => Promise<unknown>;
  piVersion?: string;
}): { rt: Runtime; fs: ReturnType<typeof memFs>; fetchCount: { n: number } } {
  const home = opts?.home ?? "/home/test";
  const fs = opts?.fs ?? memFs();
  const fetchCount = { n: 0 };
  const underlying =
    opts?.fetchJson ??
    (async (_url: string) => SAMPLE_CATALOG);
  const io: NodeIo = {
    execFileSync: (() => {
      throw new Error("no exec");
    }) as NodeIo["execFileSync"],
    existsSync: fs.existsSync as NodeIo["existsSync"],
    readFileSync: fs.readFileSync as NodeIo["readFileSync"],
    writeFileSync: fs.writeFileSync as NodeIo["writeFileSync"],
    renameSync: fs.renameSync as NodeIo["renameSync"],
    unlinkSync: fs.unlinkSync as NodeIo["unlinkSync"],
    randomUUID: () => "test-0000-0000-0000-uuid",
    hashText: (text: string) => `h${text.length}`,
    cwd: "/project",
    readdirSync: () => [],
    resolvePackageVersion: () => opts?.piVersion,
    snapshotPath: "/dev/null",
    probeHttp: async () => false,
    fetchJson: async (url) => {
      fetchCount.n += 1;
      return underlying(url);
    },
    release: "test",
    home,
  };
  return { rt: new Runtime(io), fs, fetchCount };
}

function catalogProvider(): CcProvider {
  const parsed = parseCodexReasoningCatalog(
    {
      modelCatalog: {
        models: [
          {
            slug: "gpt-5.6-sol",
            default_reasoning_level: "low",
            supported_reasoning_levels: [
              { effort: "low" },
              { effort: "medium" },
              { effort: "ultra" },
            ],
          },
        ],
      },
    },
    "2026-08-17T00:00:00.000Z",
  );
  return {
    id: "codex-catalog",
    piName: "codex-catalog",
    displayName: "Codex Catalog",
    appType: "codex",
    api: "openai-responses",
    baseUrl: "https://relay.example/v1",
    apiKey: "key",
    authHeader: true,
    configModels: ["gpt-5.6-sol"],
    reasoningCatalog: parsed.catalog,
    meta: {},
    isCurrentInCc: false,
  };
}

describe("Runtime capabilities cache (issue #39)", () => {
  test("diagnostics and registration share the protocol vision floor", () => {
    const { rt } = makeIo();
    const provider: CcProvider = {
      id: "anthropic-relay",
      piName: "anthropic-relay",
      displayName: "Anthropic Relay",
      appType: "claude",
      api: "anthropic-messages",
      baseUrl: "https://relay.example",
      apiKey: "",
      authHeader: true,
      configModels: [],
      meta: {},
      isCurrentInCc: false,
    };
    const modelId = "unknown-anthropic-model";

    const diagnostics = rt.capabilitiesFor(provider, modelId);
    const registration = resolveRegistrationCapability({
      modelId,
      api: provider.api,
      baseUrl: provider.baseUrl,
    });

    expect(diagnostics.vision).toMatchObject({
      value: true,
      source: "protocol-default",
    });
    expect(registration.resolved.vision).toEqual(diagnostics.vision);
  });

  test("hit writes positive entry; miss writes negative; modelsDevFor filters miss", async () => {
    const { rt, fs } = makeIo();
    await rt.refreshCapabilities(["gpt-5.6-sol", "private-proxy-id"]);

    const hit = rt.rawCacheEntry("gpt-5.6-sol");
    expect(hit).toBeDefined();
    expect(isModelsDevMiss(hit)).toBe(false);
    expect(rt.modelsDevFor("gpt-5.6-sol")?.contextWindow).toBe(1000000);

    const miss = rt.rawCacheEntry("private-proxy-id");
    expect(isModelsDevMiss(miss)).toBe(true);
    expect(rt.modelsDevFor("private-proxy-id")).toBeUndefined();

    const disk = JSON.parse(fs.store[piSwitchCachePath("/home/test")]);
    expect(disk.version).toBe(1);
    expect(disk.capabilities["private-proxy-id"].missing).toBe(true);
    expect(disk.capabilities["gpt-5.6-sol"].source).toBe("models-dev");
  });

  test("register path modelsDevFor is zero-IO (fetchJson stays 0)", () => {
    const cachePath = piSwitchCachePath("/home/test");
    const { rt, fetchCount } = makeIo({
      fs: memFs({
        [cachePath]: JSON.stringify({
          version: 1,
          capabilities: {
            "private-proxy-id": makeMiss("2026-08-01T00:00:00Z"),
            "gpt-5.6-sol": {
              contextWindow: 1000000,
              maxTokens: 384000,
              reasoning: true,
              vision: true,
              observedAt: "2026-04-24",
              source: "models-dev",
            },
          },
        }),
      }),
    });
    expect(rt.modelsDevFor("private-proxy-id")).toBeUndefined();
    expect(rt.modelsDevFor("gpt-5.6-sol")?.contextWindow).toBe(1000000);
    expect(rt.modelsDevFor("never-seen")).toBeUndefined();
    expect(fetchCount.n).toBe(0);
  });

  test("cold scheduleModelsDevRefresh fetches once; second schedule stays gated", async () => {
    const { rt, fetchCount } = makeIo();
    rt.scheduleModelsDevRefresh("gpt-5.6-sol");
    // Wait for fire-and-forget inflight to settle.
    for (let i = 0; i < 20 && fetchCount.n === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(fetchCount.n).toBe(1);

    // Fresh entry → second schedule must not re-fetch.
    rt.scheduleModelsDevRefresh("gpt-5.6-sol");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCount.n).toBe(1);
  });

  test("fetchJson throw does not write miss; sets failedAt; cooldown blocks second", async () => {
    const { rt, fs, fetchCount } = makeIo({
      fetchJson: async () => {
        throw new Error("network down");
      },
    });
    await rt.refreshCapabilities(["gpt-5.6-sol"]);
    expect(fetchCount.n).toBe(1);
    expect(rt.rawCacheEntry("gpt-5.6-sol")).toBeUndefined();
    expect(fs.store[piSwitchCachePath("/home/test")]).toBeUndefined();
    const fail = rt.lastRefreshFailure();
    expect(fail?.message).toContain("network down");

    // Schedule during cooldown → no second fetch.
    rt.scheduleModelsDevRefresh("gpt-5.6-sol");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCount.n).toBe(1);
  });

  test("legacy positive-only cache format still works (no missing field)", () => {
    const cachePath = piSwitchCachePath("/home/test");
    const { rt, fetchCount } = makeIo({
      fs: memFs({
        [cachePath]: JSON.stringify({
          version: 1,
          updatedAt: "2026-07-01T00:00:00Z",
          capabilities: {
            "gpt-5.6-sol": {
              contextWindow: 1000000,
              maxTokens: 384000,
              reasoning: true,
              vision: true,
              observedAt: "2026-04-24",
              source: "models-dev",
            },
          },
        }),
      }),
    });
    expect(rt.modelsDevFor("gpt-5.6-sol")?.maxTokens).toBe(384000);
    expect(isModelsDevMiss(rt.rawCacheEntry("gpt-5.6-sol"))).toBe(false);
    expect(fetchCount.n).toBe(0);
  });

  test("capabilitiesInflight dedupes concurrent refreshCapabilities", async () => {
    let resolveFetch!: (v: unknown) => void;
    const gate = new Promise<unknown>((r) => {
      resolveFetch = r;
    });
    const { rt, fetchCount } = makeIo({
      fetchJson: async () => gate,
    });
    const p1 = rt.refreshCapabilities(["a"]);
    const p2 = rt.refreshCapabilities(["b"]);
    expect(p1).toBe(p2);
    resolveFetch(SAMPLE_CATALOG);
    await p1;
    expect(fetchCount.n).toBe(1);
  });

  test("MODELS_DEV_API_URL is requested on refresh", async () => {
    const urls: string[] = [];
    const { rt } = makeIo({
      fetchJson: async (url) => {
        urls.push(url);
        return SAMPLE_CATALOG;
      },
    });
    await rt.refreshCapabilities(["x"]);
    expect(urls).toEqual([MODELS_DEV_API_URL]);
  });
});

describe("Runtime reasoning profile integration", () => {
  test.each(["0.81.1", "0.84.2"])(
    "Pi %s consumes the catalog profile without synthesizing ultra",
    (piVersion) => {
      const { rt } = makeIo({ piVersion });
      rt.config = {
        defaultModelMeta: { maxTokens: 32_000, reasoning: true },
      };

      const decision = rt.registration.decisionFor(
        catalogProvider(),
        "gpt-5.6-sol",
      );

      expect(decision.thinkingProjection).toMatchObject({
        source: "codex-model-catalog",
        status: "exact",
        map: {
          low: "low",
          medium: "medium",
          max: null,
        },
      });
      expect(decision.thinkingProjection?.unrepresented).toEqual([
        { type: "effort", value: "ultra" },
      ]);
      expect(
        decision.thinkingProjection?.projections.find(
          (item) => item.intent === "provider-default",
        ),
      ).toMatchObject({
        status: "provider-default",
        native: { type: "effort", value: "low" },
      });
      expect(decision.meta?.thinkingLevelMap?.max).toBeNull();
    },
  );

  test("unknown Pi versions keep the same profile diagnostic-only", () => {
    const { rt } = makeIo();
    rt.config = {
      defaultModelMeta: { maxTokens: 32_000, reasoning: true },
    };

    const decision = rt.registration.decisionFor(
      catalogProvider(),
      "gpt-5.6-sol",
    );

    expect(decision.thinkingProjection?.status).toBe("unverified");
    expect(decision.thinkingProjection?.map).toBeUndefined();
    expect(decision.meta?.thinkingLevelMap).toBeUndefined();
  });

  test("verified Gemini budgets remain selectable and keep off distinct from active levels", () => {
    const { rt } = makeIo({ piVersion: "0.81.1" });
    rt.config = {
      defaultModelMeta: { maxTokens: 32_000, reasoning: true },
    };
    const provider: CcProvider = {
      id: "gemini",
      piName: "gemini",
      displayName: "Gemini",
      appType: "gemini",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "key",
      authHeader: false,
      configModels: ["gemini-2.5-pro"],
      meta: {},
      isCurrentInCc: false,
    };

    const decision = rt.registration.decisionFor(provider, "gemini-2.5-pro");
    expect(decision.thinkingProjection?.status).toBe("lossy");
    expect(decision.meta?.thinkingLevelMap).toMatchObject({
      off: "off",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
    });
    expect(
      decision.thinkingProjection?.projections.find((item) => item.intent === "off"),
    ).toMatchObject({
      status: "exact",
      native: { type: "budget_tokens", tokens: 0 },
    });
  });
});

describe("effective provider compatibility", () => {
  test("Claude live hook honors canonical nested provider override", () => {
    const { rt } = makeIo();
    const provider: CcProvider = {
      id: "claude-relay",
      piName: "ps-claude-relay",
      displayName: "Claude Relay",
      appType: "claude",
      api: "anthropic-messages",
      baseUrl: "https://relay.example",
      apiKey: "",
      authHeader: true,
      configModels: ["claude-sonnet"],
      meta: {},
      isCurrentInCc: false,
    };
    rt.config = {
      claudeCodeCompat: { mode: "always" },
      providerOverrides: {
        claude: {
          [provider.id]: { claudeCodeCompat: false },
        },
      },
    };
    rt.lastGoodProviders = [provider];
    rt.readSelectionCached = () => ({
      appType: "claude",
      dbId: provider.id,
      provider: provider.piName,
      model: provider.configModels[0],
    });

    const hooks = new Map<string, unknown>();
    installClaudeCodeCompat(
      {
        on(event: string, handler: unknown) {
          hooks.set(event, handler);
        },
      } as never,
      rt,
    );
    const headers: Record<string, string> = {};
    const beforeHeaders = hooks.get("before_provider_headers") as (event: {
      headers: Record<string, string>;
    }) => void;

    beforeHeaders({ headers });

    expect(headers).toEqual({});
  });

  test("Gemini live hook honors canonical nested provider override", () => {
    const { rt } = makeIo();
    const provider: CcProvider = {
      id: "gemini-relay",
      piName: "ps-gemini-relay",
      displayName: "Gemini Relay",
      appType: "gemini",
      api: "google-generative-ai",
      baseUrl: "https://relay.example",
      apiKey: "",
      authHeader: true,
      configModels: ["gemini-2.0-flash"],
      meta: {},
      isCurrentInCc: false,
    };
    rt.config = {
      geminiToolCompat: { mode: "always" },
      providerOverrides: {
        gemini: {
          [provider.id]: { geminiToolCompat: false },
        },
      },
    };
    rt.lastGoodProviders = [provider];
    rt.readSelectionCached = () => ({
      appType: "gemini",
      dbId: provider.id,
      provider: provider.piName,
      model: provider.configModels[0],
    });

    const hooks = new Map<string, unknown>();
    installGeminiToolCompat(
      {
        on(event: string, handler: unknown) {
          hooks.set(event, handler);
        },
      } as never,
      rt,
    );
    const payload = {
      model: provider.configModels[0],
      contents: [],
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: "read",
                parametersJsonSchema: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
              },
            ],
          },
        ],
      },
    };
    const beforeRequest = hooks.get("before_provider_request") as (event: {
      payload: unknown;
    }) => unknown;

    const result = beforeRequest({ payload });

    expect(result).toBe(payload);
  });
});
