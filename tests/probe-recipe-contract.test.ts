/**
 * Static first-party Repair Recipe and adapter contracts (#89).
 */
import { describe, expect, test } from "bun:test";
import { ProviderConfigViews } from "../src/provider-config-views.ts";
import { resolveProviderOverride } from "../src/provider-override.ts";
import {
  FIRST_PARTY_REPAIR_RECIPES,
  applyRepairCandidateToConfigDocument,
  applyRepairCandidateToProbeTarget,
  matchRepairRecipes,
  type NormalizedEvidenceCategory,
  type NormalizedProbeRunEvidence,
  type ProbeContractId,
  type ProbeTarget,
  type RepairCandidate,
  type RepairRecipeId,
} from "../src/probe/index.ts";
import type { CcProvider, PiSwitchConfig } from "../src/types.ts";

const MODEL_ID = "probe-model";

const provider: CcProvider = {
  id: "p1",
  piName: "ps-p1",
  displayName: "Provider One",
  appType: "codex",
  api: "anthropic-messages",
  baseUrl: "https://relay.example/v1",
  apiKey: "test-key",
  authHeader: true,
  configModels: [MODEL_ID],
  meta: {},
  isCurrentInCc: true,
};

interface RecipeContractCase {
  recipeId: RepairRecipeId;
  contract: ProbeContractId;
  category: NormalizedEvidenceCategory;
  signatureId: string;
  target: ProbeTarget;
  recipeClass: "protocol-generic" | "relay-specific";
  patchScope: "model" | "provider";
  fixtureId?: string;
}

const RECIPE_CASES: RecipeContractCase[] = [
  {
    recipeId: "reasoning-false",
    contract: "reasoning",
    category: "protocol",
    signatureId: "reasoning_param_rejected",
    recipeClass: "protocol-generic",
    patchScope: "model",
    target: {
      provider: provider.piName,
      modelId: MODEL_ID,
      reasoning: true,
    },
  },
  {
    recipeId: "client-fingerprint",
    contract: "basic",
    category: "client-gate",
    signatureId: "client_gate_claude_code",
    recipeClass: "relay-specific",
    patchScope: "provider",
    fixtureId: "client-gate-unique-signature",
    target: { provider: provider.piName, modelId: MODEL_ID },
  },
  {
    recipeId: "gemini-tool-compat",
    contract: "tool",
    category: "tool",
    signatureId: "gemini_tool_empty_args",
    recipeClass: "relay-specific",
    patchScope: "provider",
    fixtureId: "gemini-tool-empty-args",
    target: { provider: provider.piName, modelId: MODEL_ID },
  },
];

function evidenceFor(input: RecipeContractCase): NormalizedProbeRunEvidence {
  return {
    target: { ...input.target },
    stages: [
      {
        contract: input.contract,
        status: "fail",
        category: input.category,
        signatureId: input.signatureId,
        allowedHeaderNames: [],
        summary: input.signatureId,
        requestCount: 1,
        httpStatus: 400,
      },
    ],
    ok: false,
    stoppedReason: "failure",
    requestCount: 1,
    budget: {
      maxRequests: 9,
      used: 1,
      maxTokens: 32,
      timeoutMs: 15_000,
    },
    capturedAt: "2026-08-14T00:00:00.000Z",
  };
}

function effectiveFromTarget(target: ProbeTarget) {
  return {
    reasoning: target.reasoning,
    fingerprint: target.fingerprint,
    claudeCodeCompat: target.claudeCodeCompat,
    geminiToolCompat: target.geminiToolCompat,
  };
}

function providerForRecipe(recipeId: RepairRecipeId): CcProvider {
  return recipeId === "gemini-tool-compat"
    ? {
        ...provider,
        appType: "gemini",
        api: "google-generative-ai",
        baseUrl: "https://relay.example/v1",
      }
    : provider;
}

