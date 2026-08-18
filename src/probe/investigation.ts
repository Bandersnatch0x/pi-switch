/**
 * Pure Compatibility Probe/Repair investigation state machine.
 *
 * The machine starts with a parsed ProbeTarget. It contains only durable domain
 * values and never a Session Model, transport, UI, clock, config store, or
 * Repair Case adapter. Consumers interpret its declarative effects.
 */
import type { NormalizedProbeRunEvidence } from "./evidence.ts";
import { buildRepairPlan, type RepairPlan } from "./repair-plan.ts";
import {
  applyRepairCandidateToProbeTarget,
  type RepairCandidate,
  type RepairRecipeMatch,
} from "./recipes.ts";
import {
  probeMaxTokensFor,
  type ProbeRunResult,
  type ProbeTarget,
  type ProbeContractId,
} from "./types.ts";

const VERIFICATION_PASSES_REQUIRED = 2 as const;
type VerificationSequence = 1 | typeof VERIFICATION_PASSES_REQUIRED;

export type InvestigationIntent =
  | { kind: "probe-only" }
  | { kind: "repair"; offerSwitch?: boolean; recipeIndex?: number };

export interface InvestigationOptions {
  maxRequests?: number;
  timeoutMs?: number;
  /** Deliberately keyed to the original target, not the candidate. */
  maxTokens?: number;
}

export type InvestigationEffect =
  | { kind: "probe"; target: ProbeTarget }
  | { kind: "confirm-repair"; plan: RepairPlan }
  | { kind: "read-config-snapshot" }
  | {
      kind: "verify-candidate";
      sequence: VerificationSequence;
      target: ProbeTarget;
      contracts: ProbeContractId[];
      maxRequests?: number;
      timeoutMs?: number;
      maxTokens: number;
    }
  | {
      kind: "commit-repair";
      expectedVersion: string;
      patch: RepairCandidate;
    }
  /** The command/UI adapter owns the optional post-commit switch decision. */
  | { kind: "offer-switch"; target: ProbeTarget };

export type InvestigationTerminalStatus =
  | "probe-complete"
  | "no-recipe"
  | "confirmation-declined"
  | "verification-failed"
  | "cas-conflict"
  | "commit-error"
  | "committed";

interface CommonState {
  target: ProbeTarget;
  intent: InvestigationIntent;
  options: InvestigationOptions;
}

type RepairIntent = Extract<InvestigationIntent, { kind: "repair" }>;

interface InvestigatedRepairState extends CommonState {
  intent: RepairIntent;
  result?: ProbeRunResult;
  evidence: NormalizedProbeRunEvidence;
  plan: RepairPlan;
}

interface CandidateRepairState extends InvestigatedRepairState {
  recipe: RepairRecipeMatch;
  candidateTarget: ProbeTarget;
}

interface AttemptedRepairState extends CandidateRepairState {
  attempts: ProbeRunResult[];
}

type AwaitingConfirmationState = InvestigatedRepairState & {
  status: "awaiting-confirmation";
};

type AwaitingSnapshotState = CandidateRepairState & {
  status: "awaiting-snapshot";
};

type AwaitingVerificationState = AttemptedRepairState & {
  status: "awaiting-verification";
  expectedVersion: string;
  sequence: VerificationSequence;
};

type AwaitingCommitState = AttemptedRepairState & {
  status: "awaiting-commit";
  expectedVersion: string;
};

type ProbeCompleteState = CommonState & {
  status: "probe-complete";
  result: ProbeRunResult;
  evidence: NormalizedProbeRunEvidence;
};

type NoRecipeState = InvestigatedRepairState & {
  status: "no-recipe";
};

type ConfirmationDeclinedState = InvestigatedRepairState & {
  status: "confirmation-declined";
  message: string;
};

type VerificationFailedState = AttemptedRepairState & {
  status: "verification-failed";
  message: string;
};

type CasConflictState = AttemptedRepairState & {
  status: "cas-conflict";
  message?: string;
};

type CommitErrorState = AttemptedRepairState & {
  status: "commit-error";
  message?: string;
};

type CommittedState = AttemptedRepairState & {
  status: "committed";
  commitVersion: string;
};

type RepairTerminalState =
  | VerificationFailedState
  | CasConflictState
  | CommitErrorState
  | CommittedState;

type AwaitingProbeState = Extract<InvestigationState, { status: "awaiting-probe" }>;

