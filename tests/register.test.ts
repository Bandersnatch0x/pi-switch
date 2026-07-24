import { test, expect, describe } from "bun:test";
import { switchToProvider, buildProviderConfig } from "../src/register.ts";
import type { CcProvider } from "../src/types.ts";

function mk(partial: Partial<CcProvider> & Pick<CcProvider, "id" | "appType">): CcProvider {
  return {
    piName: `ps-${partial.appType}-${partial.id}`,
    displayName: partial.displayName ?? `name-${partial.id}`,
    api: "anthropic-messages",
    baseUrl: "https://example.com",
    apiKey: "k",
    authHeader: true,
    configModels: ["m1"],
    meta: {},
    isCurrentInCc: false,
    ...partial,
  };
}

interface Call {
  op: "register" | "unregister" | "setModel";
  arg: unknown;
}

function fakePi(opts?: { setModelResult?: boolean; hasUnregister?: boolean }) {
  const calls: Call[] = [];
  const pi: any = {
    registerProvider: (name: string, config: Record<string, unknown>) => {
      calls.push({ op: "register", arg: { name, config } });
    },
    setModel: (model: unknown) => {
      calls.push({ op: "setModel", arg: model });
      return opts?.setModelResult ?? true;
    },
  };
  if (opts?.hasUnregister !== false) {
    pi.unregisterProvider = (name: string) => {
      calls.push({ op: "unregister", arg: name });
    };
  }
  return { pi, calls };
}

describe("buildProviderConfig", () => {
  test("switchable provider yields config with models", () => {
    const cfg = buildProviderConfig(mk({ id: "1", appType: "claude" }), ["gpt"], {
      rules: [],
    });
    expect(cfg).toBeDefined();
    expect(cfg?.baseUrl).toBe("https://example.com");
    expect((cfg?.models as any[]).length).toBe(1);
    expect((cfg?.models as any[])[0].id).toBe("gpt");
  });

  test("non-switchable provider yields undefined", () => {
    const cfg = buildProviderConfig(
      mk({ id: "2", appType: "claude", api: null, parseError: "unsupported" }),
      ["m"],
      { rules: [] },
    );
    expect(cfg).toBeUndefined();
  });

  test("falls back to configModels when no ids given", () => {
    const cfg = buildProviderConfig(mk({ id: "3", appType: "claude" }), [], {
      rules: [],
    });
    expect((cfg?.models as any[])[0].id).toBe("m1");
  });

  test("per-api tiered meta (review #4)", () => {
    const anthropic = buildProviderConfig(
      mk({ id: "a", appType: "claude", api: "anthropic-messages" }),
      ["m"],
      { rules: [] },
    );
    const am = (anthropic?.models as any[])[0];
    expect(am.contextWindow).toBe(200_000);
    expect(am.maxTokens).toBe(64_000);
    expect(am.input).toEqual(["text", "image"]);
    expect(am.reasoning).toBe(true);

    const gemini = buildProviderConfig(
      mk({ id: "g", appType: "gemini", api: "google-generative-ai" }),
      ["m"],
      { rules: [] },
    );
    expect((gemini?.models as any[])[0].contextWindow).toBe(1_000_000);

    const chat = buildProviderConfig(
      mk({ id: "c", appType: "hermes", api: "openai-completions" }),
      ["m"],
      { rules: [] },
    );
    const cm = (chat?.models as any[])[0];
    expect(cm.contextWindow).toBe(128_000);
    expect(cm.input).toEqual(["text"]);
    expect(cm.reasoning).toBe(false);
  });

  test("modelMeta override disables reasoning (GLM-via-claude fix)", () => {
    // A claude-protocol provider whose upstream is actually GLM (dooongai-style
    // relay) rejects the `reasoning` request param. Per-provider modelMeta lets
    // the user turn it off without disabling thinking globally.
    const cfg = buildProviderConfig(
      mk({ id: "glm", appType: "claude", api: "anthropic-messages" }),
      ["glm-5.2"],
      { rules: [], modelMeta: { reasoning: false } },
    );
    const m = (cfg?.models as any[])[0];
    expect(m.reasoning).toBe(false);
    // other tier defaults are preserved
    expect(m.contextWindow).toBe(200_000);
    expect(m.input).toEqual(["text", "image"]);
  });

  test("modelMeta override can raise contextWindow / maxTokens", () => {
    const cfg = buildProviderConfig(
      mk({ id: "big", appType: "claude", api: "anthropic-messages" }),
      ["m"],
      { rules: [], modelMeta: { contextWindow: 1_000_000, maxTokens: 128_000 } },
    );
    const m = (cfg?.models as any[])[0];
    expect(m.contextWindow).toBe(1_000_000);
    expect(m.maxTokens).toBe(128_000);
    // reasoning still follows api tier when not overridden
    expect(m.reasoning).toBe(true);
  });

  test("no modelMeta keeps api-tier defaults", () => {
    const cfg = buildProviderConfig(
      mk({ id: "def", appType: "claude", api: "anthropic-messages" }),
      ["m"],
      { rules: [] },
    );
    const m = (cfg?.models as any[])[0];
    expect(m.reasoning).toBe(true);
    expect(m.contextWindow).toBe(200_000);
  });
});

