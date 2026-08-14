/**
 * Static first-party Repair Recipes.
 *
 * Each recipe owns its admission metadata, normalized-evidence matcher,
 * declarative candidate, and verification contract. The ordered collection is
 * fixed at build time: unknown or ambiguous evidence never gains a runtime
 * registration path.
 */

import type { JsonObject } from "../json-file.ts";
import {
  updateOverrideEntry,
  type MutableOverrideEntry,
} from "../settings.ts";
import type { CcProvider } from "../types.ts";
import type {
  NormalizedProbeRunEvidence,
  NormalizedStageEvidence,
} from "./evidence.ts";
import {
  type ClientGateFingerprint,
  clientGateSignatureId,
} from "./evidence.ts";
import type { ProbeContractId, ProbeTarget } from "./types.ts";

export type RepairRecipeId =
  | "reasoning-false"
  | "client-fingerprint"
  | "gemini-tool-compat";

export type RecipeClass = "protocol-generic" | "relay-specific";
export type RecipePatchScope = "model" | "provider";

export interface RecipeSupportWindow {
  min?: string;
  max?: string;
  note?: string;
}

export interface RecipeFixture {
  id: string;
  description: string;
  path?: string;
}

export interface RepairCandidateModelMeta {
  kind: "modelMeta";
  scope: "model";
  provider: string;
  modelId: string;
  modelMeta: { reasoning: false };
}

export interface RepairCandidateProviderFingerprint {
  kind: "fingerprint";
  scope: "provider";
  provider: string;
  fingerprint: ClientGateFingerprint;
  claudeCodeCompat?: true;
}

export interface RepairCandidateProviderGeminiToolCompat {
  kind: "geminiToolCompat";
  scope: "provider";
  provider: string;
  geminiToolCompat: true;
}

/** Closed, declarative candidate interpreted by both Repair adapters. */
export type RepairCandidate =
  | RepairCandidateModelMeta
  | RepairCandidateProviderFingerprint
  | RepairCandidateProviderGeminiToolCompat;

export interface RepairRecipeMatch {
  recipeId: RepairRecipeId;
  signatureId: string;
  sourceContract: ProbeContractId;
  verifyContracts: ProbeContractId[];
  /** Kept as `patch` in the observable Repair plan/case shape. */
  patch: RepairCandidate;
  summary: string;
}

interface RecipeMatchInput {
  stage: NormalizedStageEvidence;
  target: ProbeTarget;
  evidence: NormalizedProbeRunEvidence;
}

interface FirstPartyRepairRecipeBase {
  readonly id: RepairRecipeId;
  readonly class: RecipeClass;
  readonly signatureIds: readonly string[];
  readonly candidateSummary: string;
  readonly patchScope: RecipePatchScope;
  readonly supportWindow: Readonly<RecipeSupportWindow>;
  readonly match: (input: RecipeMatchInput) => RepairRecipeMatch | undefined;
}

export interface ProtocolGenericRepairRecipe
  extends FirstPartyRepairRecipeBase {
  readonly class: "protocol-generic";
  readonly fixture?: Readonly<RecipeFixture>;
  readonly rollbackTested?: boolean;
}

export interface RelaySpecificRepairRecipe
  extends FirstPartyRepairRecipeBase {
  readonly class: "relay-specific";
  readonly fixture: Readonly<RecipeFixture>;
  readonly rollbackTested: true;
}

export type FirstPartyRepairRecipe =
  | ProtocolGenericRepairRecipe
  | RelaySpecificRepairRecipe;

function isNonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasSupportWindow(window: RecipeSupportWindow): boolean {
  return (
    isNonEmpty(window.min) ||
    isNonEmpty(window.max) ||
    isNonEmpty(window.note)
  );
}