export type InvestigationState =
  | (CommonState & { status: "awaiting-probe" })
  | AwaitingConfirmationState
  | AwaitingSnapshotState
  | AwaitingVerificationState
  | AwaitingCommitState
  | ProbeCompleteState
  | NoRecipeState
  | ConfirmationDeclinedState
  | RepairTerminalState;

export type InvestigationInput =
  | { kind: "probe-completed"; result: ProbeRunResult; evidence: NormalizedProbeRunEvidence }
  | { kind: "confirm"; accepted: boolean }
  | { kind: "config-snapshot"; version: string }
  | { kind: "config-snapshot-error"; message: string }
  | { kind: "verification-completed"; sequence: VerificationSequence; result: ProbeRunResult }
  | { kind: "commit-completed"; result: { ok: true; version: string } | { ok: false; reason: "conflict" | "error"; message?: string } };

export interface InvestigationTransition {
  state: InvestigationState;
  effects: InvestigationEffect[];
}

export class InvalidInvestigationTransitionError extends Error {
  readonly code = "invalid-investigation-transition";
  constructor(
    state: InvestigationState["status"],
    input: InvestigationInput["kind"],
    reason?: string,
  ) {
    super(
      `cannot apply ${input} while investigation is ${state}` +
        (reason ? `: ${reason}` : ""),
    );
    this.name = "InvalidInvestigationTransitionError";
  }
}

function copyTarget(target: ProbeTarget): ProbeTarget {
  return { ...target };
}

function assertTarget(
  expected: ProbeTarget,
  actual: ProbeTarget,
  state: InvestigationState["status"],
  input: InvestigationInput["kind"],
): void {
  const fields: Array<keyof ProbeTarget> = [
    "provider",
    "modelId",
    "reasoning",
    "fingerprint",
    "claudeCodeCompat",
    "geminiToolCompat",
  ];
  if (fields.some((field) => expected[field] !== actual[field])) {
    throw new InvalidInvestigationTransitionError(
      state,
      input,
      "probe result target does not match investigation target",
    );
  }
}

function copyIntent(intent: InvestigationIntent): InvestigationIntent {
  return { ...intent };
}

function copyEvidence(evidence: NormalizedProbeRunEvidence): NormalizedProbeRunEvidence {
  return {
    ...evidence,
    target: copyTarget(evidence.target),
    stages: evidence.stages.map((stage) => ({
      ...stage,
      allowedHeaderNames: [...stage.allowedHeaderNames],
    })),
    budget: { ...evidence.budget },
  };
}

function copyProbeResult(result: ProbeRunResult): ProbeRunResult {
  return {
    ...result,
    target: copyTarget(result.target),
    stages: result.stages.map((stage) => ({ ...stage })),
    budget: { ...result.budget },
    ...(result.precheck
      ? {
          precheck: {
            ...result.precheck,
            checks: result.precheck.checks.map((check) => ({ ...check })),
          },
        }
      : {}),
  };
}

function copyRecipe(recipe: RepairRecipeMatch): RepairRecipeMatch {
  return {
    ...recipe,
    verifyContracts: [...recipe.verifyContracts],
    patch: copyCandidate(recipe.patch),
  };
}

function copyCandidate(candidate: RepairCandidate): RepairCandidate {
  return candidate.kind === "modelMeta"
    ? { ...candidate, modelMeta: { ...candidate.modelMeta } }
    : { ...candidate };
}

function copyPlan(plan: RepairPlan): RepairPlan {
  return {
    ...plan,
    target: copyTarget(plan.target),
    recipes: plan.recipes.map(copyRecipe),
    evidence: copyEvidence(plan.evidence),
    preview: {
      ...plan.preview,
      recipeOrder: [...plan.preview.recipeOrder],
      patches: plan.preview.patches.map((patch) =>
        patch.scope === "exact-model"
          ? { ...patch, affectedModels: [...patch.affectedModels] }
          : { ...patch },
      ),
    },
  };
}

/** Start a probe; the caller interprets the returned probe effect. */
export function createInvestigation(
  target: ProbeTarget,
  intent: InvestigationIntent,
  options: InvestigationOptions = {},
): InvestigationTransition {
  return {
    state: { status: "awaiting-probe", target: copyTarget(target), intent: copyIntent(intent), options: { ...options } },
    effects: [{ kind: "probe", target: copyTarget(target) }],
  };
}

