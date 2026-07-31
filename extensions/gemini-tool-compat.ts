/**
 * Install Pi hooks that fix Gemini tool-calling compatibility for
 * third-party proxies that don't enforce parameter schemas without
 * explicit `toolConfig`.
 *
 * Two hooks:
 * 1. `before_provider_request`: inject `toolConfig` + rename `parametersJsonSchema` -> `parameters`
 * 2. `tool_call`: block empty-args tool calls so the model regenerates
 *
 * Mirrors the structure of `claude-code-compat.ts`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyGeminiToolCompatToPayload,
  emptyToolCallReason,
  hasEmptyToolCallArgs,
  shouldApplyGeminiToolCompat,
  type GeminiToolCompatConfig,
} from "../src/compat/gemini-tool-compat.ts";
import type { CcProvider } from "../src/types.ts";
import { appendCappedJsonLog, redactUrlCredentials } from "./compat-log.ts";
import type { Runtime } from "./runtime.ts";

export function installGeminiToolCompat(pi: ExtensionAPI, rt: Runtime): void {
  pi.on("before_provider_request", (event) => {
    const target = resolveCompatTarget(rt);
    if (!target.apply) return event.payload;

    const config = target.config;
    const next = applyGeminiToolCompatToPayload(event.payload, {
      forceToolConfigMode: config.forceToolConfigMode,
      convertSchema: config.convertSchema,
    });

    const modified = next !== event.payload;
    if (modified) {
      const summary = summarizePayload(next);
      logGeminiCompat(rt, {
        phase: "request",
        provider: target.provider?.displayName ?? target.provider?.piName ?? null,
        baseUrl: redactUrlCredentials(target.provider?.baseUrl ?? null),
        modelId: target.modelId ?? null,
        ...summary,
      });

      if (rt.config.debug) {
        console.error(
          `[pi-switch] geminiToolCompat request: toolConfig injected, schema=${config.convertSchema !== false ? "converted" : "as-is"} provider=${target.provider?.displayName ?? "?"}`,
        );
      }
    }

    return next;
  });

  pi.on("tool_call", (event) => {
    const target = resolveCompatTarget(rt);
    if (!target.apply) return;

    const config = target.config;
    if (config.blockEmptyToolCalls === false) return;

    if (hasEmptyToolCallArgs(event.input, event.toolName)) {
      const reason = emptyToolCallReason(event.toolName);
      logGeminiCompat(rt, {
        phase: "tool_call_blocked",
        tool: event.toolName,
        reason,
      });
      if (rt.config.debug) {
        console.error(
          `[pi-switch] geminiToolCompat blocked: tool="${event.toolName}" empty args`,
        );
      }
      return { block: true, reason };
    }
  });
}

// --- Provider resolution --------------------------------------------------

function resolveCompatTarget(rt: Runtime): {
  apply: boolean;
  config: GeminiToolCompatConfig;
  provider?: CcProvider;
  modelId?: string;
} {
  const config: GeminiToolCompatConfig = rt.config.geminiToolCompat ?? {};

  if (!rt.lastGoodProviders.length) {
    try {
      rt.refreshSnapshot();
    } catch {
      /* ignore */
    }
  }

  const selection = rt.readSelectionCached();
  let provider = selection
    ? rt.lastGoodProviders.find((p) => p.id === selection.dbId)
    : undefined;

  if (!provider && selection?.provider) {
    provider = rt.lastGoodProviders.find((p) => p.piName === selection.provider);
  }

  if (!provider) {
    // Without a resolved provider we cannot confirm google-generative-ai.
    // Do not apply: payload rewrite is gated by isGeminiPayload, but tool_call
    // blocking would incorrectly fire on non-Gemini sessions.
    return { apply: false, config };
  }

  const force = rt.config.providerOverrides?.[provider.id]?.geminiToolCompat;
  const apply = shouldApplyGeminiToolCompat({
    mode: config.mode,
    hosts: config.hosts,
    api: provider.api,
    baseUrl: provider.baseUrl,
    providerForce: typeof force === "boolean" ? force : null,
  });

  return {
    apply,
    config,
    provider,
    modelId: selection?.model ?? provider.configModels[0],
  };
}

// --- File logging ---------------------------------------------------------

function summarizePayload(payload: unknown): {
  model: string | null;
  toolCount: number;
  toolNames: string[];
  hasToolConfig: boolean;
  toolConfigMode: string | null;
} {
  if (!payload || typeof payload !== "object") {
    return { model: null, toolCount: 0, toolNames: [], hasToolConfig: false, toolConfigMode: null };
  }
  const p = payload as Record<string, unknown>;
  const config = p.config as Record<string, unknown> | undefined;
  const tools = Array.isArray(config?.tools) ? config!.tools : [];
  const toolNames: string[] = [];
  for (const ts of tools) {
    if (ts && typeof ts === "object") {
      const fd = (ts as Record<string, unknown>).functionDeclarations;
      if (Array.isArray(fd)) {
        for (const d of fd) {
          if (d && typeof d === "object") {
            const name = (d as Record<string, unknown>).name;
            if (typeof name === "string") toolNames.push(name);
          }
        }
      }
    }
  }
  let hasToolConfig = false;
  let toolConfigMode: string | null = null;
  if (config?.toolConfig) {
    hasToolConfig = true;
    const fc = (config!.toolConfig as Record<string, unknown>)?.functionCallingConfig;
    toolConfigMode = (fc as Record<string, unknown> | undefined)?.mode as string ?? null;
  }
  return {
    model: typeof p.model === "string" ? p.model : null,
    toolCount: toolNames.length,
    toolNames: toolNames.slice(0, 20),
    hasToolConfig,
    toolConfigMode,
  };
}

function logGeminiCompat(rt: Runtime, entry: Record<string, unknown>): void {
  const path = `${rt.home.replace(/[\\/]+$/, "")}/.pi/agent/pi-switch-gemini-compat.log`;
  appendCappedJsonLog(rt.fsLike(), path, entry);
}
