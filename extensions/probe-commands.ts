/**
 * /ps-probe + /ps-repair production wiring (issue #42 / ticket 10).
 *
 * Builds the real ProbeTransport: modelRegistry auth + pi-ai `completeSimple()`,
 * reading `request.target` per request so fingerprint / claudeCodeCompat /
 * geminiToolCompat candidate flags actually reach the wire during repair
 * verification. Also builds the CAS RepairConfigStore (pi-switch.json
 * content-hash version token). Session Model is never switched by probe or
 * repair; post-success switch routes through the injected lifecycle.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  applyClaudeCodeCompatHeaders,
  applyClaudeCodeCompatToPayload,
  resolveDeviceId,
  resolveSystemPrefixText,
  shouldApplyClaudeCodeCompat,
  type ClaudeCodeCompatConfig,
} from "../src/compat/claude-code.ts";
import {
  applyGeminiToolCompatToPayload,
  isGeminiPayload,
  shouldApplyGeminiToolCompat,
  type GeminiToolCompatConfig,
} from "../src/compat/gemini-tool-compat.ts";
import { defaultDbPath } from "../src/db.ts";
import { fetchRemoteModels } from "../src/models-fetch.ts";
import { asRegisterApi } from "../src/pi-context.ts";
import { registerProvider } from "../src/register.ts";
import { threeLevelPick } from "../src/ui/three-level-pick.ts";
import {
  fingerprintHeaderTemplates,
  isFingerprintPreset,
} from "../src/headers/fingerprints.ts";
import { JsonFileConflictError, writeJsonObjectAtomic } from "../src/json-file.ts";
import type { FsLike } from "../src/json-file.ts";
import { resolveProviderOverride } from "../src/provider-override.ts";
import {
  piSwitchConfigPath,
  updateOverrideEntry,
  type MutableOverrideEntry,
} from "../src/settings.ts";
import type { CcProvider } from "../src/types.ts";
import type { PiSwitchCtx } from "../src/pi-context.ts";
import {
  REPAIR_CASE_DETAIL_CUSTOM_TYPE,
  REPAIR_CASE_SUMMARY_CUSTOM_TYPE,
  buildRepairCaseLayers,
  buildRepairPlan,
  defaultProbeTargetHighlight,
  executeRepairSwitchAction,
  findProviderForProbeTarget,
  formatProbeResultJson,
  formatProbeResultSummary,
  hasRepairSwitchAction,
  normalizeProbeRun,
  redactProbeText,
  resolveProbeTarget,
  selectProbeTarget,
  runProbe,
  runRepair,
  runTargetDoctorPrecheck,
  type NormalizedProbeRunEvidence,
  type ProbeAssistantMessage,
  type ProbeContentBlock,
  type ProbeRequest,
  type ProbeRunPrecheckSnapshot,
  type ProbeRunResult,
  type ProbeTarget,
  type ProbeTargetEnrichment,
  type ProbeTransport,
  type ProbeTransportResult,
  type RawProbeObservation,
  type RepairConfigStore,
  type RepairCaseRepairRecord,
  type RepairOutcome,
  type RepairPlanPreview,
  type RepairPlanPreviewPatch,
  type ResolveProbeTargetResult,
} from "../src/probe/index.ts";
import type { Runtime } from "./runtime.ts";
import type { SwitchLifecycle } from "./switch-lifecycle.ts";

// ── Transport (production) ──────────────────────────────────────────────────

function expandHeaderTemplates(
  templates: Record<string, string>,
  vars: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(templates)) {
    // Any referenced variable missing → skip the header entirely. Never send
    // a literal `{sessionId}`-style placeholder or an empty-value header.
    const refs = Array.from(v.matchAll(/\{(\w+)\}/g), (m) => m[1]);
    if (refs.some((key) => !(key in vars))) continue;
    out[k] = v.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? "");
  }
  return out;
}

function mapAssistantMessage(m: {
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  >;
  stopReason: ProbeAssistantMessage["stopReason"];
  errorMessage?: string;
}): ProbeAssistantMessage {
  return {
    role: "assistant",
    content: m.content.map((b): ProbeContentBlock => {
      if (b.type === "text") return { type: "text", text: b.text };
      if (b.type === "thinking") return { type: "thinking", thinking: b.thinking };
      return { type: "toolCall", id: b.id, name: b.name, arguments: b.arguments };
    }),
    stopReason: m.stopReason,
    ...(m.errorMessage !== undefined ? { errorMessage: m.errorMessage } : {}),
  };
}

export interface ProbeTransportDeps {
  /** Resolve auth for the opaque model handle (pi ModelRegistry.getApiKeyAndHeaders).
   * Failure is explicit: the transport returns an error result so evidence
   * shows the local auth resolution failure instead of a downstream 401/403. */
  resolveAuth: (
    model: unknown,
  ) => Promise<
    | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
    | { ok: false; error: string }
  >;
  /** Fingerprint template variables (production: rt.headerVars()). */
  headerVars?: () => Record<string, string>;
  /** pi-ai completeSimple() — injectable for unit tests (production: real completeSimple). */
  completeFn?: typeof completeSimple;
  /** Effective Claude compat payload settings used by normal provider hooks. */
  claudeCompat?: {
    config: ClaudeCodeCompatConfig;
    deviceId: string;
    systemPrefix: string | null;
  };
  /** Effective Gemini compat payload settings used by normal provider hooks. */
  geminiCompat?: GeminiToolCompatConfig;
  /** Optional per-request observation capture for durable evidence. */
  onObservation?: (obs: RawProbeObservation) => void;
}

