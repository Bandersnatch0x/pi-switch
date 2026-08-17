import { describe, expect, test } from "bun:test";
import {
  ReasoningProfileError,
  canonicalProviderEndpointTuple,
  providerEndpointTupleKey,
  resolveThinkingProjection,
  type PiThinkingRuntimeCapability,
  type ProviderEndpointTupleInput,
  type ProviderReasoningProfile,
  type ThinkingIntentKey,
  type ThinkingProjectionDecision,
} from "../src/capabilities/thinking-projection.ts";

const OPENAI_TUPLE: ProviderEndpointTupleInput = {
  appType: "codex",
  providerId: "relay-primary",
  api: "openai-responses",
  baseUrl: "https://relay.example/v1/",
  modelId: "shared/reasoning-model",
};

const VERIFIED_EFFORT_RUNTIME: PiThinkingRuntimeCapability = {
  version: "0.81.1",
  runtimeVerified: true,
  payloadVerified: true,
  supportedControls: ["effort"],
  providerDefault: "supported",
  off: "supported",
};

function effortProfile(
  variants: ProviderReasoningProfile["variants"],
  overrides: Partial<ProviderReasoningProfile> = {},
): ProviderReasoningProfile {
  return {
    tuple: OPENAI_TUPLE,
    profileVersion: "catalog@1",
    control: { type: "effort" },
    variants,
    source: "codex-model-catalog",
    observedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

function projection(
  decision: ThinkingProjectionDecision,
  intent: ThinkingIntentKey,
) {
  const hit = decision.projections.find((candidate) => candidate.intent === intent);
  if (!hit) throw new Error(`missing projection for ${intent}`);
  return hit;
}

function effort(value: string) {
  return { type: "effort" as const, value };
}

describe("provider endpoint tuple", () => {
  test("normalizes equivalent URLs into one deterministic key", () => {
    const withSlash = canonicalProviderEndpointTuple(OPENAI_TUPLE);
    const withoutSlash = canonicalProviderEndpointTuple({
      ...OPENAI_TUPLE,
      baseUrl: "https://relay.example:443/v1",
    });

    expect(withSlash.baseUrl).toBe("https://relay.example/v1");
    expect(providerEndpointTupleKey(withSlash)).toBe(
      providerEndpointTupleKey(withoutSlash),
    );
  });

  test("keeps app, provider, API, base URL, and model in the identity", () => {
    const base = providerEndpointTupleKey(OPENAI_TUPLE);
    const variants: ProviderEndpointTupleInput[] = [
      { ...OPENAI_TUPLE, appType: "claude" },
      { ...OPENAI_TUPLE, providerId: "relay-secondary" },
      { ...OPENAI_TUPLE, api: "openai-completions" },
      { ...OPENAI_TUPLE, baseUrl: "https://regional.example/v1" },
      { ...OPENAI_TUPLE, modelId: "other-model" },
    ];

    for (const variant of variants) {
      expect(providerEndpointTupleKey(variant)).not.toBe(base);
    }
  });

  test("rejects ambiguous or credential-bearing endpoint URLs", () => {
    for (const baseUrl of [
      "relay.example/v1",
      "ftp://relay.example/v1",
      "https://user:secret@relay.example/v1",
      "https://relay.example/v1?region=one",
      "https://relay.example/v1#fragment",
    ]) {
      expect(() =>
        canonicalProviderEndpointTuple({ ...OPENAI_TUPLE, baseUrl }),
      ).toThrow(ReasoningProfileError);
    }
  });
});

describe("effort projection", () => {
  test("projects advertised Pi names, nulls sparse levels, and retains ultra", () => {
    const profile = effortProfile([
      { name: "none", piLevel: "off", native: effort("none"), effectiveLevel: "off" },
      { name: "low", native: effort("low") },
      { name: "medium", native: effort("medium") },
      { name: "high", native: effort("high") },
      { name: "xhigh", native: effort("xhigh") },
      { name: "max", native: effort("max") },
      { name: "ultra", native: effort("ultra") },
    ]);

    const decision = resolveThinkingProjection({
      tuple: OPENAI_TUPLE,
      profile,
      runtime: VERIFIED_EFFORT_RUNTIME,
      userMapScope: "none",
    });

    expect(decision.status).toBe("exact");
    expect(decision.map).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
    expect(projection(decision, "provider-default").status).toBe(
      "provider-default",
    );
    expect(projection(decision, "minimal").status).toBe("unsupported");
    expect(decision.unrepresented).toEqual([effort("ultra")]);
    expect(decision.tupleKey).toBe(providerEndpointTupleKey(OPENAI_TUPLE));
  });

  test("fails closed when Codex off is indistinguishable from default", () => {
    const profile = effortProfile([
      { name: "none", piLevel: "off", native: effort("none"), effectiveLevel: "off" },
      { name: "high", native: effort("high") },
      { name: "max", native: effort("max") },
    ]);
    const runtime: PiThinkingRuntimeCapability = {
      ...VERIFIED_EFFORT_RUNTIME,
      off: "indistinguishable-from-provider-default",
    };

    const decision = resolveThinkingProjection({
      tuple: OPENAI_TUPLE,
      profile,
      runtime,
      userMapScope: "none",
    });

    expect(decision.map?.off).toBeNull();
    expect(projection(decision, "off")).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("indistinguishable"),
    });
    expect(projection(decision, "provider-default").status).toBe(
      "provider-default",
    );
    expect(decision.warnings.join("\n")).toContain("indistinguishable");
  });

  test("never lets Pi nearest-clamp fill an authoritative sparse profile", () => {
    const decision = resolveThinkingProjection({
      tuple: OPENAI_TUPLE,
      profile: effortProfile([{ name: "medium", native: effort("medium") }]),
      runtime: VERIFIED_EFFORT_RUNTIME,
      builtInMap: { low: "low", high: "high" },
      userMapScope: "none",
    });

    expect(decision.map).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: "medium",
      high: null,
      xhigh: null,
      max: null,
    });
    expect(projection(decision, "low").status).toBe("unsupported");
    expect(projection(decision, "high").status).toBe("unsupported");
  });

  test("allows exact-model max to opt into advertised ultra and marks the loss", () => {
    const profile = effortProfile([
      { name: "max", native: effort("max") },
      { name: "ultra", native: effort("ultra") },
    ]);

    const decision = resolveThinkingProjection({
      tuple: OPENAI_TUPLE,
      profile,
      runtime: VERIFIED_EFFORT_RUNTIME,
      userMap: { max: "ultra" },
      userMapScope: "exact-model",
    });

    expect(decision.status).toBe("lossy");
    expect(decision.map?.max).toBe("ultra");
    expect(projection(decision, "max")).toMatchObject({
      native: effort("ultra"),
      status: "lossy",
      source: "user-map",
      scope: "exact-model",
    });
    expect(decision.unrepresented).toEqual([effort("max")]);
  });

  test("preserves broad or unadvertised raw maps but diagnoses them", () => {
    const decision = resolveThinkingProjection({
      tuple: OPENAI_TUPLE,
      profile: effortProfile([{ name: "high", native: effort("high") }]),
      runtime: VERIFIED_EFFORT_RUNTIME,
      userMap: { high: "turbo" },
      userMapScope: "provider",
    });

    expect(decision.map?.high).toBe("turbo");
    expect(decision.status).toBe("unverified");
    expect(projection(decision, "high")).toMatchObject({
      status: "unverified",
      source: "user-map",
      scope: "provider",
    });
    expect(decision.warnings.join("\n")).toContain("exact-model");
    expect(decision.warnings.join("\n")).toContain("not advertised");
  });

  test("does not let an exact user map bypass runtime verification", () => {
    const profile = effortProfile([
      { name: "high", native: effort("high") },
    ]);

    const unverified = resolveThinkingProjection({
      tuple: OPENAI_TUPLE,
      profile,
      runtime: {
        ...VERIFIED_EFFORT_RUNTIME,
        runtimeVerified: false,
        payloadVerified: false,
      },
      userMap: { high: "high" },
      userMapScope: "exact-model",
    });
    expect(unverified.map?.high).toBe("high");
    expect(unverified.status).toBe("unverified");
    expect(projection(unverified, "high")).toMatchObject({
      status: "unverified",
      source: "user-map",
      reason: expect.stringContaining("payload fixture"),
    });

    const unsupportedOff = resolveThinkingProjection({
      tuple: OPENAI_TUPLE,
      profile: effortProfile([
        {
          name: "none",
          piLevel: "off",
          native: effort("none"),
          effectiveLevel: "off",
        },
      ]),
      runtime: {
        ...VERIFIED_EFFORT_RUNTIME,
        off: "indistinguishable-from-provider-default",
      },
      userMap: { off: "none" },
      userMapScope: "exact-model",
    });
    expect(projection(unsupportedOff, "off")).toMatchObject({
      status: "unsupported",
      source: "user-map",
      reason: expect.stringContaining("indistinguishable"),
    });
  });

  test("reports a known runtime's unsupported control as unsupported", () => {
    const decision = resolveThinkingProjection({
      tuple: OPENAI_TUPLE,
      profile: effortProfile([{ name: "high", native: effort("high") }], {
        control: { type: "toggle" },
        variants: [
          {
            name: "high",
            native: { type: "toggle", enabled: true },
            piLevel: "high",
          },
        ],
      }),
      runtime: {
        ...VERIFIED_EFFORT_RUNTIME,
        payloadVerified: false,
        supportedControls: [],
      },
      userMapScope: "none",
    });

    expect(projection(decision, "high")).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("does not support toggle control"),
    });
    expect(decision.status).toBe("unsupported");
  });

  test("uses built-in < profile < user precedence per level", () => {
    const decision = resolveThinkingProjection({
      tuple: OPENAI_TUPLE,
      profile: effortProfile([{ name: "high", native: effort("high") }]),
      runtime: VERIFIED_EFFORT_RUNTIME,
      builtInMap: { low: "built-in-low", high: "built-in-high" },
      userMap: { low: "user-low" },
      userMapScope: "exact-model",
    });

    expect(decision.map?.low).toBe("user-low");
    expect(decision.map?.high).toBe("high");
    expect(projection(decision, "low").source).toBe("user-map");
    expect(projection(decision, "high").source).toBe("codex-model-catalog");
  });

  test("keeps per-level user scope after layered maps are deep-merged", () => {
    const decision = resolveThinkingProjection({
      tuple: OPENAI_TUPLE,
      profile: effortProfile([
        { name: "high", native: effort("high") },
        { name: "max", native: effort("max") },
        { name: "ultra", native: effort("ultra") },
      ]),
      runtime: VERIFIED_EFFORT_RUNTIME,
      userMap: { high: "high", max: "ultra" },
      userMapScope: "none",
      userMapScopes: {
        high: "provider",
        max: "exact-model",
      },
    });

    expect(projection(decision, "high")).toMatchObject({
      status: "unverified",
      source: "user-map",
    });
    expect(projection(decision, "max")).toMatchObject({
      status: "lossy",
      source: "user-map",
      scope: "exact-model",
      native: effort("ultra"),
    });
  });
});

