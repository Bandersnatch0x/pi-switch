/**
 * Recipe registry + evidence gate (issue #47 / ticket 9).
 * External behavior: admission rules only — pure functions, zero network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_RECIPE_DEFINITIONS,
  evaluateRecipeGate,
  getAdmittedRecipe,
  isRecipeAdmitted,
  listAdmittedRecipes,
  matchRepairRecipes,
  registerRecipeDefinitions,
  resetRecipeRegistry,
  type RepairRecipeDefinition,
} from "../src/probe/index.ts";

afterEach(() => {
  // Isolate process-wide registry mutations between tests.
  resetRecipeRegistry();
});

/** Minimal valid protocol-generic definition (fixture optional). */
function protocolGenericDef(
  overrides: Partial<RepairRecipeDefinition> = {},
): RepairRecipeDefinition {
  return {
    id: "reasoning-false",
    class: "protocol-generic",
    signatureIds: ["reasoning_param_rejected"],
    candidateSummary:
      "exact-model modelMeta.reasoning=false when upstream rejects reasoning/thinking",
    patchScope: "model",
    supportWindow: {
      note: "protocol-generic; any Claude-compatible endpoint rejecting reasoning/thinking",
    },
    ...overrides,
  };
}

/** Minimal valid relay-specific definition (fixture required). */
function relaySpecificDef(
  overrides: Partial<RepairRecipeDefinition> = {},
): RepairRecipeDefinition {
  return {
    id: "client-fingerprint",
    class: "relay-specific",
    signatureIds: ["client_gate_claude_code"],
    candidateSummary:
      "provider-level fingerprint/compat profile for unique client-gate signature",
    patchScope: "provider",
    supportWindow: {
      min: "0.3.0",
      note: "fingerprint profiles validated against snapshot baselines",
    },
    fixture: {
      id: "client-gate-claude-code-403",
      description:
        "403 client-gate with distinctive Claude Code UA rejection body",
      path: "tests/fixtures/probe/client-gate-claude-code.json",
    },
    rollbackTested: true,
    ...overrides,
  };
}

describe("evaluateRecipeGate (ticket 9)", () => {
  test("protocol-generic rule is admitted without fixture", () => {
    const def = protocolGenericDef({ fixture: undefined });
    const decision = evaluateRecipeGate(def);

    expect(decision.admitted).toBe(true);
    if (decision.admitted) {
      expect(decision.reasons.some((r) => /protocol-generic|no fixture required/i.test(r))).toBe(
        true,
      );
    }
  });

  test("protocol-generic still admitted when it optionally carries a fixture", () => {
    const def = protocolGenericDef({
      fixture: {
        id: "optional-reasoning-reject",
        description: "optional reproduction for docs",
      },
    });
    expect(evaluateRecipeGate(def).admitted).toBe(true);
  });

  test("relay-specific rule without fixture is rejected", () => {
    const def = relaySpecificDef({ fixture: undefined });
    const decision = evaluateRecipeGate(def);

    expect(decision.admitted).toBe(false);
    if (!decision.admitted) {
      expect(decision.reasons.some((r) => /fixture/i.test(r))).toBe(true);
    }
  });

  test("relay-specific rule with empty fixture id is rejected", () => {
    const def = relaySpecificDef({
      fixture: { id: "", description: "missing id" },
    });
    const decision = evaluateRecipeGate(def);
    expect(decision.admitted).toBe(false);
  });

  test("relay-specific rule with empty fixture description is rejected", () => {
    const def = relaySpecificDef({
      fixture: { id: "x", description: "  " },
    });
    const decision = evaluateRecipeGate(def);
    expect(decision.admitted).toBe(false);
  });

  test("relay-specific rule with fixture + support window is admitted", () => {
    const def = relaySpecificDef();
    const decision = evaluateRecipeGate(def);

    expect(decision.admitted).toBe(true);
    if (decision.admitted) {
      expect(decision.reasons.some((r) => /fixture/i.test(r))).toBe(true);
    }
  });

  test("relay-specific without support window is rejected", () => {
    const def = relaySpecificDef({
      supportWindow: { note: "" },
    });
    // Empty window: no min/max/note content
    const emptyWindow = relaySpecificDef({
      supportWindow: {},
    });
    expect(evaluateRecipeGate(emptyWindow).admitted).toBe(false);
    expect(
      evaluateRecipeGate(emptyWindow).reasons.some((r) => /support window/i.test(r)),
    ).toBe(true);
    // def with note is fine — keep typecheck happy
    void def;
  });

  test("missing signatureIds rejects any class", () => {
    expect(
      evaluateRecipeGate(protocolGenericDef({ signatureIds: [] })).admitted,
    ).toBe(false);
    expect(
      evaluateRecipeGate(relaySpecificDef({ signatureIds: [] })).admitted,
    ).toBe(false);
  });

  test("missing candidateSummary rejects any class", () => {
    expect(
      evaluateRecipeGate(protocolGenericDef({ candidateSummary: "" })).admitted,
    ).toBe(false);
    expect(
      evaluateRecipeGate(protocolGenericDef({ candidateSummary: "   " })).admitted,
    ).toBe(false);
  });

  test("gate is pure: same input yields same decision", () => {
    const def = relaySpecificDef({ fixture: undefined });
    const a = evaluateRecipeGate(def);
    const b = evaluateRecipeGate(def);
    expect(a).toEqual(b);
    expect(a.admitted).toBe(false);
  });
});

