/**
 * Install Pi `before_provider_request` hook that normalizes
 * `role: "developer"` -> `role: "system"` for pi-switch OpenAI providers.
 *
 * Some OpenAI-compatible providers (e.g. DeepSeek) reject the `developer`
 * role that Pi SDK may inject. This hook downgrades it to the older `system`
 * role immediately before the request reaches those compatibility endpoints.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyDeveloperRoleCompatToPayload,
  resolveDeveloperRoleCompatApi,
} from "../src/compat/developer-role-compat.ts";
import type { Runtime } from "./runtime.ts";

export function installDeveloperRoleCompat(
  pi: ExtensionAPI,
  rt: Runtime,
): void {
  pi.on("before_provider_request", (event, ctx) => {
    const api = resolveDeveloperRoleCompatApi(ctx.model, rt.registeredPsNames);
    if (!api) return event.payload;

    const next = applyDeveloperRoleCompatToPayload(event.payload, api);

    if (next !== event.payload && rt.config.debug) {
      console.error(
        `[pi-switch] developerRoleCompat: converted developer->system provider=${ctx.model?.provider ?? "unknown"} api=${api}`,
      );
    }

    return next;
  });
}
