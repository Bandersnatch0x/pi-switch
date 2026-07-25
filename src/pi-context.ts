/**
 * Typed boundaries against @earendil-works/pi-coding-agent.
 * Keeps extension code free of ad-hoc `as any` at call sites.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { PiRegisterApi } from "./register.ts";

/** Minimal model shape we read from ctx.model. */
export type ActiveModelLike = {
  provider?: string;
  id?: string;
};

/** ModelRegistry surface used by switch/register helpers. */
export type ModelRegistryLike = {
  find?: (provider: string, modelId: string) => unknown;
};

/** Context with optional modelRegistry/model (commands + session handlers). */
export type PiSwitchCtx = {
  ui: ExtensionUIContext;
  mode?: ExtensionContext["mode"];
  modelRegistry?: ModelRegistryLike;
  model?: ActiveModelLike | null | undefined;
};

/** @deprecated Prefer PiSwitchCtx; kept for call-site clarity. */
export type ThreeLevelPickCtx = PiSwitchCtx;

/** Narrow notify/status surface for non-interactive handlers (doctor). */
export type NotifyUi = Pick<ExtensionUIContext, "notify" | "setStatus">;

export function asRegisterApi(pi: ExtensionAPI): PiRegisterApi {
  return pi as unknown as PiRegisterApi;
}

export function findRegisteredModel(
  ctx: Pick<PiSwitchCtx, "modelRegistry"> | Pick<ExtensionContext, "modelRegistry">,
  provider: string,
  modelId: string,
): unknown {
  const registry = ctx.modelRegistry as ModelRegistryLike | undefined;
  return registry?.find?.(provider, modelId);
}

export function activeProviderName(
  ctx: Pick<PiSwitchCtx, "model"> | Pick<ExtensionContext, "model">,
): string | undefined {
  const model = ctx.model as ActiveModelLike | null | undefined;
  const provider = model?.provider;
  return typeof provider === "string" && provider.length ? provider : undefined;
}

export function asCommandCtx(ctx: ExtensionCommandContext): PiSwitchCtx {
  return ctx as unknown as PiSwitchCtx;
}

export type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionUIContext };
