/**
 * Recipe registry + evidence gate (ticket 9 / #47).
 *
 * Every Repair Recipe declares evidence signatures, candidate change, support
 * window, and (when relay-specific) a reproduction fixture. The gate is a pure
 * function: protocol-generic rules enter without a fixture; relay-specific
 * rules without a fixture are rejected and never enter the registry.
 *
 * No LLM-generated recipes. Matching still lives in recipes.ts; only admitted
 * ids are eligible to match.
 */

/** Protocol-wide vs relay/vendor-specific evidence rules. */
export type RecipeClass = "protocol-generic" | "relay-specific";

/** Scope of the candidate config change. */
export type RecipePatchScope = "model" | "provider";

/**
 * Supported version / applicability window for a recipe.
 * At least one of min, max, or note must be non-empty for the gate to pass.
 */
export interface RecipeSupportWindow {
  /** Inclusive lower bound (semver or product version string). */
  min?: string;
  /** Inclusive upper bound when known. */
  max?: string;
  /** Free-text window when versions are not numeric (protocol-generic often uses this). */
  note?: string;
}

/**
 * Reproduction fixture required for relay-specific evidence rules.
 * Must identify a concrete case maintainers can re-run.
 */
export interface RecipeFixture {
  id: string;
  description: string;
  /** Optional path relative to repo root. */
  path?: string;
}

/**
 * Declarative registry entry for one Repair Recipe.
 * Runtime matching still uses exact signature ids from durable evidence.
 */
export interface RepairRecipeDefinition {
  id: string;
  class: RecipeClass;
  /** Evidence signature IDs this recipe may match. */
  signatureIds: readonly string[];
  /** Human description of the candidate Pi-side change. */
  candidateSummary: string;
  patchScope: RecipePatchScope;
  supportWindow: RecipeSupportWindow;
  /** Required for relay-specific; optional for protocol-generic. */
  fixture?: RecipeFixture;
  /** Relay-specific recipes should record that rollback is covered by tests. */
  rollbackTested?: boolean;
}

/** Pure gate outcome — no I/O, no mutation. */
export type RecipeGateDecision =
  | { admitted: true; reasons: string[] }
  | { admitted: false; reasons: string[] };

export interface RecipeAdmitResult {
  admitted: RepairRecipeDefinition[];
  rejected: Array<{
    definition: RepairRecipeDefinition;
    decision: RecipeGateDecision;
  }>;
}

export interface RecipeRegistry {
  list(): readonly RepairRecipeDefinition[];
  get(id: string): RepairRecipeDefinition | undefined;
  isAdmitted(id: string): boolean;
  /**
   * Gate + insert admitted definitions. Rejected entries never enter.
   * Returns the gate outcome for the batch.
   */
  register(definitions: readonly RepairRecipeDefinition[]): RecipeAdmitResult;
}

function nonEmpty(s: string | undefined): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

function hasSupportWindow(window: RecipeSupportWindow | undefined): boolean {
  if (!window) return false;
  return nonEmpty(window.min) || nonEmpty(window.max) || nonEmpty(window.note);
}

function hasFixture(fixture: RecipeFixture | undefined): boolean {
  return Boolean(fixture && nonEmpty(fixture.id) && nonEmpty(fixture.description));
}

/**
 * Pure evidence gate: decide whether a recipe definition may enter the registry.
 *
 * Rules:
 * - Every recipe needs id, ≥1 signatureId, candidateSummary, support window.
 * - protocol-generic: fixture not required (may still be present).
 * - relay-specific: fixture (id + description) required; missing → reject.
 */
export function evaluateRecipeGate(
  def: RepairRecipeDefinition,
): RecipeGateDecision {
  const fail: string[] = [];
  const ok: string[] = [];

  if (!nonEmpty(def.id)) {
    fail.push("recipe id is required");
  }
  if (!def.signatureIds || def.signatureIds.length === 0) {
    fail.push("at least one evidence signatureId is required");
  }
  if (!nonEmpty(def.candidateSummary)) {
    fail.push("candidateSummary is required");
  }
  if (!hasSupportWindow(def.supportWindow)) {
    fail.push("support window is required (min, max, or note)");
  }

  if (def.class === "protocol-generic") {
    ok.push("protocol-generic: no fixture required");
  } else if (def.class === "relay-specific") {
    if (!hasFixture(def.fixture)) {
      fail.push(
        "relay-specific rule requires a reproduction fixture (id + description)",
      );
    } else {
      ok.push("relay-specific fixture present");
    }
  } else {
    fail.push(`unknown recipe class: ${String((def as { class?: unknown }).class)}`);
  }

  if (fail.length > 0) {
    return { admitted: false, reasons: [...fail, ...ok] };
  }
  return { admitted: true, reasons: ok };
}

