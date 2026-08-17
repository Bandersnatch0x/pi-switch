/**
 * Shared fake-Runtime completion for command/lifecycle tests.
 *
 * Hand-built partial Runtimes used to each re-implement the derived members
 * (and drift: two fakes with different field sets, production code defending
 * against them with dead optional chains). This helper wires the derived
 * members to the fake's own views exactly like production Runtime, reading
 * through `rt` so later per-test overrides (rt.modelMetaFor = ...) stay
 * visible. Fields already present on the partial always win.
 */

import type { Runtime } from "../../extensions/runtime.ts";
import type { CcProvider } from "../../src/types.ts";
import {
  ccMetaFrom,
  resolveRegistrationCapability,
} from "../../src/capabilities/registration.ts";

export function completeFakeRuntime<T extends object>(partial: T): Runtime & T {
  const rt = partial as unknown as Runtime & T;
  if (!("registrationDecisionFor" in partial)) {
    rt.registrationDecisionFor = (provider: CcProvider, modelId: string) =>
      resolveRegistrationCapability({
        modelId,
        api: provider.api,
        baseUrl: provider.baseUrl,
        userMeta: rt.modelMetaFor(provider, modelId),
        modelsDev: rt.modelsDevFor(modelId),
        ccMeta: ccMetaFrom(provider.meta),
      });
  }
  if (!("registrationOptsFor" in partial)) {
    rt.registrationOptsFor = (provider: CcProvider) => ({
      rules: rt.headerRules,
      ...rt.headerOverrideOpts(provider),
      vars: rt.headerVars(),
      debug: rt.config?.debug,
      onReject: rt.rejectSink?.(),
      registrationDecisionFor: (id) =>
        rt.registrationDecisionFor(provider, id),
      providerWireCompat: rt.providerWireCompatFor(provider),
      tupleCompatFor: (id) => rt.tupleCompatFor(provider, id),
    });
  }
  return rt;
}
