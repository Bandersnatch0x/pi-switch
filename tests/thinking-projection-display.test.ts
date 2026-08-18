import { describe, expect, test } from "bun:test";
import {
  formatThinkingProjectionDetail,
  thinkingProjectionNeedsWarning,
} from "../src/capabilities/thinking-projection-display.ts";
import type {
  ThinkingIntentProjection,
  ThinkingProjectionDecision,
} from "../src/capabilities/thinking-projection.ts";
import { canonicalProviderEndpointTuple } from "../src/capabilities/thinking-projection.ts";

const effort = (value: string) => ({ type: "effort" as const, value });

function decision(
  over: Partial<ThinkingProjectionDecision> = {},
): ThinkingProjectionDecision {
  const projections: ThinkingIntentProjection[] = [
    {
      intent: "provider-default",
      native: effort("high"),
      effectiveLevel: "high",
      status: "provider-default",
      source: "codex-model-catalog",
    },
    {
      intent: "max",
      native: effort("max"),
      effectiveLevel: "max",
      status: "exact",
      source: "codex-model-catalog",
    },
  ];
  return {
    tuple: canonicalProviderEndpointTuple({
      appType: "codex",
      providerId: "relay",
      api: "openai-responses",
      baseUrl: "https://relay.example/v1",
      modelId: "gpt-5.6-sol",
    }),
    tupleKey: "codex:relay:gpt-5.6-sol",
    profileVersion: "catalog@1",
    control: { type: "effort" },
    map: { max: "max" },
    advertised: [effort("high"), effort("max"), effort("ultra")],
    unrepresented: [effort("ultra")],
    projections,
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

describe("thinking projection display", () => {
  test("formats exact, provider-default, and unrepresented native values", () => {
    const detail = formatThinkingProjectionDetail(decision());

    expect(detail).toContain("max -> max (exact");
    expect(detail).toContain("provider-default: no override sent");
    expect(detail).toContain("ultra advertised but not selectable by this Pi runtime");
    expect(detail).not.toContain("relay.example");
    expect(thinkingProjectionNeedsWarning(decision())).toBe(false);

    expect(
      thinkingProjectionNeedsWarning(
        decision({
          warnings: ["installed adapter cannot preserve explicit off"],
        }),
      ),
    ).toBe(true);
  });

  test("formats exact-model lossy opt-in and reports displaced native max", () => {
    const d = decision({
      map: { max: "ultra" },
      projections: [
        decision().projections[0]!,
        {
          intent: "max",
          native: effort("ultra"),
          effectiveLevel: "max",
          status: "lossy",
          source: "user-map",
          scope: "exact-model",
        },
      ],
      unrepresented: [effort("max")],
      status: "lossy",
    });

    const detail = formatThinkingProjectionDetail(d);
    expect(detail).toContain("Pi max -> provider ultra");
    expect(detail).toContain("exact-model");
    expect(detail).toContain("native max unavailable");
    expect(thinkingProjectionNeedsWarning(d)).toBe(true);
  });

  test("formats collisions, fixed controls, unsupported runtime, and stale evidence", () => {
    const collision = decision({
      status: "lossy",
      collisions: [
        {
          effectiveLevel: "high",
          intents: ["medium", "high"],
          providerValues: ["medium", "high"],
        },
      ],
    });
    expect(formatThinkingProjectionDetail(collision)).toContain(
      "collision: medium/high -> effective high",
    );

    const fixed = decision({
      control: { type: "fixed", enabled: true },
      map: undefined,
      advertised: [],
      unrepresented: [],
      projections: [decision().projections[0]!],
      status: "provider-default",
    });
    expect(formatThinkingProjectionDetail(fixed)).toContain(
      "reasoning is fixed for this model; no selectable level",
    );
    expect(thinkingProjectionNeedsWarning(fixed)).toBe(false);

    const unsupported = decision({
      map: undefined,
      status: "unsupported",
      runtime: {
        version: "0.84.2",
        runtimeVerified: true,
        payloadVerified: false,
        supportedControls: [],
        providerDefault: "supported",
        off: "unsupported",
      },
      warnings: ["Pi 0.80.0 has no passing payload fixture for this tuple"],
    });
    expect(formatThinkingProjectionDetail(unsupported)).toContain(
      "thinking=unsupported-runtime",
    );
    expect(thinkingProjectionNeedsWarning(unsupported)).toBe(true);

    const unsupportedProfile = decision({
      map: undefined,
      status: "unsupported",
      runtime: {
        ...decision().runtime,
        payloadVerified: true,
      },
    });
    expect(formatThinkingProjectionDetail(unsupportedProfile)).toContain(
      "thinking=unsupported;",
    );
    expect(formatThinkingProjectionDetail(unsupportedProfile)).not.toContain(
      "unsupported-runtime",
    );

    const stale = decision({ stale: true });
    expect(formatThinkingProjectionDetail(stale)).toContain("stale last-good");
    expect(thinkingProjectionNeedsWarning(stale)).toBe(true);
  });
});