describe("switchToProvider commit order (SPEC §8.6)", () => {
  test("success: register → setModel → cleanup previous names", async () => {
    const { pi, calls } = fakePi({ setModelResult: true });
    const provider = mk({ id: "new", appType: "codex" });
    const r = await switchToProvider({
      pi,
      provider,
      modelId: "gpt-5",
      findModel: () => ({ id: "gpt-5" }),
      previousPsNames: ["ps-claude-old", provider.piName],
      rules: [],
    });
    expect(r.ok).toBe(true);
    const ops = calls.map((c) => c.op);
    // register must precede setModel; cleanup only after setModel
    expect(ops.indexOf("register")).toBeLessThan(ops.indexOf("setModel"));
    expect(ops.indexOf("setModel")).toBeLessThan(ops.indexOf("unregister"));
    // only the stale ps-* is unregistered, not the newly registered one
    const unregistered = calls.filter((c) => c.op === "unregister").map((c) => c.arg);
    expect(unregistered).toEqual(["ps-claude-old"]);
  });

  test("success: also unregisters human-readable previous names", async () => {
    const { pi, calls } = fakePi({ setModelResult: true });
    const provider = mk({
      id: "new",
      appType: "claude",
      piName: "elysiver-claude",
      displayName: "elysiver-claude",
    });
    const r = await switchToProvider({
      pi,
      provider,
      modelId: "glm-5.2",
      findModel: () => ({ id: "glm-5.2" }),
      previousPsNames: ["ps-claude-dooongai-1775180253543", "other-friendly", provider.piName],
      rules: [],
    });
    expect(r.ok).toBe(true);
    const unregistered = calls.filter((c) => c.op === "unregister").map((c) => c.arg);
    expect(unregistered).toEqual([
      "ps-claude-dooongai-1775180253543",
      "other-friendly",
    ]);
  });

  test("setModel fails: no cleanup, returns error", async () => {
    const { pi, calls } = fakePi({ setModelResult: false });
    const provider = mk({ id: "x", appType: "codex" });
    const r = await switchToProvider({
      pi,
      provider,
      modelId: "m",
      findModel: () => ({ id: "m" }),
      previousPsNames: ["ps-claude-old"],
      rules: [],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("setModel failed");
    expect(calls.some((c) => c.op === "unregister")).toBe(false);
  });

  test("non-switchable provider: never registers or setModel", async () => {
    const { pi, calls } = fakePi();
    const r = await switchToProvider({
      pi,
      provider: mk({ id: "bad", appType: "codex", api: null, parseError: "unsupported apiFormat" }),
      modelId: "m",
      findModel: () => ({ id: "m" }),
      rules: [],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("unsupported apiFormat");
    expect(calls.length).toBe(0);
  });

  test("model not found after register: error, no setModel", async () => {
    const { pi, calls } = fakePi();
    const r = await switchToProvider({
      pi,
      provider: mk({ id: "y", appType: "codex" }),
      modelId: "ghost",
      findModel: () => undefined,
      rules: [],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("model not found after register");
    expect(calls.some((c) => c.op === "register")).toBe(true);
    expect(calls.some((c) => c.op === "setModel")).toBe(false);
  });

  test("no unregisterProvider on pi: success without cleanup", async () => {
    const { pi, calls } = fakePi({ setModelResult: true, hasUnregister: false });
    const provider = mk({ id: "z", appType: "codex" });
    const r = await switchToProvider({
      pi,
      provider,
      modelId: "m",
      findModel: () => ({ id: "m" }),
      previousPsNames: ["ps-claude-old"],
      rules: [],
    });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.op === "unregister")).toBe(false);
  });
});