function assertRecipeAdmission(recipe: FirstPartyRepairRecipe): void {
  const invalid = (reason: string): never => {
    throw new Error(`invalid first-party Repair Recipe ${recipe.id}: ${reason}`);
  };

  if (!isNonEmpty(recipe.id)) invalid("recipe id is required");
  if (recipe.signatureIds.length === 0) {
    invalid("at least one evidence signatureId is required");
  }
  if (!isNonEmpty(recipe.candidateSummary)) {
    invalid("candidateSummary is required");
  }
  if (!hasSupportWindow(recipe.supportWindow)) {
    invalid("support window is required (min, max, or note)");
  }
  if (recipe.class === "relay-specific") {
    if (
      !isNonEmpty(recipe.fixture.id) ||
      !isNonEmpty(recipe.fixture.description)
    ) {
      invalid("relay-specific recipe requires a reproduction fixture");
    }
    if (recipe.rollbackTested !== true) {
      invalid("relay-specific recipe requires rollback test coverage");
    }
  }
}

function defineFirstPartyRecipe<T extends FirstPartyRepairRecipe>(recipe: T): T {
  assertRecipeAdmission(recipe);
  Object.freeze(recipe.signatureIds);
  Object.freeze(recipe.supportWindow);
  if (recipe.fixture) Object.freeze(recipe.fixture);
  return Object.freeze(recipe);
}

function verificationContractsForReasoning(
  evidence: NormalizedProbeRunEvidence,
): ProbeContractId[] {
  const hasToolStage = evidence.stages.some(
    (stage) => stage.contract === "tool",
  );
  return hasToolStage ? ["basic", "tool"] : ["basic"];
}

function verificationContractsForFingerprint(
  evidence: NormalizedProbeRunEvidence,
): ProbeContractId[] {
  const contracts: ProbeContractId[] = [];
  for (const stage of evidence.stages) {
    if (stage.status === "skip") continue;
    if (!contracts.includes(stage.contract)) contracts.push(stage.contract);
  }
  if (!contracts.includes("basic")) contracts.unshift("basic");
  return contracts;
}

function verificationContractsForGeminiTool(
  evidence: NormalizedProbeRunEvidence,
): ProbeContractId[] {
  const contracts: ProbeContractId[] = ["basic", "tool"];
  const ranReasoning = evidence.stages.some(
    (stage) =>
      stage.contract === "reasoning" &&
      (stage.status === "pass" || stage.status === "fail"),
  );
  if (ranReasoning) contracts.push("reasoning");
  return contracts;
}

const REASONING_FALSE_SIGNATURE = "reasoning_param_rejected";

const REASONING_FALSE_RECIPE = defineFirstPartyRecipe({
  id: "reasoning-false",
  class: "protocol-generic",
  signatureIds: [REASONING_FALSE_SIGNATURE],
  candidateSummary:
    "Set exact-model modelMeta.reasoning=false when upstream rejects reasoning/thinking parameter",
  patchScope: "model",
  supportWindow: {
    note: "protocol-generic; applies when any Claude-compatible endpoint rejects reasoning/thinking",
  },
  match: ({ stage, target, evidence }) => {
    if (stage.status !== "fail") return undefined;
    if (stage.signatureId !== REASONING_FALSE_SIGNATURE) return undefined;
    if (stage.unrepairable) return undefined;

    return {
      recipeId: "reasoning-false",
      signatureId: REASONING_FALSE_SIGNATURE,
      sourceContract: stage.contract,
      verifyContracts: verificationContractsForReasoning(evidence),
      patch: {
        kind: "modelMeta",
        scope: "model",
        provider: target.provider,
        modelId: target.modelId,
        modelMeta: { reasoning: false },
      },
      summary:
        `Set modelOverrides["${target.modelId}"].reasoning=false ` +
        `(exact model; upstream rejected reasoning/thinking parameter)`,
    };
  },
});

const CLIENT_GATE_CANDIDATES = [
  {
    signatureId: clientGateSignatureId("claude-code"),
    fingerprint: "claude-code",
  },
  {
    signatureId: clientGateSignatureId("codex"),
    fingerprint: "codex",
  },
  {
    signatureId: clientGateSignatureId("gemini"),
    fingerprint: "gemini",
  },
] as const satisfies readonly {
  signatureId: string;
  fingerprint: ClientGateFingerprint;
}[];