/** Start repair from an already completed probe/plan (useful to facades). */
export function createRepairInvestigation(
  plan: RepairPlan,
  options: InvestigationOptions = {},
  recipeIndex = 0,
  offerSwitch = true,
): InvestigationTransition {
  const planCopy = copyPlan(plan);
  const target = copyTarget(planCopy.target);
  const evidence = copyEvidence(planCopy.evidence);
  if (planCopy.recipes.length === 0) {
    return {
      state: { status: "no-recipe", target, intent: { kind: "repair", offerSwitch }, options: { ...options }, evidence, plan: planCopy },
      effects: [],
    };
  }
  return {
    state: { status: "awaiting-confirmation", target, intent: { kind: "repair", offerSwitch, recipeIndex }, options: { ...options }, evidence, plan: planCopy },
    effects: [{ kind: "confirm-repair", plan: copyPlan(planCopy) }],
  };
}

function finishRepair(state: RepairTerminalState): InvestigationTransition {
  // Repair Case persistence is a command-level concern. The terminal state is
  // already a complete, redacted record source; keeping a persistence effect
  // here made the plan-scoped facade invent an effect it could not consume.
  return { state, effects: [] };
}

/** Pure deterministic transition. Invalid/out-of-order inputs throw explicitly. */
export function advance(state: InvestigationState, input: InvestigationInput): InvestigationTransition {
  switch (state.status) {
    case "awaiting-probe":
      return advanceAwaitingProbe(state, input);
    case "awaiting-confirmation":
      return advanceAwaitingConfirmation(state, input);
    case "awaiting-snapshot":
      return advanceAwaitingSnapshot(state, input);
    case "awaiting-verification":
      return advanceAwaitingVerification(state, input);
    case "awaiting-commit":
      return advanceAwaitingCommit(state, input);
    default:
      throw new InvalidInvestigationTransitionError(state.status, input.kind);
  }
}

function advanceAwaitingProbe(
  state: AwaitingProbeState,
  input: InvestigationInput,
): InvestigationTransition {
  if (input.kind !== "probe-completed") {
    throw new InvalidInvestigationTransitionError(state.status, input.kind);
  }

  const result = copyProbeResult(input.result);
  const evidence = copyEvidence(input.evidence);
  assertTarget(state.target, result.target, state.status, input.kind);
  assertTarget(state.target, evidence.target, state.status, input.kind);

  const intent = state.intent;
  if (intent.kind === "probe-only") {
    return completeProbe(state, result, evidence);
  }
  return planRepair(state, intent, result, evidence);
}

function completeProbe(
  state: AwaitingProbeState,
  result: ProbeRunResult,
  evidence: NormalizedProbeRunEvidence,
): InvestigationTransition {
  const complete: ProbeCompleteState = {
    ...state,
    status: "probe-complete",
    result,
    evidence,
  };
  return { state: complete, effects: [] };
}

function planRepair(
  state: AwaitingProbeState,
  intent: RepairIntent,
  result: ProbeRunResult,
  evidence: NormalizedProbeRunEvidence,
): InvestigationTransition {
  const plan = copyPlan(buildRepairPlan(evidence));
  if (plan.recipes.length === 0) {
    const noRecipe: NoRecipeState = {
      ...state,
      status: "no-recipe",
      intent: { ...intent },
      result,
      evidence,
      plan,
    };
    return { state: noRecipe, effects: [] };
  }

  const repairIntent: RepairIntent = {
    kind: "repair",
    ...(intent.offerSwitch !== undefined ? { offerSwitch: intent.offerSwitch } : {}),
    ...(intent.recipeIndex !== undefined ? { recipeIndex: intent.recipeIndex } : {}),
  };
  const awaitingConfirmation: AwaitingConfirmationState = {
    target: state.target,
    intent: repairIntent,
    options: state.options,
    result,
    evidence,
    plan,
    status: "awaiting-confirmation",
  };
  return {
    state: awaitingConfirmation,
    effects: [{ kind: "confirm-repair", plan: copyPlan(plan) }],
  };
}

function advanceAwaitingConfirmation(
  state: AwaitingConfirmationState,
  input: InvestigationInput,
): InvestigationTransition {
  if (input.kind !== "confirm") {
    throw new InvalidInvestigationTransitionError(state.status, input.kind);
  }
  if (!input.accepted) {
    const declined: ConfirmationDeclinedState = {
      ...state,
      status: "confirmation-declined",
      message: "repair confirmation declined",
    };
    return { state: declined, effects: [] };
  }

  const plan = copyPlan(state.plan);
  const recipeIndex = state.intent.recipeIndex ?? 0;
  const selectedRecipe = plan.recipes[recipeIndex];
  if (!Number.isInteger(recipeIndex) || recipeIndex < 0 || !selectedRecipe) {
    throw new InvalidInvestigationTransitionError(
      state.status,
      input.kind,
      `repair recipe index ${recipeIndex} is out of range`,
    );
  }
  const recipe = copyRecipe(selectedRecipe);
  const candidateTarget = applyRepairCandidateToProbeTarget(state.target, recipe.patch);
  return {
    state: { ...state, plan, recipe, candidateTarget, status: "awaiting-snapshot" },
    effects: [{ kind: "read-config-snapshot" }],
  };
}