/**
 * Pure batch gate over definitions (does not mutate any registry).
 */
export function admitRecipes(
  definitions: readonly RepairRecipeDefinition[],
): RecipeAdmitResult {
  const admitted: RepairRecipeDefinition[] = [];
  const rejected: RecipeAdmitResult["rejected"] = [];

  for (const definition of definitions) {
    const decision = evaluateRecipeGate(definition);
    if (decision.admitted) {
      admitted.push(definition);
    } else {
      rejected.push({ definition, decision });
    }
  }

  return { admitted, rejected };
}

/** Built-in Recipe 1 — protocol-generic (ticket 4). */
export const REASONING_FALSE_RECIPE_DEFINITION: RepairRecipeDefinition = {
  id: "reasoning-false",
  class: "protocol-generic",
  signatureIds: ["reasoning_param_rejected"],
  candidateSummary:
    "Set exact-model modelMeta.reasoning=false when upstream rejects reasoning/thinking parameter",
  patchScope: "model",
  supportWindow: {
    note: "protocol-generic; applies when any Claude-compatible endpoint rejects reasoning/thinking",
  },
};

/**
 * Built-in Recipe 2 — relay-specific client fingerprint (ticket 5 / #48).
 * Only unique signatures (exactly one of Claude Code / Codex / Gemini) match;
 * non-unique evidence stays unknown and is never admitted by matching.
 */
export const CLIENT_FINGERPRINT_RECIPE_DEFINITION: RepairRecipeDefinition = {
  id: "client-fingerprint",
  class: "relay-specific",
  signatureIds: [
    "client_gate_claude_code",
    "client_gate_codex",
    "client_gate_gemini",
  ],
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
};

/** Default first-party definitions (pre-gate). */
export const DEFAULT_RECIPE_DEFINITIONS: readonly RepairRecipeDefinition[] = [
  REASONING_FALSE_RECIPE_DEFINITION,
  CLIENT_FINGERPRINT_RECIPE_DEFINITION,
];

/**
 * Create an isolated registry. Only gate-admitted definitions are stored.
 */
export function createRecipeRegistry(
  definitions: readonly RepairRecipeDefinition[] = DEFAULT_RECIPE_DEFINITIONS,
): RecipeRegistry {
  const map = new Map<string, RepairRecipeDefinition>();

  const seed = admitRecipes(definitions);
  for (const def of seed.admitted) {
    map.set(def.id, def);
  }

  return {
    list() {
      return [...map.values()];
    },
    get(id: string) {
      return map.get(id);
    },
    isAdmitted(id: string) {
      return map.has(id);
    },
    register(defs: readonly RepairRecipeDefinition[]) {
      const result = admitRecipes(defs);
      for (const def of result.admitted) {
        map.set(def.id, def);
      }
      return result;
    },
  };
}

/** Process-wide registry used by matchRepairRecipes. */
let activeRegistry: RecipeRegistry = createRecipeRegistry();

export function listAdmittedRecipes(): readonly RepairRecipeDefinition[] {
  return activeRegistry.list();
}

export function getAdmittedRecipe(
  id: string,
): RepairRecipeDefinition | undefined {
  return activeRegistry.get(id);
}

export function isRecipeAdmitted(id: string): boolean {
  return activeRegistry.isAdmitted(id);
}

/**
 * Gate + register into the process-wide registry.
 * Rejected definitions are not stored.
 */
export function registerRecipeDefinitions(
  definitions: readonly RepairRecipeDefinition[],
): RecipeAdmitResult {
  return activeRegistry.register(definitions);
}

/**
 * Replace the process-wide registry (tests / re-seed).
 * Defaults to built-in definitions passed through the gate.
 */
export function resetRecipeRegistry(
  definitions: readonly RepairRecipeDefinition[] = DEFAULT_RECIPE_DEFINITIONS,
): void {
  activeRegistry = createRecipeRegistry(definitions);
}