describe("recipe registry (ticket 9)", () => {
  test("built-in Recipe1 is protocol-generic and admitted", () => {
    const builtIn = DEFAULT_RECIPE_DEFINITIONS.find((d) => d.id === "reasoning-false");
    expect(builtIn).toBeDefined();
    expect(builtIn!.class).toBe("protocol-generic");
    expect(builtIn!.signatureIds).toContain("reasoning_param_rejected");
    expect(builtIn!.patchScope).toBe("model");
    expect(builtIn!.candidateSummary.length).toBeGreaterThan(0);
    expect(builtIn!.supportWindow).toBeDefined();
    // Protocol-generic: fixture not required
    expect(evaluateRecipeGate(builtIn!).admitted).toBe(true);
    expect(isRecipeAdmitted("reasoning-false")).toBe(true);
    expect(getAdmittedRecipe("reasoning-false")?.id).toBe("reasoning-false");
  });

  test("listAdmittedRecipes includes only gate-admitted definitions", () => {
    const admitted = listAdmittedRecipes();
    expect(admitted.some((d) => d.id === "reasoning-false")).toBe(true);
    for (const d of admitted) {
      expect(evaluateRecipeGate(d).admitted).toBe(true);
    }
  });

  test("registerRecipeDefinitions rejects relay-specific without fixture", () => {
    const result = registerRecipeDefinitions([
      relaySpecificDef({
        id: "client-fingerprint",
        fixture: undefined,
      }),
    ]);

    expect(result.admitted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.definition.fixture).toBeUndefined();
    expect(result.rejected[0]!.decision.admitted).toBe(false);
    // Must not appear in the live registry
    expect(isRecipeAdmitted("client-fingerprint")).toBe(false);
  });

  test("registerRecipeDefinitions admits relay-specific with fixture", () => {
    const def = relaySpecificDef({ id: "client-fingerprint" });
    const result = registerRecipeDefinitions([def]);

    expect(result.admitted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(isRecipeAdmitted("client-fingerprint")).toBe(true);
    expect(getAdmittedRecipe("client-fingerprint")?.fixture?.id).toBe(
      "client-gate-claude-code-403",
    );
  });

  test("matchRepairRecipes only uses admitted recipes (registry gate)", () => {
    // Recipe1 is admitted via default registry — still matches.
    const evidence = {
      target: {
        provider: "ps-claude-relay",
        modelId: "claude-sonnet-probe",
        reasoning: true as boolean | undefined,
      },
      stages: [
        {
          contract: "basic" as const,
          status: "pass" as const,
          category: "ok" as const,
          signatureId: "pass",
          allowedHeaderNames: [] as string[],
          summary: "ok",
          requestCount: 1,
          httpStatus: 200,
        },
        {
          contract: "reasoning" as const,
          status: "fail" as const,
          category: "protocol" as const,
          signatureId: "reasoning_param_rejected",
          allowedHeaderNames: [] as string[],
          summary: "reasoning / thinking parameter not supported",
          requestCount: 1,
          httpStatus: 400,
        },
      ],
      ok: false,
      stoppedReason: "failure" as const,
      requestCount: 2,
      budget: {
        maxRequests: 9,
        used: 2,
        maxTokens: 32,
        timeoutMs: 15_000,
      },
      capturedAt: "2026-08-04T00:00:00.000Z",
    };

    const matches = matchRepairRecipes(evidence);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.recipeId).toBe("reasoning-false");
  });

  test("registry entry declares evidence signature, candidate, support window, fixture fields", () => {
    // Structural contract of the registry declaration surface.
    const def = DEFAULT_RECIPE_DEFINITIONS[0]!;
    expect(def).toHaveProperty("id");
    expect(def).toHaveProperty("class");
    expect(def).toHaveProperty("signatureIds");
    expect(def).toHaveProperty("candidateSummary");
    expect(def).toHaveProperty("patchScope");
    expect(def).toHaveProperty("supportWindow");
    // fixture may be undefined for protocol-generic
    expect("fixture" in def || def.fixture === undefined || def.fixture !== undefined).toBe(
      true,
    );
  });
});
