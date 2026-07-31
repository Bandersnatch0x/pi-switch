/**
 * Install Pi hooks that reshape anthropic-messages requests to match Claude
 * Code fingerprints required by relays such as anyrouter.top.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyClaudeCodeCompatHeaders,
  applyClaudeCodeCompatToPayload,
  resolveDeviceId,
  resolveSystemPrefixText,
  shouldApplyClaudeCodeCompat,
  type ClaudeCodeCompatConfig,
} from "../src/compat/claude-code.ts";
import type { CcProvider } from "../src/types.ts";
import { appendCappedJsonLog, redactUrlCredentials } from "./compat-log.ts";
import type { Runtime } from "./runtime.ts";

export function installClaudeCodeCompat(pi: ExtensionAPI, rt: Runtime): void {
  pi.on("before_provider_request", (event) => {
    const target = resolveCompatTarget(rt);
    if (!target.apply) return event.payload;

    const device = resolveDeviceId({
      home: rt.home,
      fs: rt.fsLike(),
      config: target.config,
    });
    const systemPrefix = resolveSystemPrefixText(target.config.systemPrefix);

    const next = applyClaudeCodeCompatToPayload(event.payload, {
      deviceId: device.deviceId,
      systemPrefix,
      injectMetadata: target.config.injectMetadata,
      injectSystemPrefix: target.config.injectSystemPrefix,
      injectToolFingerprint: target.config.injectToolFingerprint,
    });

    // Always log once to a small file so users can verify the hook fired.
    const summary = summarizePayload(next);
    logCompat(rt, {
      phase: "request",
      apply: true,
      deviceSource: device.source,
      provider: target.provider?.displayName ?? target.provider?.piName ?? null,
      baseUrl: redactUrlCredentials(target.provider?.baseUrl ?? null),
      ...summary,
    });
    // Dump last transformed body for offline replay/debug.
    writeLastPayload(rt, next);

    if (rt.config.debug) {
      console.error(
        `[pi-switch] claudeCodeCompat request: deviceSource=${device.source} prefix=${systemPrefix ? "yes" : "no"} toolsPad=${target.config.injectToolFingerprint !== false} tools=${summary.toolCount} provider=${target.provider?.displayName ?? "?"}`,
      );
    }

    return next;
  });

  pi.on("before_provider_headers", (event) => {
    const target = resolveCompatTarget(rt);
    if (!target.apply) return;
    if (target.config.injectHeaders === false) return;

    applyClaudeCodeCompatHeaders(event.headers as Record<string, string | null | undefined>);
  });
}

function resolveCompatTarget(rt: Runtime): {
  apply: boolean;
  config: ClaudeCodeCompatConfig;
  provider?: CcProvider;
} {
  const config: ClaudeCodeCompatConfig = rt.config.claudeCodeCompat ?? {};
  // Ensure provider list is warm (install may have failed earlier, or DB updated).
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

  // Fallback: match by registered piName (settings.defaultProvider / selection.provider).
  if (!provider && selection?.provider) {
    provider = rt.lastGoodProviders.find((p) => p.piName === selection.provider);
  }

  if (!provider) {
    // Heuristic: selection.provider name contains anyrouter → treat as anyrouter host.
    const nameHint = (selection?.provider ?? "").toLowerCase();
    if (nameHint.includes("anyrouter") && (config.mode ?? "auto") !== "never") {
      return {
        apply: true,
        config,
        provider: {
          id: selection?.dbId ?? "unknown",
          piName: selection?.provider ?? "anyrouter",
          displayName: selection?.provider ?? "anyrouter",
          appType: "claude",
          api: "anthropic-messages",
          baseUrl: "https://anyrouter.top",
          apiKey: "",
          authHeader: true,
          configModels: [],
          meta: {},
          isCurrentInCc: false,
        },
      };
    }
    return {
      apply: (config.mode ?? "auto") === "always",
      config,
    };
  }

  const force = rt.config.providerOverrides?.[provider.id]?.claudeCodeCompat;
  const apply = shouldApplyClaudeCodeCompat({
    mode: config.mode,
    hosts: config.hosts,
    api: provider.api,
    baseUrl: provider.baseUrl,
    providerForce: typeof force === "boolean" ? force : null,
  });
  return { apply, config, provider };
}

function summarizePayload(payload: unknown): {
  model: string | null;
  toolCount: number;
  toolNames: string[];
  hasMetadata: boolean;
  sessionId: string | null;
  system0: string | null;
} {
  if (!payload || typeof payload !== "object") {
    return {
      model: null,
      toolCount: 0,
      toolNames: [],
      hasMetadata: false,
      sessionId: null,
      system0: null,
    };
  }
  const body = payload as Record<string, unknown>;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolNames = tools
    .map((t) =>
      t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string"
        ? (t as { name: string }).name
        : "?",
    )
    .slice(0, 20);
  let sessionId: string | null = null;
  let hasMetadata = false;
  if (body.metadata && typeof body.metadata === "object") {
    hasMetadata = true;
    const uid = (body.metadata as { user_id?: unknown }).user_id;
    if (typeof uid === "string") {
      try {
        const p = JSON.parse(uid) as { session_id?: unknown };
        if (typeof p.session_id === "string") sessionId = p.session_id;
      } catch {
        sessionId = null;
      }
    }
  }
  let system0: string | null = null;
  if (typeof body.system === "string") system0 = body.system.slice(0, 80);
  else if (Array.isArray(body.system) && body.system[0] && typeof body.system[0] === "object") {
    const t = (body.system[0] as { text?: unknown }).text;
    if (typeof t === "string") system0 = t.slice(0, 80);
  }
  return {
    model: typeof body.model === "string" ? body.model : null,
    toolCount: tools.length,
    toolNames,
    hasMetadata,
    sessionId,
    system0,
  };
}

function writeLastPayload(rt: Runtime, payload: unknown): void {
  try {
    const path = `${rt.home.replace(/[\\/]+$/, "")}/.pi/agent/pi-switch-compat-last-payload.json`;
    rt.fsLike().writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

function logCompat(
  rt: Runtime,
  entry: Record<string, unknown>,
): void {
  const path = `${rt.home.replace(/[\\/]+$/, "")}/.pi/agent/pi-switch-compat.log`;
  appendCappedJsonLog(rt.fsLike(), path, entry);
}