const CLIENT_FINGERPRINT_RECIPE = defineFirstPartyRecipe({
  id: "client-fingerprint",
  class: "relay-specific",
  signatureIds: CLIENT_GATE_CANDIDATES.map((item) => item.signatureId),
  candidateSummary:
    "Set provider-level fingerprint preset (and claudeCodeCompat for Claude Code) when client-gate signature uniquely maps to Claude Code / Codex / Gemini",
  patchScope: "provider",
  supportWindow: {
    min: "0.3.0",
    note: "fingerprint presets validated against defaults/fingerprint-snapshot.json baselines",
  },
  fixture: {
    id: "client-gate-unique-signature",
    description:
      "Distinctive client-gate rejection body uniquely maps to Claude Code, Codex, or Gemini fingerprint",
    path: "tests/fixtures/probe/client-gate-claude-code.json",
  },
  rollbackTested: true,
  match: ({ stage, target, evidence }) => {
    if (stage.status !== "fail") return undefined;
    if (stage.unrepairable) return undefined;

    const matched = CLIENT_GATE_CANDIDATES.find(
      (item) => item.signatureId === stage.signatureId,
    );
    if (!matched) return undefined;

    const patch: RepairCandidateProviderFingerprint = {
      kind: "fingerprint",
      scope: "provider",
      provider: target.provider,
      fingerprint: matched.fingerprint,
      ...(matched.fingerprint === "claude-code"
        ? { claudeCodeCompat: true }
        : {}),
    };

    return {
      recipeId: "client-fingerprint",
      signatureId: matched.signatureId,
      sourceContract: stage.contract,
      verifyContracts: verificationContractsForFingerprint(evidence),
      patch,
      summary:
        matched.fingerprint === "claude-code"
          ? `Set providerOverrides["${target.provider}"].fingerprint="claude-code" ` +
            `and claudeCodeCompat=true (unique client-gate signature)`
          : `Set providerOverrides["${target.provider}"].fingerprint="${matched.fingerprint}" ` +
            `(unique client-gate signature; provider scope only)`,
    };
  },
});

const GEMINI_TOOL_EMPTY_ARGS_SIGNATURE = "gemini_tool_empty_args";

const GEMINI_TOOL_COMPAT_RECIPE = defineFirstPartyRecipe({
  id: "gemini-tool-compat",
  class: "relay-specific",
  signatureIds: [GEMINI_TOOL_EMPTY_ARGS_SIGNATURE],
  candidateSummary:
    "Set providerOverrides[provider].geminiToolCompat=true when tool probe shows empty-args/schema evidence",
  patchScope: "provider",
  supportWindow: {
    min: "0.3.0",
    note: "geminiToolCompat pure transforms in src/compat/gemini-tool-compat.ts; proxy empty-args repro",
  },
  fixture: {
    id: "gemini-tool-empty-args",
    description:
      "Tool contract returns probe_echo with empty arguments when Gemini proxy does not enforce schema without toolConfig",
    path: "tests/fixtures/probe/gemini-tool-empty-args.json",
  },
  rollbackTested: true,
  match: ({ stage, target, evidence }) => {
    if (stage.status !== "fail") return undefined;
    if (stage.unrepairable) return undefined;
    if (stage.signatureId !== GEMINI_TOOL_EMPTY_ARGS_SIGNATURE) {
      return undefined;
    }
    if (target.geminiToolCompat === true) return undefined;

    return {
      recipeId: "gemini-tool-compat",
      signatureId: GEMINI_TOOL_EMPTY_ARGS_SIGNATURE,
      sourceContract: stage.contract,
      verifyContracts: verificationContractsForGeminiTool(evidence),
      patch: {
        kind: "geminiToolCompat",
        scope: "provider",
        provider: target.provider,
        geminiToolCompat: true,
      },
      summary:
        `Set providerOverrides["${target.provider}"].geminiToolCompat=true ` +
        `(provider scope only; empty-args/schema tool evidence)`,
    };
  },
});