function effectiveFromConfig(
  document: Record<string, unknown>,
  targetProvider: CcProvider,
) {
  const config = document as unknown as PiSwitchConfig;
  const views = new ProviderConfigViews(() => config);
  const override = resolveProviderOverride(config.providerOverrides, targetProvider);
  const compatibility = views.effectiveCompatibilityFor(targetProvider);

  return {
    reasoning: views.modelMetaFor(targetProvider, MODEL_ID)?.reasoning,
    fingerprint: override?.fingerprint,
    claudeCodeCompat: compatibility.claudeCodeCompat,
    geminiToolCompat: compatibility.geminiToolCompat,
  };
}

describe("static first-party Repair Recipes", () => {
  test("the fixed ordered allowlist owns complete admission metadata", () => {
    expect(FIRST_PARTY_REPAIR_RECIPES.map((recipe) => recipe.id)).toEqual([
      "reasoning-false",
      "client-fingerprint",
      "gemini-tool-compat",
    ]);
    expect(Object.isFrozen(FIRST_PARTY_REPAIR_RECIPES)).toBe(true);

    for (const recipe of FIRST_PARTY_REPAIR_RECIPES) {
      expect(Object.isFrozen(recipe)).toBe(true);
      expect(Object.isFrozen(recipe.signatureIds)).toBe(true);
      expect(recipe.signatureIds.length).toBeGreaterThan(0);
      expect(recipe.candidateSummary.trim().length).toBeGreaterThan(0);
      expect(
        recipe.supportWindow.min ??
          recipe.supportWindow.max ??
          recipe.supportWindow.note,
      ).toBeTruthy();

      if (recipe.class === "relay-specific") {
        expect(recipe.fixture.id.trim().length).toBeGreaterThan(0);
        expect(recipe.fixture.description.trim().length).toBeGreaterThan(0);
        expect(recipe.rollbackTested).toBe(true);
      }
    }
  });

  test.each(RECIPE_CASES)(
    "$recipeId owns matching, candidate, and verification contracts",
    (input) => {
      const recipe = FIRST_PARTY_REPAIR_RECIPES.find(
        (candidate) => candidate.id === input.recipeId,
      );
      expect(recipe).toMatchObject({
        id: input.recipeId,
        class: input.recipeClass,
        patchScope: input.patchScope,
      });
      expect(recipe?.signatureIds).toContain(input.signatureId);
      if (input.fixtureId) {
        expect(recipe?.fixture?.id).toBe(input.fixtureId);
      }

      const matches = matchRepairRecipes(evidenceFor(input));

      expect(matches).toHaveLength(1);
      const match = matches[0]!;
      expect(match.recipeId).toBe(input.recipeId);
      expect(match.signatureId).toBe(input.signatureId);
      expect(match.sourceContract).toBe(input.contract);
      expect(match.verifyContracts.length).toBeGreaterThan(0);
      expect(match.patch.provider).toBe(provider.piName);
    },
  );
});

describe("Repair candidate adapters", () => {
  test.each(RECIPE_CASES)(
    "$recipeId produces equivalent effective compatibility in both adapters",
    (input) => {
      const match = matchRepairRecipes(evidenceFor(input))[0]!;
      const target = applyRepairCandidateToProbeTarget(
        input.target,
        match.patch,
      );
      const targetProvider = providerForRecipe(input.recipeId);
      const document = applyRepairCandidateToConfigDocument(
        {},
        targetProvider,
        match.patch,
      );

      expect(effectiveFromConfig(document, targetProvider)).toEqual(
        effectiveFromTarget(target),
      );
    },
  );

  test("both adapters fail explicitly for an unknown candidate kind", () => {
    const unknown = {
      kind: "unknown",
      scope: "provider",
      provider: provider.piName,
    } as unknown as RepairCandidate;

    expect(() =>
      applyRepairCandidateToProbeTarget(
        { provider: provider.piName, modelId: MODEL_ID },
        unknown,
      ),
    ).toThrow("unknown Repair candidate kind: unknown");
    expect(() =>
      applyRepairCandidateToConfigDocument({}, provider, unknown),
    ).toThrow("unknown Repair candidate kind: unknown");
  });
});