describe("structured controls", () => {
  test("records composite collisions as lossy while extracting effort map values", () => {
    const composite = (value: string) => ({
      type: "composite" as const,
      values: [
        { type: "toggle" as const, enabled: true },
        effort(value),
      ],
    });
    const profile: ProviderReasoningProfile = {
      tuple: { ...OPENAI_TUPLE, api: "openai-completions" },
      profileVersion: "deepseek-v4@1",
      control: {
        type: "composite",
        controls: [{ type: "toggle" }, { type: "effort" }],
      },
      variants: [
        {
          name: "off",
          native: { type: "composite", values: [{ type: "toggle", enabled: false }] },
          effectiveLevel: "off",
        },
        { name: "medium", native: composite("high"), effectiveLevel: "high" },
        { name: "high", native: composite("high"), effectiveLevel: "high" },
        { name: "xhigh", native: composite("high"), effectiveLevel: "high" },
      ],
      source: "built-in",
      observedAt: "2026-08-17T00:00:00.000Z",
    };
    const runtime: PiThinkingRuntimeCapability = {
      version: "0.81.1",
      runtimeVerified: true,
      payloadVerified: true,
      supportedControls: ["composite"],
      providerDefault: "supported",
      off: "supported",
    };

    const decision = resolveThinkingProjection({
      tuple: profile.tuple,
      profile,
      runtime,
      userMapScope: "none",
    });

    expect(decision.status).toBe("lossy");
    expect(decision.map).toMatchObject({
      minimal: null,
      low: null,
      medium: "high",
      high: "high",
      xhigh: "high",
      max: null,
    });
    expect(decision.map?.off).toBe("off");
    for (const intent of ["medium", "high", "xhigh"] as const) {
      expect(projection(decision, intent).status).toBe("lossy");
    }
    expect(decision.collisions).toEqual([
      {
        effectiveLevel: "high",
        intents: ["medium", "high", "xhigh"],
        providerValues: ["high"],
      },
    ]);
  });

  test("preserves GLM minimal effort while reporting its effective off collision", () => {
    const tuple = { ...OPENAI_TUPLE, api: "openai-completions" as const };
    const profile: ProviderReasoningProfile = {
      tuple,
      profileVersion: "glm-5.2@1",
      control: {
        type: "composite",
        controls: [{ type: "toggle" }, { type: "effort" }],
      },
      variants: [
        {
          name: "off",
          native: { type: "composite", values: [{ type: "toggle", enabled: false }] },
          effectiveLevel: "off",
        },
        {
          name: "minimal",
          native: {
            type: "composite",
            values: [
              { type: "toggle", enabled: true },
              effort("minimal"),
            ],
          },
          effectiveLevel: "off",
        },
      ],
      source: "built-in",
      observedAt: "2026-08-17T00:00:00.000Z",
    };
    const runtime: PiThinkingRuntimeCapability = {
      version: "0.84.2",
      runtimeVerified: true,
      payloadVerified: true,
      supportedControls: ["composite"],
      providerDefault: "unsupported",
      off: "supported",
    };

    const decision = resolveThinkingProjection({
      tuple,
      profile,
      runtime,
      userMapScope: "none",
    });

    expect(decision.status).toBe("lossy");
    expect(decision.map).toEqual({
      off: "off",
      minimal: "minimal",
      low: null,
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    });
    expect(projection(decision, "minimal")).toMatchObject({
      status: "lossy",
      effectiveLevel: "off",
      native: {
        type: "composite",
        values: [
          { type: "toggle", enabled: true },
          { type: "effort", value: "minimal" },
        ],
      },
    });
    expect(decision.collisions).toEqual([
      {
        effectiveLevel: "off",
        intents: ["off", "minimal"],
        providerValues: ["toggle:false", "minimal"],
      },
    ]);
  });

  test("uses Pi strings only as a support mask for toggle and fixed controls", () => {
    const tuple = { ...OPENAI_TUPLE, api: "openai-completions" as const };
    const runtime: PiThinkingRuntimeCapability = {
      version: "0.81.1",
      runtimeVerified: true,
      payloadVerified: true,
      supportedControls: ["toggle", "fixed"],
      providerDefault: "supported",
      off: "supported",
    };
    const toggleProfile: ProviderReasoningProfile = {
      tuple,
      profileVersion: "toggle@1",
      control: { type: "toggle" },
      variants: [
        { name: "off", native: { type: "toggle", enabled: false } },
        {
          name: "enabled",
          piLevel: "high",
          native: { type: "toggle", enabled: true },
          effectiveLevel: "high",
        },
      ],
      source: "built-in",
      observedAt: "2026-08-17T00:00:00.000Z",
    };
    const toggle = resolveThinkingProjection({
      tuple,
      profile: toggleProfile,
      runtime,
      userMapScope: "none",
    });

    expect(toggle.map).toEqual({
      off: "off",
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });
    expect(projection(toggle, "off").status).toBe("exact");
    expect(projection(toggle, "high").status).toBe("exact");
    expect(projection(toggle, "medium").status).toBe("unsupported");

    const fixed = resolveThinkingProjection({
      tuple,
      profile: {
        ...toggleProfile,
        profileVersion: "fixed@1",
        control: { type: "fixed", enabled: true },
        variants: [],
      },
      runtime,
      userMapScope: "none",
    });
    expect(fixed.status).toBe("provider-default");
    expect(fixed.map).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    });
    expect(projection(fixed, "off").status).toBe("unsupported");
    expect(projection(fixed, "high").status).toBe("unsupported");
  });

  test("marks every token budget projection lossy and validates model bounds", () => {
    const tuple = { ...OPENAI_TUPLE, api: "anthropic-messages" as const };
    const profile: ProviderReasoningProfile = {
      tuple,
      profileVersion: "claude-budget@1",
      control: {
        type: "budget_tokens",
        minTokens: 1024,
        maxTokensExclusive: 32_000,
      },
      variants: [
        {
          name: "high",
          native: { type: "budget_tokens", tokens: 16_000 },
        },
        {
          name: "max",
          native: { type: "budget_tokens", tokens: 31_999 },
        },
      ],
      source: "built-in",
      observedAt: "2026-08-17T00:00:00.000Z",
    };
    const runtime: PiThinkingRuntimeCapability = {
      version: "0.81.1",
      runtimeVerified: true,
      payloadVerified: true,
      supportedControls: ["budget_tokens"],
      providerDefault: "supported",
      off: "unsupported",
    };

    const decision = resolveThinkingProjection({
      tuple,
      profile,
      runtime,
      userMapScope: "none",
    });
    expect(decision.status).toBe("lossy");
    expect(projection(decision, "high").status).toBe("lossy");
    expect(projection(decision, "max").status).toBe("lossy");
    expect(decision.map).toMatchObject({ high: "high", max: "max" });

    expect(() =>
      resolveThinkingProjection({
        tuple,
        profile: {
          ...profile,
          variants: [
            {
              name: "max",
              native: { type: "budget_tokens", tokens: 32_000 },
            },
          ],
        },
        runtime,
        userMapScope: "none",
      }),
    ).toThrow(ReasoningProfileError);
  });
});

