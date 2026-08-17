import type { ModelsDevCapabilities } from "../src/capabilities/models-dev.ts";
import { ccMetaFrom } from "../src/capabilities/layers.ts";
import {
  resolveRegistrationCapability,
  type RegistrationCapabilityDecision,
} from "../src/capabilities/registration.ts";
import type { ResolvedProviderWireCompat } from "../src/provider-wire-compat.ts";
import type { ProviderRegistrationOpts } from "../src/register.ts";
import type { CcProvider, HeaderRule, ModelMetaOverride } from "../src/types.ts";
import type { TupleCompatSelection } from "../src/provider-config-views.ts";

export interface RegistrationOperations {
  decisionFor(
    provider: CcProvider,
    modelId: string,
  ): RegistrationCapabilityDecision;

  optionsFor(provider: CcProvider): ProviderRegistrationOpts;
}

type HeaderOverrideOptions = Pick<
  ProviderRegistrationOpts,
  "overrideHeaders" | "skipRules"
>;

/** Live fact readers used to assemble registration decisions and options. */
export interface RegistrationOperationsDeps {
  headerRules(): HeaderRule[];
  headerOverrideOpts(provider: CcProvider): HeaderOverrideOptions;
  headerVars(): Record<string, string>;
  debug(): boolean | undefined;
  rejectSink(): ProviderRegistrationOpts["onReject"];
  modelMetaFor(
    provider: CcProvider,
    modelId: string,
  ): ModelMetaOverride | undefined;
  modelsDevFor(modelId: string): ModelsDevCapabilities | undefined;
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
  return {
    decisionFor(provider, modelId) {
      return resolveRegistrationCapability({
        modelId,
        api: provider.api,
        baseUrl: provider.baseUrl,
        userMeta: deps.modelMetaFor(provider, modelId),
        modelsDev: deps.modelsDevFor(modelId),
        ccMeta: ccMetaFrom(provider.meta),
      });
    },

    optionsFor(provider) {
      return {
        rules: deps.headerRules(),
        ...deps.headerOverrideOpts(provider),
        vars: deps.headerVars(),
        debug: deps.debug(),
        onReject: deps.rejectSink(),
        modelMetaFor: (modelId) => deps.modelMetaFor(provider, modelId),
        modelsDevFor: (modelId) => deps.modelsDevFor(modelId),
        providerWireCompat: deps.providerWireCompatFor(provider),
        tupleCompatFor: (modelId) => deps.tupleCompatFor(provider, modelId),
      };
    },
  };
}