function defineRecipeSet(
  recipes: readonly FirstPartyRepairRecipe[],
): readonly FirstPartyRepairRecipe[] {
  const ids = new Set<RepairRecipeId>();
  for (const recipe of recipes) {
    if (ids.has(recipe.id)) {
      throw new Error(`duplicate first-party Repair Recipe id: ${recipe.id}`);
    }
    ids.add(recipe.id);
  }
  return Object.freeze([...recipes]);
}

/** Fixed recipe order used for every Compatibility Repair run. */
export const FIRST_PARTY_REPAIR_RECIPES = defineRecipeSet([
  REASONING_FALSE_RECIPE,
  CLIENT_FINGERPRINT_RECIPE,
  GEMINI_TOOL_COMPAT_RECIPE,
]);

/**
 * Match static first-party recipes against durable normalized evidence.
 * Stage order wins first, recipe order second; each recipe can match at most
 * once per run. The Repair pipeline still attempts and commits at most one.
 */
export function matchRepairRecipes(
  evidence: NormalizedProbeRunEvidence,
): RepairRecipeMatch[] {
  const matches: RepairRecipeMatch[] = [];
  const seen = new Set<RepairRecipeId>();

  for (const stage of evidence.stages) {
    for (const recipe of FIRST_PARTY_REPAIR_RECIPES) {
      if (seen.has(recipe.id)) continue;
      const match = recipe.match({ stage, target: evidence.target, evidence });
      if (!match) continue;
      matches.push(match);
      seen.add(recipe.id);
    }
  }

  return matches;
}

function failUnknownCandidate(candidate: never): never {
  const kind = (candidate as { kind?: unknown }).kind;
  throw new Error(`unknown Repair candidate kind: ${String(kind)}`);
}

/** Probe Target adapter used by candidate verification. */
export function applyRepairCandidateToProbeTarget(
  target: ProbeTarget,
  candidate: RepairCandidate,
): ProbeTarget {
  switch (candidate.kind) {
    case "modelMeta":
      return {
        ...target,
        reasoning: candidate.modelMeta.reasoning,
      };
    case "fingerprint":
      return {
        ...target,
        fingerprint: candidate.fingerprint,
        ...(candidate.claudeCodeCompat
          ? { claudeCodeCompat: candidate.claudeCodeCompat }
          : {}),
      };
    case "geminiToolCompat":
      return {
        ...target,
        geminiToolCompat: candidate.geminiToolCompat,
      };
    default:
      return failUnknownCandidate(candidate);
  }
}

function applyCandidateToOverrideEntry(
  entry: MutableOverrideEntry,
  providerDisplayName: string,
  candidate: RepairCandidate,
): MutableOverrideEntry {
  switch (candidate.kind) {
    case "modelMeta":
      return {
        ...entry,
        modelOverrides: {
          ...(entry.modelOverrides ?? {}),
          [candidate.modelId]: { ...candidate.modelMeta },
        },
        label: entry.label ?? providerDisplayName,
      };
    case "fingerprint":
      return {
        ...entry,
        fingerprint: candidate.fingerprint,
        ...(candidate.claudeCodeCompat
          ? { claudeCodeCompat: candidate.claudeCodeCompat }
          : {}),
      };
    case "geminiToolCompat":
      return {
        ...entry,
        geminiToolCompat: candidate.geminiToolCompat,
      };
    default:
      return failUnknownCandidate(candidate);
  }
}

/**
 * Config document adapter. The strict-CAS envelope, provider lookup, and file
 * I/O remain with the production RepairConfigStore.
 */
export function applyRepairCandidateToConfigDocument(
  document: JsonObject,
  provider: Pick<CcProvider, "id" | "displayName"> & { appType?: string },
  candidate: RepairCandidate,
): JsonObject {
  return updateOverrideEntry(document, provider, (entry) =>
    applyCandidateToOverrideEntry(entry, provider.displayName, candidate),
  );
}