/**
 * Production ProbeTransport. Reads `request.target` per request:
 *   fingerprint preset → expanded headers (with headerVars)
 *   claudeCodeCompat  → Claude Code request-shape headers (anthropic only)
 *   geminiToolCompat  → toolConfig / schema transform via onPayload
 * This is the transport Repair verification goes through, so the in-memory
 * candidate (patch applied) actually reaches the wire.
 */
export function createProbeTransport(deps: ProbeTransportDeps): ProbeTransport {
  /** Error result shared by every failure path — transport never throws. */
  const fail = (
    request: ProbeRequest,
    errorMessage: string,
    response?: { httpStatus?: number; responseHeaders?: Record<string, string> },
  ): ProbeTransportResult => {
    const result: ProbeTransportResult = {
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage,
      },
      ...(response?.httpStatus !== undefined
        ? { httpStatus: response.httpStatus }
        : {}),
      ...(response?.responseHeaders
        ? { responseHeaders: response.responseHeaders }
        : {}),
    };
    deps.onObservation?.({
      contract: request.contract,
      response: {
        message: result.message,
        ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
        ...(result.responseHeaders
          ? { responseHeaders: result.responseHeaders }
          : {}),
      },
    });
    return result;
  };
  const errText = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);
  const statusFromError = (err: unknown): number | undefined => {
    if (!err || typeof err !== "object") return undefined;
    const value = err as {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
    };
    const status = value.status ?? value.statusCode ?? value.response?.status;
    return typeof status === "number" && Number.isInteger(status)
      ? status
      : undefined;
  };

  return async (request: ProbeRequest) => {
    const model = request.model as Model<Api>;
    const target = request.target;

    let auth: Awaited<ReturnType<ProbeTransportDeps["resolveAuth"]>>;
    try {
      auth = await deps.resolveAuth(model);
    } catch (err) {
      // Explicit local failure: surface it as the stage error so evidence shows
      // the real cause (auth never resolved) instead of a downstream 401/403.
      return fail(request, `local auth resolution failed: ${errText(err)}`);
    }
    if (!auth.ok) {
      return fail(request, `local auth resolution failed: ${auth.error}`);
    }

    // fingerprint preset + claudeCodeCompat headers
    let headers: Record<string, string> = { ...(auth.headers ?? {}) };
    if (target.fingerprint && target.fingerprint !== "none") {
      headers = {
        ...headers,
        ...expandHeaderTemplates(
          fingerprintHeaderTemplates(target.fingerprint),
          (deps.headerVars ?? (() => ({})))(),
        ),
      };
    }
    if (target.claudeCodeCompat && model.api === "anthropic-messages") {
      applyClaudeCodeCompatHeaders(headers);
    }

    // Compat payload hooks do not fire on isolated completeSimple(), so mirror
    // the same transforms and settings used by normal provider requests.
    const claudeCompat =
      target.claudeCodeCompat === true && model.api === "anthropic-messages";
    const geminiCompat =
      target.geminiToolCompat === true && model.api === "google-generative-ai";
    const onPayload = claudeCompat || geminiCompat
      ? (payload: unknown) => {
          let next = payload;
          if (claudeCompat && deps.claudeCompat) {
            next = applyClaudeCodeCompatToPayload(next, {
              deviceId: deps.claudeCompat.deviceId,
              systemPrefix: deps.claudeCompat.systemPrefix,
              injectMetadata: deps.claudeCompat.config.injectMetadata,
              injectSystemPrefix: deps.claudeCompat.config.injectSystemPrefix,
              injectToolFingerprint:
                deps.claudeCompat.config.injectToolFingerprint,
            });
          }
          if (geminiCompat && isGeminiPayload(next)) {
            next = applyGeminiToolCompatToPayload(next, {
              forceToolConfigMode: deps.geminiCompat?.forceToolConfigMode,
              convertSchema: deps.geminiCompat?.convertSchema,
            });
          }
          return next === payload ? undefined : next;
        }
      : undefined;

    let httpStatus: number | undefined;
    let responseHeaders: Record<string, string> | undefined;

    const options: SimpleStreamOptions = {
      ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(auth.env ? { env: auth.env } : {}),
      maxTokens: request.options.maxTokens,
      signal: request.options.signal,
      ...(request.options.reasoning
        ? { reasoning: request.options.reasoning }
        : {}),
      maxRetries: 0,
      onResponse: (res) => {
        httpStatus = res.status;
        responseHeaders = res.headers;
      },
    };
    if (onPayload) options.onPayload = onPayload;

    const completeFn = deps.completeFn ?? completeSimple;
    let message: Awaited<ReturnType<typeof completeSimple>>;
    try {
      message = await completeFn(
        model,
        {
          ...(request.context.systemPrompt
            ? { systemPrompt: request.context.systemPrompt }
            : {}),
          messages: request.context.messages.map((m) => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
          })),
          ...(request.context.tools?.length
            ? {
                tools: request.context.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters as never,
                })),
              }
            : {}),
        },
        options,
      );
    } catch (err) {
      // Network / serialization / parse failure — surface as a stage error
      // instead of rejecting runProbe and losing the probe run.
      return fail(request, `provider request failed: ${errText(err)}`, {
        httpStatus: httpStatus ?? statusFromError(err),
        responseHeaders,
      });
    }

    const probeMessage = mapAssistantMessage(message);
    deps.onObservation?.({
      contract: request.contract,
      request: {
        messages: request.context.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        headers,
        tools: request.context.tools,
      },
      response: {
        message: probeMessage,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(responseHeaders ? { responseHeaders } : {}),
      },
    });

    return {
      message: probeMessage,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(responseHeaders ? { responseHeaders } : {}),
    } satisfies ProbeTransportResult;
  };
}

