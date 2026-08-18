import { describe, expect, test } from "bun:test";
import {
  activeExactModelThinkingOptIn,
  exactModelThinkingOptInFor,
  toggleExactModelThinkingOptIn,
  validateExactModelThinkingOptIn,
} from "../src/capabilities/thinking-opt-in.ts";
import {
  readPiSwitchConfig,
  writeExactModelThinkingOptIn,
  writeModelMetaOverride,
} from "../src/settings.ts";
import { resolveProviderOverride } from "../src/provider-override.ts";
import type { FsLike } from "../src/json-file.ts";
import {
  canonicalProviderEndpointTuple,
  providerEndpointTupleKey,
  type ThinkingProjectionDecision,
} from "../src/capabilities/thinking-projection.ts";

const effort = (value: string) => ({ type: "effort" as const, value });

function decision(
  over: Partial<ThinkingProjectionDecision> = {},
): ThinkingProjectionDecision {
  const tuple = canonicalProviderEndpointTuple({
    appType: "codex",
    providerId: "relay",
    api: "openai-responses" as const,
    baseUrl: "https://relay.example/v1",
    modelId: "gpt-5.6-sol",
  });
  return {
    tuple,
    tupleKey: providerEndpointTupleKey(tuple),
    profileVersion: "catalog@1",
    control: { type: "effort" },
    map: { max: "max" },
    advertised: [effort("max"), effort("ultra")],
    unrepresented: [effort("ultra")],
    projections: [],
    collisions: [],
    source: "codex-model-catalog",
    observedAt: "2026-08-17T00:00:00.000Z",
    stale: false,
    status: "exact",
    runtime: {
      version: "0.84.2",
      runtimeVerified: true,
      payloadVerified: true,
      supportedControls: ["effort"],
      providerDefault: "supported",
      off: "indistinguishable-from-provider-default",
    },
    warnings: [],
    ...over,
  };
}

function memFs(initial: Record<string, string> = {}): FsLike & { store: Record<string, string> } {
  const store = { ...initial };
  return {
    store,
    existsSync: (path) => Object.prototype.hasOwnProperty.call(store, path),
    readFileSync: (path) => store[path] ?? "",
    writeFileSync: (path, data) => {
      store[path] = String(data);
    },
    renameSync: (from, to) => {
      store[to] = store[from] ?? "";
      delete store[from];
    },
  };
}

const scope = { kind: "model" as const, modelId: "gpt-5.6-sol" };
const provider = {
  id: "relay",
  piName: "ps-codex-relay",
  displayName: "Relay",
  appType: "codex",
  api: "openai-responses" as const,
  baseUrl: "https://relay.example/v1",
};

describe("exact-model thinking opt-in", () => {
  test("toggles immutable draft state and keeps save metadata synchronized", () => {
    const original = {
      maxTokens: 32_000,
      thinkingLevelMap: { high: "high" },
    };
    const enabled = toggleExactModelThinkingOptIn(
      original,
      scope,
      decision(),
      { piLevel: "max", nativeValue: "ultra" },
    );
    expect(enabled).toEqual({
      ok: true,
      modelMeta: {
        maxTokens: 32_000,
        thinkingLevelMap: { high: "high", max: "ultra" },
      },
      requested: { piLevel: "max", nativeValue: "ultra" },
    });
    expect(original).toEqual({
      maxTokens: 32_000,
      thinkingLevelMap: { high: "high" },
    });
    if (!enabled.ok) throw new Error(enabled.error);
    if (!enabled.requested) throw new Error("expected active opt-in request");
    expect(
      activeExactModelThinkingOptIn(enabled.modelMeta, enabled.requested),
    ).toEqual(enabled.requested);

    const disabled = toggleExactModelThinkingOptIn(
      enabled.modelMeta,
      scope,
      decision(),
      enabled.requested,
    );
    expect(disabled).toEqual({
      ok: true,
      modelMeta: {
        maxTokens: 32_000,
        thinkingLevelMap: { high: "high" },
      },
    });
    if (!disabled.ok) throw new Error(disabled.error);
    expect(
      activeExactModelThinkingOptIn(disabled.modelMeta, disabled.requested),
    ).toBeUndefined();
  });

  test("offers and writes max -> ultra when the tuple advertises ultra", () => {
    expect(exactModelThinkingOptInFor(scope, decision())).toEqual({
      piLevel: "max",
      nativeValue: "ultra",
    });

    const fs = memFs();
    const result = writeExactModelThinkingOptIn(
      { fs, configPath: "/c.json", pid: 7 },
      provider,
      scope,
      { maxTokens: 32_000, thinkingLevelMap: { high: "high" } },
      decision(),
      { piLevel: "max", nativeValue: "ultra" },
    );

    expect(result.ok).toBe(true);
    const cfg = readPiSwitchConfig(fs, "/c.json");
    const entry = resolveProviderOverride(cfg.providerOverrides, provider);
    expect(entry?.modelOverrides?.[scope.modelId]).toEqual({
      maxTokens: 32_000,
      thinkingLevelMap: { high: "high", max: "ultra" },
    });
  });

  test("rejects provider/glob/mismatched scopes and unadvertised values", () => {
    const cases = [
      validateExactModelThinkingOptIn(
        { kind: "provider" },
        decision(),
        { piLevel: "max", nativeValue: "ultra" },
      ),
      validateExactModelThinkingOptIn(
        { kind: "model", modelId: "gpt-*" },
        decision(),
        { piLevel: "max", nativeValue: "ultra" },
      ),
      validateExactModelThinkingOptIn(
        { kind: "model", modelId: "gpt-5.6-terra" },
        decision(),
        { piLevel: "max", nativeValue: "ultra" },
      ),
      validateExactModelThinkingOptIn(
        scope,
        decision({ advertised: [effort("max")] }),
        { piLevel: "max", nativeValue: "ultra" },
      ),
    ];

    for (const result of cases) expect(result.ok).toBe(false);
  });

  test("rejects ultracode shorthand without rewriting it", () => {
    const result = validateExactModelThinkingOptIn(
      scope,
      decision({ advertised: [effort("max"), effort("ultracode")] }),
      { piLevel: "max", nativeValue: "ultracode" },
    );

    expect(result).toEqual({
      ok: false,
      error: "ultracode is not an alias for ultra",
    });
  });

  test("rejects a decision from another provider tuple", () => {
    const fs = memFs();
    const result = writeExactModelThinkingOptIn(
      { fs, configPath: "/c.json", pid: 7 },
      { ...provider, id: "other-relay" },
      scope,
      {},
      decision(),
      { piLevel: "max", nativeValue: "ultra" },
    );

    expect(result.ok).toBe(false);
    expect(fs.store["/c.json"]).toBeUndefined();
  });

  test("keeps legacy raw maps as the generic-writer escape hatch", () => {
    const fs = memFs();
    const result = writeModelMetaOverride(
      { fs, configPath: "/c.json", pid: 7 },
      provider,
      scope,
      { thinkingLevelMap: { max: "ultracode" } },
    );

    expect(result.ok).toBe(true);
    const cfg = readPiSwitchConfig(fs, "/c.json");
    expect(
      resolveProviderOverride(cfg.providerOverrides, provider)
        ?.modelOverrides?.[scope.modelId]?.thinkingLevelMap?.max,
    ).toBe("ultracode");
  });
});
