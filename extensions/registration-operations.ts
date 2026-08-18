import type { ModelsDevCapabilities } from "../src/capabilities/models-dev.ts";
import { ccMetaFrom } from "../src/capabilities/layers.ts";
import {
  resolveRegistrationCapability,
  type RegistrationCapabilityDecision,
  type RegistrationModelMetaFacts,
} from "../src/capabilities/registration.ts";
import type {
  PiThinkingRuntimeCapability,
  ProviderReasoningProfile,
} from "../src/capabilities/thinking-projection.ts";
import type { ResolvedProviderWireCompat } from "../src/provider-wire-compat.ts";
import type { ProviderRegistrationOpts } from "../src/register.ts";
import type { CcProvider, HeaderRule } from "../src/types.ts";
import type { TupleCompatSelection } from "../src/provider-config-views.ts";

export interface RegistrationOperations {
  decisionFor(
    provider: CcProvider,
    modelId: string,
  ): RegistrationCapabilityDecision;

  optionsFor(provider: CcProvider): ProviderRegistrationOpts;
}

/** Tuple-scoped facts needed to make the registration decision testable. */
export interface RegistrationDecisionDeps {
  modelMetaFactsFor(
    provider: CcProvider,
    modelId: string,
  ): RegistrationModelMetaFacts;
  modelsDevFor(modelId: string): ModelsDevCapabilities | undefined;
  piVersion?(): string | undefined;
  thinkingFor?(
    provider: CcProvider,
    modelId: string,
  ):
    | {
        profile?: ProviderReasoningProfile;
        runtime: PiThinkingRuntimeCapability;
      }
    | undefined;
}

function diagnosticThinkingRuntime(
  version: string | undefined,
): PiThinkingRuntimeCapability {
  return {
    version: version?.trim() || "unknown",
    runtimeVerified: false,
    payloadVerified: false,
    supportedControls: [],
    providerDefault: "supported",
    off: "unsupported",
  };
}

export function resolveRegistrationDecisionFor(
  provider: CcProvider,
  modelId: string,
  deps: RegistrationDecisionDeps,
): RegistrationCapabilityDecision {
  const metaFacts = deps.modelMetaFactsFor(provider, modelId);
  const thinking = deps.thinkingFor?.(provider, modelId);
  return resolveRegistrationCapability({
    modelId,
    api: provider.api,
    baseUrl: provider.baseUrl,
    userMeta: metaFacts.userMeta,
    modelsDev: deps.modelsDevFor(modelId),
    ccMeta: ccMetaFrom(provider.meta),
    ...(provider.api
      ? {
          thinking: {
            tuple: {
              appType: provider.appType,
              providerId: provider.id,
              api: provider.api,
              baseUrl: provider.baseUrl,
              modelId,
            },
            profile: thinking?.profile,
            runtime:
              thinking?.runtime ?? diagnosticThinkingRuntime(deps.piVersion?.()),
            userMapScope: "none" as const,
            userMapScopes: metaFacts.userMapScopes,
          },
        }
      : {}),
  });
}

type HeaderOverrideOptions = Pick<
  ProviderRegistrationOpts,
  "overrideHeaders" | "skipRules"
>;

/** Live fact readers used to assemble registration decisions and options. */
export interface RegistrationOperationsDeps extends RegistrationDecisionDeps {
  headerRules(): HeaderRule[];
  headerOverrideOpts(provider: CcProvider): HeaderOverrideOptions;
  headerVars(): Record<string, string>;
  debug(): boolean | undefined;
  rejectSink(): ProviderRegistrationOpts["onReject"];
  providerWireCompatFor(
    provider: CcProvider,
  ): ResolvedProviderWireCompat | undefined;
  tupleCompatFor(
    provider: CcProvider,
    modelId: string,
  ): TupleCompatSelection | undefined;
}

export function createRegistrationOperations(
  deps: RegistrationOperationsDeps,
): RegistrationOperations {
  const decisionFor = (provider: CcProvider, modelId: string) =>
    resolveRegistrationDecisionFor(provider, modelId, deps);

  return {
    decisionFor,

    optionsFor(provider) {
      return {
        rules: deps.headerRules(),
        ...deps.headerOverrideOpts(provider),
        vars: deps.headerVars(),
        debug: deps.debug(),
        onReject: deps.rejectSink(),
        registrationDecisionFor: (modelId) => decisionFor(provider, modelId),
        providerWireCompat: deps.providerWireCompatFor(provider),
        tupleCompatFor: (modelId) => deps.tupleCompatFor(provider, modelId),
      };
    },
  };
}