function advanceAwaitingSnapshot(
  state: AwaitingSnapshotState,
  input: InvestigationInput,
): InvestigationTransition {
  if (input.kind === "config-snapshot-error") {
    const failed: CommitErrorState = {
      ...state,
      status: "commit-error",
      attempts: [],
      message: input.message,
    };
    return finishRepair(failed);
  }
  if (input.kind !== "config-snapshot") {
    throw new InvalidInvestigationTransitionError(state.status, input.kind);
  }
  return scheduleVerification(state, input.version);
}

function scheduleVerification(
  state: AwaitingSnapshotState,
  expectedVersion: string,
): InvestigationTransition {
  const awaitingVerification: AwaitingVerificationState = {
    ...state,
    expectedVersion,
    attempts: [],
    sequence: 1,
    status: "awaiting-verification",
  };
  return {
    state: awaitingVerification,
    effects: [verificationEffect(state, state.recipe, state.candidateTarget, 1)],
  };
}

function advanceAwaitingVerification(
  state: AwaitingVerificationState,
  input: InvestigationInput,
): InvestigationTransition {
  if (input.kind !== "verification-completed" || input.sequence !== state.sequence) {
    throw new InvalidInvestigationTransitionError(state.status, input.kind);
  }

  const result = copyProbeResult(input.result);
  assertTarget(state.candidateTarget, result.target, state.status, input.kind);
  const attempts = [...state.attempts, result];
  if (!result.ok) {
    const failed: VerificationFailedState = {
      ...state,
      status: "verification-failed",
      attempts,
      message: `candidate verification failed on pass ${input.sequence}/${VERIFICATION_PASSES_REQUIRED}`,
    };
    return finishRepair(failed);
  }
  if (state.sequence === 1) {
    return {
      state: { ...state, attempts, sequence: VERIFICATION_PASSES_REQUIRED },
      effects: [verificationEffect(state, state.recipe, state.candidateTarget, VERIFICATION_PASSES_REQUIRED)],
    };
  }
  return {
    state: { ...state, attempts, status: "awaiting-commit" },
    effects: [{ kind: "commit-repair", expectedVersion: state.expectedVersion, patch: copyCandidate(state.recipe.patch) }],
  };
}

function advanceAwaitingCommit(
  state: AwaitingCommitState,
  input: InvestigationInput,
): InvestigationTransition {
  if (input.kind !== "commit-completed") {
    throw new InvalidInvestigationTransitionError(state.status, input.kind);
  }
  if (!input.result.ok) {
    if (input.result.reason === "conflict") {
      const conflict: CasConflictState = {
        ...state,
        status: "cas-conflict",
        message: input.result.message,
      };
      return finishRepair(conflict);
    }
    const failed: CommitErrorState = {
      ...state,
      status: "commit-error",
      message: input.result.message,
    };
    return finishRepair(failed);
  }
  if (state.intent.offerSwitch === false) {
    const committed: CommittedState = {
      ...state,
      status: "committed",
      commitVersion: input.result.version,
    };
    return finishRepair(committed);
  }
  const committed: CommittedState = {
    ...state,
    status: "committed",
    intent: { ...state.intent, offerSwitch: true },
    commitVersion: input.result.version,
  };
  return {
    state: committed,
    effects: [{ kind: "offer-switch", target: copyTarget(state.candidateTarget) }],
  };
}

function verificationEffect(
  state: Extract<InvestigationState, { status: "awaiting-snapshot" | "awaiting-verification" }>,
  recipe: RepairRecipeMatch,
  target: ProbeTarget,
  sequence: VerificationSequence,
): InvestigationEffect {
  return {
    kind: "verify-candidate", sequence, target: copyTarget(target), contracts: [...recipe.verifyContracts],
    ...(state.options.maxRequests !== undefined ? { maxRequests: state.options.maxRequests } : {}),
    ...(state.options.timeoutMs !== undefined ? { timeoutMs: state.options.timeoutMs } : {}),
    maxTokens: probeMaxTokensFor(state.target, state.options.maxTokens),
  };
}