// ── Repair config store (CAS) ───────────────────────────────────────────────

/**
 * djb2 content hash used as the CAS version token. Deliberate tradeoff: an
 * FNV/djb2-class hash is not cryptographic, but collisions only matter if a
 * different config text hashes equal — astronomically unlikely for human-sized
 * pi-switch.json files and not an attacker-controlled input. Cheap, dependency-free,
 * and stable across sessions (no timestamps), unlike mtime-based tokens.
 */
function contentHash(source: string): string {
  let h = 5381;
  for (let i = 0; i < source.length; i += 1) {
    h = ((h << 5) + h + source.charCodeAt(i)) >>> 0;
  }
  return `h${h.toString(36)}`;
}

/**
 * Production RepairConfigStore with CAS against pi-switch.json.
 * version = content hash; commit re-checks the hash, then applies the patch
 * through the same atomic write path as manual edits.
 */
export function createRepairConfigStore(deps: {
  /** pi-switch.json directory (production: rt.home). */
  home: string;
  /** Node fs facade (production: rt.fsLike()). */
  fs: FsLike;
  providers: CcProvider[];
}): RepairConfigStore {
  const { fs, providers } = deps;
  const path = piSwitchConfigPath(deps.home);
  const pid = process.pid;

  const readSource = (): string | undefined => {
    if (!fs.existsSync(path)) return undefined;
    return fs.readFileSync(path, "utf8");
  };

  const parseSource = (source: string | undefined): Record<string, unknown> => {
    if (source === undefined) return {};
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`invalid JSON object in ${path}`);
    }
    return value as Record<string, unknown>;
  };

  return {
    read: () => ({ version: contentHash(readSource() ?? "") }),

    commit: ({ expectedVersion, patch }) => {
      let source: string | undefined;
      try {
        source = readSource();
      } catch (err) {
        return {
          ok: false,
          reason: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
      if (contentHash(source ?? "") !== expectedVersion) {
        return {
          ok: false,
          reason: "conflict",
          message: "pi-switch.json changed during repair; aborting to preserve external edits",
        };
      }

      const provider = findProviderForProbeTarget(providers, patch.provider);
      if (!provider) {
        return {
          ok: false,
          reason: "error",
          message: `repair target provider not found: ${patch.provider}`,
        };
      }

      try {
        const doc = parseSource(source);
        const document = updateOverrideEntry(
          doc,
          provider,
          (entry: MutableOverrideEntry) => {
            if (patch.kind === "modelMeta") {
              const map = entry.modelOverrides
                ? { ...entry.modelOverrides }
                : {};
              map[patch.modelId] = { ...patch.modelMeta };
              entry.modelOverrides = map;
              entry.label = entry.label ?? provider.displayName;
            } else if (patch.kind === "fingerprint") {
              entry.fingerprint = patch.fingerprint;
              if (patch.claudeCodeCompat) entry.claudeCodeCompat = true;
            } else if (patch.kind === "geminiToolCompat") {
              entry.geminiToolCompat = true;
            }
            return entry;
          },
        );
        // Strict CAS: write exactly against the source checked above. Unlike
        // updateJsonObjectAtomic, this path never retries by merging a newer file.
        writeJsonObjectAtomic(fs, path, document, pid, source);
        return {
          ok: true,
          version: contentHash(JSON.stringify(document, null, 2)),
        };
      } catch (err) {
        if (err instanceof JsonFileConflictError) {
          return {
            ok: false,
            reason: "conflict",
            message: "pi-switch.json changed concurrently; aborting",
          };
        }
        return {
          ok: false,
          reason: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

// ── Target enrichment from config ───────────────────────────────────────────

function enrichTarget(
  rt: Runtime,
  provider: CcProvider,
  modelId: string,
): ProbeTargetEnrichment | undefined {
  const entry = resolveProviderOverride(rt.config.providerOverrides, provider);
  const meta = rt.modelMetaFor(provider, modelId);
  const out: ProbeTargetEnrichment = {};
  if (meta?.reasoning !== undefined) out.reasoning = meta.reasoning;

  const claudeForce =
    typeof entry?.claudeCodeCompat === "boolean"
      ? entry.claudeCodeCompat
      : null;
  if (
    shouldApplyClaudeCodeCompat({
      mode: rt.config.claudeCodeCompat?.mode,
      hosts: rt.config.claudeCodeCompat?.hosts,
      api: provider.api,
      baseUrl: provider.baseUrl,
      providerForce: claudeForce,
    })
  ) {
    out.claudeCodeCompat = true;
  }

  const geminiForce =
    typeof entry?.geminiToolCompat === "boolean"
      ? entry.geminiToolCompat
      : null;
  if (
    shouldApplyGeminiToolCompat({
      mode: rt.config.geminiToolCompat?.mode,
      hosts: rt.config.geminiToolCompat?.hosts,
      api: provider.api,
      baseUrl: provider.baseUrl,
      providerForce: geminiForce,
    })
  ) {
    out.geminiToolCompat = true;
  }

  if (
    typeof entry?.fingerprint === "string" &&
    isFingerprintPreset(entry.fingerprint)
  ) {
    out.fingerprint = entry.fingerprint;
  }
  return Object.keys(out).length ? out : undefined;
}

async function chooseProbeTarget(
  rt: Runtime,
  ctx: PiSwitchCtx,
  providers: CcProvider[],
): Promise<ResolveProbeTargetResult | undefined> {
  const selection = rt.readSelectionCached();
  const resolveDefault = () =>
    resolveProbeTarget({
      providers,
      sessionModel: ctx.model,
      selection,
      enrichTarget: (p, m) => enrichTarget(rt, p, m),
    });

  const interactive = ctx.mode === "tui" || ctx.mode === "rpc";
  const canPick =
    typeof ctx.ui?.custom === "function" ||
    typeof ctx.ui?.select === "function";
  if (!interactive || !canPick) return resolveDefault();

  const hint = defaultProbeTargetHighlight({
    providers,
    sessionModel: ctx.model,
    selection,
  });
  const picked = await threeLevelPick(ctx, {
    providers,
    readOnly: true,
    preferredTab: hint.preferredTab,
    lastDbId: hint.lastDbId,
    lastModel: hint.lastModel,
    activePiName: hint.activePiName,
    tabOrder: rt.config.tabs,
    pins: rt.config.pins,
    recent: rt.config.recent,
    remoteCache: new Map<string, string[]>(),
    fetchRemote: async (provider) => {
      const ua = rt.overridesFor(provider)?.headers?.["User-Agent"];
      const result = await fetchRemoteModels({
        api: provider.api,
        authHeader: provider.authHeader,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        modelsUrl: provider.modelsUrl,
        isFullUrl: provider.isFullUrl,
        userAgent: ua,
      });
      if (result.error) throw new Error(result.error);
      return result.models;
    },
  });
  if (picked.kind === "cancel") return undefined;
  return selectProbeTarget(
    providers,
    {
      provider: picked.provider,
      modelId: picked.modelId ?? picked.provider.configModels[0] ?? "",
    },
    { enrichTarget: (p, m) => enrichTarget(rt, p, m) },
  );
}

function findOrRegisterProbeModel(
  pi: ExtensionAPI,
  rt: Runtime,
  ctx: PiSwitchCtx,
  provider: CcProvider,
  modelId: string,
): unknown {
  const registry = ctx.modelRegistry as
    | { find: (p: string, m: string) => unknown }
    | undefined;
  const existing = registry?.find?.(provider.piName, modelId);
  if (existing) return existing;

  const api = asRegisterApi(pi);
  if (typeof api.registerProvider !== "function") return undefined;
  let registered = false;
  try {
    registered = registerProvider(
      api,
      provider,
      [modelId],
      {
        rules: rt.headerRules,
        ...rt.headerOverrideOpts(provider),
        vars: rt.headerVars(),
        debug: rt.config.debug,
        onReject: rt.rejectSink(),
        modelMetaFor: (id) => rt.modelMetaFor(provider, id),
        modelsDevFor: (id) => rt.modelsDevFor?.(id),
        providerWireCompat: rt.providerWireCompatFor?.(provider),
        tupleCompatFor: (id) => rt.tupleCompatFor(provider, id),
      },
    );
  } catch {
    return undefined;
  }
  if (!registered) return undefined;
  return registry?.find?.(provider.piName, modelId);
}

// ── Precheck facts (production) ─────────────────────────────────────────────

async function buildPrecheck(
  rt: Runtime,
  providers: CcProvider[],
  providersError: string | undefined,
  target: ProbeTarget,
): Promise<ProbeRunPrecheckSnapshot | undefined> {
  const dbPath = defaultDbPath(rt.home);
  const routingProbe = await rt.routingProbe();
  const provider = findProviderForProbeTarget(providers, target.provider);
  const entry = provider
    ? resolveProviderOverride(rt.config.providerOverrides, provider)
    : undefined;
  const fingerprint: { status: "pass" | "warn"; detail: string } | undefined =
    entry && typeof entry.fingerprint === "string" && isFingerprintPreset(entry.fingerprint)
      ? {
          status: "pass",
          detail: `provider fingerprint preset: ${entry.fingerprint}`,
        }
      : undefined;

  // Issue #63: surface unresolved maxTokens / conservative reasoning before network.
  let capabilities: { status: "pass" | "warn" | "fail"; detail: string; fix?: string } | undefined;
  if (provider) {
    const resolved = rt.capabilitiesFor(provider, target.modelId);
    const maxUnresolved =
      resolved.maxTokens.source === "unresolved" ||
      typeof resolved.maxTokens.value !== "number";
    const reasonConservative = resolved.reasoning.source === "conservative-default";
    const staleWarn =
      resolved.maxTokens.source === "models-dev" && resolved.maxTokens.stale
        ? `；models.dev@${resolved.maxTokens.fetchedAt ?? "?"} 过期（保留 last-good）`
        : "";
    const label = `${provider.appType}/${provider.displayName}`;
    if (maxUnresolved) {
      capabilities = {
        status: "fail",
        detail:
          `${label} · ${target.modelId}: maxTokens=unresolved` +
          (reasonConservative ? " · reasoning=unknown→conservative false" : "") +
          staleWarn,
        fix:
          `在 providerOverrides 为 model "${target.modelId}" 写 exact-model ` +
          `maxTokens（modelOverrides.<id>.maxTokens）；不切换 Session Model`,
      };
    } else {
      const parts = [
        `maxTokens=${resolved.maxTokens.value}(${resolved.maxTokens.source})`,
        reasonConservative
          ? "reasoning=unknown→conservative false"
          : `reasoning=${resolved.reasoning.value}(${resolved.reasoning.source})`,
      ];
      capabilities = {
        status: reasonConservative || Boolean(staleWarn) ? "warn" : "pass",
        detail: `${label} · ${target.modelId}: ${parts.join(" · ")}${staleWarn}`,
        fix: reasonConservative
          ? `可选：exact-model 钉 reasoning；当前运行时保守 false，不写回配置`
          : staleWarn
            ? "过期：清缓存重拉（pi-switch-cache.json）或显式 override"
            : undefined,
      };
    }
  }

  return runTargetDoctorPrecheck({
    target,
    dbExists: rt.io.existsSync(dbPath),
    dbPath,
    providers,
    ...(providersError ? { providersError } : {}),
    ...(routingProbe ? { routingProbe } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(capabilities ? { capabilities } : {}),
  });
}

// ── Probe command ───────────────────────────────────────────────────────────

/**
 * Injectable seams for command-level tests.
 *
 * Defaults (omitted) replicate production wiring exactly: real transport via
 * ctx.modelRegistry + pi-ai complete(), real doctor precheck, real CAS store
 * on pi-switch.json. Tests inject fakes to drive the orchestration (target
 * resolve → precheck → probe → confirm → repair → CAS → switch → record)
 * with zero network and zero FS writes.
 */
export interface ProbeCommandDeps {
  /** Probe transport (default: production buildTransport). */
  transport?: ProbeTransport;
  /** Repair CAS config store (default: production createRepairConfigStore). */
  configStore?: RepairConfigStore;
  /** Doctor precheck builder (default: production buildPrecheck). */
  buildPrecheck?: (
    rt: Runtime,
    providers: CcProvider[],
    providersError: string | undefined,
    target: ProbeTarget,
  ) => Promise<ProbeRunPrecheckSnapshot | undefined>;
}

export async function runProbeCommand(
  pi: ExtensionAPI,
  rt: Runtime,
  ctx: PiSwitchCtx,
  deps: ProbeCommandDeps = {},
): Promise<void> {
  rt.reloadConfig();

  const { providers, error } = rt.refreshSnapshot();
  const resolved = await chooseProbeTarget(rt, ctx, providers);
  if (!resolved) {
    ctx.ui.notify("ps-probe cancelled", "info");
    return;
  }
  if (!resolved.ok) {
    ctx.ui.notify(resolved.message, "error");
    return;
  }
  const { target, provider, modelId } = resolved;

  // Precheck runs before registry/network so unresolved maxTokens fails closed
  // without inventing a registration or switching Session Model (issue #63).
  const precheck = deps.buildPrecheck
    ? await deps.buildPrecheck(rt, providers, error, target)
    : await buildPrecheck(rt, providers, error, target);
  if (precheck && precheck.status === "fail") {
    const halt = {
      ok: false as const,
      target,
      stages: [],
      requestCount: 0,
      stoppedReason: "precheck" as const,
      budget: { maxRequests: 0, used: 0, maxTokens: 0, timeoutMs: 0 },
      precheck,
    };
    reportPrecheckStop(ctx, "ps-probe", halt);
    // Headless / CI structured output (parity with post-runProbe path).
    if (ctx.mode === "json" || ctx.mode === "print") {
      console.log(formatProbeResultJson(halt));
    }
    recordProbeCase(pi, halt, []);
    return;
  }

  const model = findOrRegisterProbeModel(pi, rt, ctx, provider, modelId);
  if (!model) {
    ctx.ui.notify(
      `model not found in pi registry: ${provider.piName}/${modelId}` +
        `（若 maxTokens 未解析，请先写 exact-model maxTokens override）`,
      "error",
    );
    return;
  }

  const observations: RawProbeObservation[] = [];
  const transport = deps.transport ?? buildTransport(rt, ctx, observations);

  const result = await runProbe({
    target,
    model,
    transport,
    precheck,
  });

  reportProbeResult(ctx, result);
  // Headless / CI structured output (spec: ps-probe emits JSON without interaction).
  if (ctx.mode === "json" || ctx.mode === "print") {
    console.log(formatProbeResultJson(result));
  }
  recordProbeCase(pi, result, observations);
}

// ── Repair command ──────────────────────────────────────────────────────────

export async function runRepairCommand(
  pi: ExtensionAPI,
  rt: Runtime,
  lifecycle: SwitchLifecycle,
  ctx: PiSwitchCtx,
  deps: ProbeCommandDeps = {},
): Promise<void> {
  if (ctx.mode === "json" || ctx.mode === "print") {
    ctx.ui.notify("ps-repair requires interactive confirmation; headless is not allowed", "error");
    return;
  }

  rt.reloadConfig();

  const { providers, error } = rt.refreshSnapshot();
  const resolved = await chooseProbeTarget(rt, ctx, providers);
  if (!resolved) {
    ctx.ui.notify("ps-repair cancelled", "info");
    return;
  }
  if (!resolved.ok) {
    ctx.ui.notify(resolved.message, "error");
    return;
  }
  const { target, provider, modelId } = resolved;

  const model = findOrRegisterProbeModel(pi, rt, ctx, provider, modelId);
  if (!model) {
    ctx.ui.notify(
      `model not found in pi registry: ${provider.piName}/${modelId}`,
      "error",
    );
    return;
  }

  const precheck = deps.buildPrecheck
    ? await deps.buildPrecheck(rt, providers, error, target)
    : await buildPrecheck(rt, providers, error, target);

  const observations: RawProbeObservation[] = [];
  const transport = deps.transport ?? buildTransport(rt, ctx, observations);

  // /ps-repair re-probes fresh every run (evidence freshness).
  const probeResult = await runProbe({
    target,
    model,
    transport,
    precheck,
  });
  if (probeResult.stoppedReason === "precheck") {
    reportPrecheckStop(ctx, "ps-repair", probeResult);
    recordProbeCase(pi, probeResult, observations);
    return;
  }

  reportProbeResult(ctx, probeResult);

  const evidence = normalizeProbeRun({
    result: probeResult,
    observations,
    capturedAt: new Date().toISOString(),
  });
  const plan = buildRepairPlan(evidence);
  if (plan.recipes.length === 0) {
    ctx.ui.notify(
      `ps-repair: no whitelist recipe matched ${plan.preview.target}`,
      "warning",
    );
    recordProbeCase(pi, probeResult, observations, evidence, {
      status: "no-recipe",
      persisted: false,
      verificationAttempts: [],
      switch: { status: "not-offered" },
    });
    return;
  }

  const previewText = formatRepairPreview(plan.preview);
  const confirmed = await ctx.ui.confirm("确认执行修复？", previewText);
  if (!confirmed) {
    // Keep this probe run's evidence even though no patch was committed.
    recordProbeCase(pi, probeResult, observations, evidence, {
      status: "cancelled",
      persisted: false,
      verificationAttempts: [],
      switch: { status: "not-offered" },
    });
    ctx.ui.notify("ps-repair cancelled (no config write)", "info");
    return;
  }

  const store = deps.configStore
    ? deps.configStore
    : createRepairConfigStore({
        home: rt.home,
        fs: rt.fsLike(),
        providers,
      });
  const outcome = await runRepair({
    mode: "interactive",
    confirmed: true,
    plan,
    model,
    transport,
    configStore: store,
    precheck,
  });

  notifyRepairOutcome(ctx, outcome);

  // Post-success explicit switch (only path that may setModel after repair).
  let switchRecord: NonNullable<RepairCaseRepairRecord["switch"]> = {
    status: "not-offered",
  };
  if (hasRepairSwitchAction(outcome)) {
    const t = outcome.switchAction.target;
    const doSwitch = await ctx.ui.confirm(
      "切换到已修复目标？",
      `${t.provider}/${t.modelId} (session model unchanged until now)`,
    );
    if (!doSwitch) {
      switchRecord = {
        status: "declined",
        target: { ...t },
      };
    } else {
      const sw = await executeRepairSwitchAction(outcome.switchAction, {
        providers,
        activate: (target_) => lifecycle.activate(target_, ctx),
      });
      if (sw.ok) {
        ctx.ui.notify(sw.summary, "info");
        switchRecord = {
          status: "succeeded",
          target: { ...t },
          summary: redactProbeText(sw.summary),
        };
      } else {
        ctx.ui.notify(sw.message, "error");
        switchRecord = {
          status: "failed",
          target: { ...t },
          summary: redactProbeText(sw.message),
        };
      }
    }
  }

  recordProbeCase(
    pi,
    probeResult,
    observations,
    evidence,
    buildRepairCaseRecord(outcome, switchRecord),
  );
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Build the production transport for a command run.
 * Auth failures are surfaced as explicit error results (evidence shows the
 * local cause), never silently downgraded to an anonymous 401/403.
 */
function buildTransport(
  rt: Runtime,
  ctx: PiSwitchCtx,
  observations: RawProbeObservation[],
): ProbeTransport {
  const claudeConfig = rt.config.claudeCodeCompat ?? {};
  const deviceFs = rt.fsLike();
  const device = resolveDeviceId({
    home: rt.home,
    // Probe is read-only: reuse existing identity when present, but never create
    // the fallback device-id file during an isolated compatibility request.
    fs: {
      existsSync: deviceFs.existsSync,
      readFileSync: deviceFs.readFileSync,
      writeFileSync: () => undefined,
    },
    config: claudeConfig,
  });
  return createProbeTransport({
    headerVars: () => rt.headerVars(),
    claudeCompat: {
      config: claudeConfig,
      deviceId: device.deviceId,
      systemPrefix: resolveSystemPrefixText(claudeConfig.systemPrefix),
    },
    geminiCompat: rt.config.geminiToolCompat ?? {},
    resolveAuth: async (m) => {
      const reg = ctx.modelRegistry as {
        getApiKeyAndHeaders?: (m: unknown) => Promise<{
          ok: boolean;
          apiKey?: string;
          headers?: Record<string, string>;
          env?: Record<string, string>;
          error?: string;
        }>;
      };
      const auth = await reg.getApiKeyAndHeaders?.(m);
      if (!auth) {
        return { ok: false, error: "modelRegistry.getApiKeyAndHeaders unavailable" };
      }
      if (!auth.ok) {
        return { ok: false, error: auth.error ?? "auth resolution failed" };
      }
      return { ok: true, apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
    },
    onObservation: (obs) => observations.push(obs),
  });
}

function reportProbeResult(ctx: PiSwitchCtx, result: ProbeRunResult): void {
  if (result.stoppedReason === "precheck") {
    reportPrecheckStop(ctx, "ps-probe", result);
    return;
  }

  const summary = formatProbeResultSummary(result);
  ctx.ui.notify(summary, result.ok ? "info" : "warning");
}

function reportPrecheckStop(
  ctx: PiSwitchCtx,
  command: "ps-probe" | "ps-repair",
  result: ProbeRunResult,
): void {
  if (!result.precheck) {
    throw new Error(`${command} precheck stop is missing its precheck snapshot`);
  }
  ctx.ui.notify(`${command} stopped: ${result.precheck.summary}`, "error");
}

function formatRepairPreview(preview: RepairPlanPreview): string {
  const parts = preview.patches.map(
    (p) =>
      `• ${p.recipeId}[${p.scope}]: ${p.description}` +
      `\n  ${formatRepairPreviewImpact(p)}`,
  );
  return `目标: ${preview.target}\n方案: ${preview.recipeOrder.join(" → ")}\n${parts.join("\n")}`;
}

function formatRepairPreviewImpact(patch: RepairPlanPreviewPatch): string {
  if (patch.scope === "exact-model") {
    return `影响模型: ${patch.affectedModels.join(", ")} (仅此模型)`;
  }
  return `影响范围: provider ${patch.provider} 下的全部适用模型`;
}

function notifyRepairOutcome(ctx: PiSwitchCtx, outcome: RepairOutcome): void {
  // committed → info; commit/cas failures → error; everything else → warning.
  const levelByStatus: Record<RepairOutcome["status"], "info" | "warning" | "error"> = {
    committed: "info",
    "cas-conflict": "error",
    "commit-error": "error",
    "headless-rejected": "warning",
    "needs-confirmation": "warning",
    "no-recipe": "warning",
    "verification-failed": "warning",
  };
  const level = levelByStatus[outcome.status];
  ctx.ui.notify(`ps-repair ${outcome.status}: ${outcome.summary}`, level);
}

function buildRepairCaseRecord(
  outcome: RepairOutcome,
  switchRecord: NonNullable<RepairCaseRepairRecord["switch"]>,
): RepairCaseRepairRecord {
  const attempts = "attempts" in outcome ? outcome.attempts : [];
  const recipePreview =
    "recipe" in outcome
      ? outcome.plan.preview.patches.find(
          (item) => item.recipeId === outcome.recipe.recipeId,
        )
      : undefined;
  const recipeRecord =
    recipePreview && "recipe" in outcome
      ? buildRepairCaseRecipeRecord(outcome.recipe, recipePreview)
      : undefined;
  return {
    status: outcome.status,
    persisted: outcome.persisted,
    ...(recipeRecord ? { recipe: recipeRecord } : {}),
    verificationAttempts: attempts.map((attempt, index) => ({
      pass: index + 1,
      ok: attempt.ok,
      requestCount: attempt.requestCount,
      ...(attempt.stoppedReason
        ? { stoppedReason: attempt.stoppedReason }
        : {}),
      stages: attempt.stages.map((stage) => ({
        contract: stage.contract,
        status: stage.status,
        ...(stage.category ? { category: stage.category } : {}),
        ...(stage.httpStatus !== undefined
          ? { httpStatus: stage.httpStatus }
          : {}),
        summary: redactProbeText(stage.summary),
      })),
    })),
    switch: switchRecord,
  };
}

function buildRepairCaseRecipeRecord(
  recipe: { recipeId: string; signatureId: string },
  preview: RepairPlanPreviewPatch,
): NonNullable<RepairCaseRepairRecord["recipe"]> {
  const base = {
    recipeId: recipe.recipeId,
    signatureId: recipe.signatureId,
  };
  if (preview.scope === "exact-model") {
    return {
      ...base,
      scope: preview.scope,
      affectedModels: [...preview.affectedModels],
    };
  }
  return {
    ...base,
    scope: preview.scope,
    provider: preview.provider,
  };
}

function recordProbeCase(
  pi: ExtensionAPI,
  result: ProbeRunResult,
  observations: RawProbeObservation[],
  evidenceOverride?: NormalizedProbeRunEvidence,
  repair?: RepairCaseRepairRecord,
): void {
  const evidence =
    evidenceOverride ??
    normalizeProbeRun({
      result,
      observations,
      capturedAt: new Date().toISOString(),
    });
  const layers = buildRepairCaseLayers({ evidence, repair });
  pi.sendMessage({
    customType: REPAIR_CASE_SUMMARY_CUSTOM_TYPE,
    content: layers.summaryEntry.content,
    display: layers.summaryEntry.display,
    details: layers.summaryEntry.details,
  });
  pi.appendEntry(REPAIR_CASE_DETAIL_CUSTOM_TYPE, layers.detailEntry.data);
}
