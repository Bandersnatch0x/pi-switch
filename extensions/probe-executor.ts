import type { CcProvider } from "../src/types.ts";
import {
  createProbeVerifier,
  normalizeProbeRun,
  runProbe,
  type NormalizedProbeRunEvidence,
  type ProbeRunPrecheckSnapshot,
  type ProbeRunResult,
  type ProbeTarget,
  type ProbeTransport,
  type ProbeVerifier,
  type RawProbeObservation,
} from "../src/probe/index.ts";
import type { ProbeTargetResult } from "./switch-lifecycle.ts";

export interface CompatibilityProbeExecutorDeps {
  buildPrecheck: (
    target: ProbeTarget,
  ) => Promise<ProbeRunPrecheckSnapshot | undefined>;
  ensureProbeTarget: (
    provider: CcProvider,
    modelId: string,
  ) => ProbeTargetResult;
  createTransport: (observations: RawProbeObservation[]) => ProbeTransport;
  capturedAt?: () => string;
}

export interface CompatibilityProbeExecutionInput {
  target: ProbeTarget;
  provider: CcProvider;
}

interface ProbeExecutionArtifacts {
  result: ProbeRunResult;
  observations: RawProbeObservation[];
  evidence: NormalizedProbeRunEvidence;
}

export type CompatibilityProbeExecution =
  | ({ kind: "precheck-stopped" } & ProbeExecutionArtifacts)
  | { kind: "registration-failed"; error: string }
  | ({ kind: "completed"; verify: ProbeVerifier } & ProbeExecutionArtifacts);

export interface CompatibilityProbeExecutor {
  execute(
    input: CompatibilityProbeExecutionInput,
  ): Promise<CompatibilityProbeExecution>;
}

function precheckStopResult(
  target: ProbeTarget,
  precheck: ProbeRunPrecheckSnapshot,
): ProbeRunResult {
  return {
    ok: false,
    target,
    stages: [],
    requestCount: 0,
    stoppedReason: "precheck",
    budget: { maxRequests: 0, used: 0, maxTokens: 0, timeoutMs: 0 },
    precheck,
  };
}

export function createCompatibilityProbeExecutor(
  deps: CompatibilityProbeExecutorDeps,
): CompatibilityProbeExecutor {
  const capturedAt = deps.capturedAt ?? (() => new Date().toISOString());

  return {
    async execute({ target, provider }) {
      const precheck = await deps.buildPrecheck(target);
      if (precheck && !precheck.allowProbe) {
        const result = precheckStopResult(target, precheck);
        const observations: RawProbeObservation[] = [];
        return {
          kind: "precheck-stopped",
          result,
          observations,
          evidence: normalizeProbeRun({
            result,
            observations,
            capturedAt: capturedAt(),
          }),
        };
      }

      const registration = deps.ensureProbeTarget(provider, target.modelId);
      if (registration.kind === "failed") {
        return { kind: "registration-failed", error: registration.error };
      }

      const observations: RawProbeObservation[] = [];
      const transport = deps.createTransport(observations);
      const shared = {
        model: registration.model,
        transport,
        ...(precheck ? { precheck } : {}),
      };
      const result = await runProbe({ target, ...shared });
      const evidence = normalizeProbeRun({
        result,
        observations,
        capturedAt: capturedAt(),
      });
      const verify: ProbeVerifier = createProbeVerifier(shared);

      return {
        kind: "completed",
        result,
        observations,
        evidence,
        verify,
      };
    },
  };
}