describe("authority and validation", () => {
  test("keeps stale last-good projections visible and marks the decision unverified", () => {
    const decision = resolveThinkingProjection({
      tuple: OPENAI_TUPLE,
      profile: effortProfile([{ name: "high", native: effort("high") }], {
        stale: true,
      }),
      runtime: VERIFIED_EFFORT_RUNTIME,
      userMapScope: "none",
    });

    expect(decision.stale).toBeTrue();
    expect(decision.map?.high).toBe("high");
    expect(projection(decision, "high").status).toBe("exact");
    expect(decision.status).toBe("unverified");
    expect(decision.warnings.join("\n")).toContain("stale last-good");
  });

  test("keeps unverified runtime profiles diagnostic-only", () => {
    const decision = resolveThinkingProjection({
      tuple: OPENAI_TUPLE,
      profile: effortProfile([{ name: "high", native: effort("high") }]),
      runtime: {
        ...VERIFIED_EFFORT_RUNTIME,
        runtimeVerified: false,
        payloadVerified: false,
      },
      userMapScope: "none",
    });

    expect(decision.map).toBeUndefined();
    expect(decision.status).toBe("unverified");
    expect(projection(decision, "high").status).toBe("unverified");
    expect(decision.warnings.join("\n")).toContain("0.81.1");
  });

  test("keeps unsupported structured controls diagnostic-only", () => {
    const tuple = { ...OPENAI_TUPLE, api: "anthropic-messages" as const };
    const profile: ProviderReasoningProfile = {
      tuple,
      profileVersion: "claude-budget@1",
      control: { type: "budget_tokens", minTokens: 1024 },
      variants: [
        {
          name: "high",
          native: { type: "budget_tokens", tokens: 8_192 },
        },
      ],
      source: "built-in",
      observedAt: "2026-08-17T00:00:00.000Z",
    };

    const decision = resolveThinkingProjection({
      tuple,
      profile,
      runtime: {
        ...VERIFIED_EFFORT_RUNTIME,
        supportedControls: ["effort"],
        off: "unsupported",
      },
      userMapScope: "none",
    });

    expect(decision.map).toBeUndefined();
    expect(decision.status).toBe("unsupported");
    expect(projection(decision, "high")).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("budget_tokens"),
    });
    expect(decision.unrepresented).toEqual([
      { type: "budget_tokens", tokens: 8_192 },
    ]);
  });

  test("diagnoses a legacy built-in map when no exact profile exists", () => {
    const decision = resolveThinkingProjection({
      tuple: OPENAI_TUPLE,
      runtime: VERIFIED_EFFORT_RUNTIME,
      builtInMap: { high: "high" },
      userMapScope: "none",
    });

    expect(decision.map).toEqual({ high: "high" });
    expect(decision.status).toBe("unverified");
    expect(projection(decision, "high").status).toBe("unverified");
    expect(decision.warnings.join("\n")).toContain("exact profile");
  });

  test("rejects a profile from another endpoint tuple", () => {
    const profile = effortProfile([{ name: "high", native: effort("high") }], {
      tuple: { ...OPENAI_TUPLE, baseUrl: "https://other.example/v1" },
    });

    try {
      resolveThinkingProjection({
        tuple: OPENAI_TUPLE,
        profile,
        runtime: VERIFIED_EFFORT_RUNTIME,
        userMapScope: "none",
      });
      throw new Error("expected tuple mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(ReasoningProfileError);
      expect((error as ReasoningProfileError).code).toBe("tuple-mismatch");
    }
  });

  test("rejects duplicate variant names and duplicate Pi levels", () => {
    const duplicateNames = effortProfile([
      { name: "high", native: effort("high") },
      { name: "HIGH", piLevel: "xhigh", native: effort("xhigh") },
    ]);
    const duplicateLevels = effortProfile([
      { name: "first", piLevel: "high", native: effort("high") },
      { name: "second", piLevel: "high", native: effort("turbo") },
    ]);

    for (const profile of [duplicateNames, duplicateLevels]) {
      expect(() =>
        resolveThinkingProjection({
          tuple: OPENAI_TUPLE,
          profile,
          runtime: VERIFIED_EFFORT_RUNTIME,
          userMapScope: "none",
        }),
      ).toThrow(ReasoningProfileError);
    }
  });

  test("rejects malformed control, native, level, and source fields at runtime", () => {
    const invalidProfiles = [
      {
        ...effortProfile([]),
        control: { type: "fixed", enabled: "yes" },
      },
      {
        ...effortProfile([]),
        control: { type: "toggle" },
        variants: [
          {
            name: "high",
            native: { type: "toggle", enabled: "yes" },
          },
        ],
      },
      {
        ...effortProfile([]),
        variants: [
          {
            name: "high",
            native: effort("high"),
            effectiveLevel: "ultra",
          },
        ],
      },
      {
        ...effortProfile([]),
        source: "remote-guess",
      },
      {
        ...effortProfile([]),
        control: {
          type: "composite",
          controls: [{ type: "toggle" }, { type: "fixed", enabled: true }],
        },
      },
    ] as unknown as ProviderReasoningProfile[];

    for (const profile of invalidProfiles) {
      try {
        resolveThinkingProjection({
          tuple: OPENAI_TUPLE,
          profile,
          runtime: VERIFIED_EFFORT_RUNTIME,
          userMapScope: "none",
        });
        throw new Error("expected invalid profile");
      } catch (error) {
        expect(error).toBeInstanceOf(ReasoningProfileError);
        expect((error as ReasoningProfileError).code).toBe("invalid-profile");
      }
    }
  });

  test("rejects malformed runtime capability fields", () => {
    const invalidRuntimes = [
      { ...VERIFIED_EFFORT_RUNTIME, payloadVerified: "yes" },
      { ...VERIFIED_EFFORT_RUNTIME, runtimeVerified: false },
      { ...VERIFIED_EFFORT_RUNTIME, supportedControls: ["mystery"] },
      { ...VERIFIED_EFFORT_RUNTIME, providerDefault: "automatic" },
      { ...VERIFIED_EFFORT_RUNTIME, off: "default" },
    ] as unknown as PiThinkingRuntimeCapability[];

    for (const runtime of invalidRuntimes) {
      try {
        resolveThinkingProjection({
          tuple: OPENAI_TUPLE,
          profile: effortProfile([]),
          runtime,
          userMapScope: "none",
        });
        throw new Error("expected invalid runtime");
      } catch (error) {
        expect(error).toBeInstanceOf(ReasoningProfileError);
        expect((error as ReasoningProfileError).code).toBe("invalid-runtime");
      }
    }
  });

  test("does not mutate caller profiles or maps", () => {
    const profile = effortProfile([{ name: "high", native: effort("high") }]);
    const userMap = { high: "turbo" } as const;
    const userMapScopes = { high: "exact-model" } as const;
    const beforeProfile = structuredClone(profile);
    const beforeMap = structuredClone(userMap);
    const beforeScopes = structuredClone(userMapScopes);

    resolveThinkingProjection({
      tuple: OPENAI_TUPLE,
      profile,
      runtime: VERIFIED_EFFORT_RUNTIME,
      userMap,
      userMapScope: "exact-model",
      userMapScopes,
    });

    expect(profile).toEqual(beforeProfile);
    expect(userMap).toEqual(beforeMap);
    expect(userMapScopes).toEqual(beforeScopes);
  });
});
