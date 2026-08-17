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
  resolveDeviceId,
  resolveSystemPrefixText,
  shouldApplyClaudeCodeCompat,
  type ClaudeCodeCompatConfig,
} from "../src/compat/claude-code.ts";
import {
  shouldApplyGeminiToolCompat,
} from "../src/compat/gemini-tool-compat.ts";
import {
  applyCompatibilityPlan,
  buildCompatibilityPlan,
  type CompatibilityPlan,
} from "../src/compat/plan.ts";
import { defaultDbPath } from "../src/db.ts";
import { fetchRemoteModels } from "../src/models-fetch.ts";
import { threeLevelPick } from "../src/ui/three-level-pick.ts";
import {
  isFingerprintPreset,
} from "../src/headers/fingerprints.ts";
import { editConfigStrict } from "../src/config-edit.ts";
import type { FsLike } from "../src/json-file.ts";
import type { ResolvedOverrideHeaders } from "../src/headers/fingerprints.ts";
import { resolveProviderOverride } from "../src/provider-override.ts";
import { piSwitchConfigPath } from "../src/paths.ts";
import type {
  CcProvider,
  PiSwitchConfig,
  PiSwitchSelection,
} from "../src/types.ts";
import type { PiSwitchCtx } from "../src/pi-context.ts";
import { tf } from "../src/ui/tui-locale.ts";
import {
  applyRepairCandidateToConfigDocument,
  buildRepairPlan,
  capabilitySoftCheck,
  createRepairCaseRepairEvent,
  createRepairCaseRecorder,
  defaultProbeTargetHighlight,
  executeRepairSwitchAction,
  findProviderForProbeTarget,
  formatProbeResultJson,
  formatProbeResultSummary,
  hasRepairSwitchAction,
  resolveProbeTarget,
  selectProbeTarget,
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
  type RepairCaseRecorder,
  type RepairCaseSwitchRecord,
  type RepairOutcome,
  type RepairPlanPreview,
  type RepairPlanPreviewPatch,
  type ResolveProbeTargetResult,
} from "../src/probe/index.ts";
import { createPiRepairCaseWriteAdapter } from "./repair-case-adapter.ts";
import {
  createSwitchLifecycle,
  type SwitchLifecycle,
  type SwitchLifecycleRuntime,
} from "./switch-lifecycle.ts";
import {
  createCompatibilityProbeExecutor,
  type CompatibilityProbeExecutor,
} from "./probe-executor.ts";

export interface ProbeCommandRuntime extends SwitchLifecycleRuntime {
  readonly home: string;
  io: {
    existsSync(path: string): boolean;
  };
  fsLike(): FsLike;
  headerVars(): Record<string, string>;
  overridesFor(provider: CcProvider): ResolvedOverrideHeaders | undefined;
  readSelectionCached(ttlMs?: number): PiSwitchSelection | undefined;
  reloadConfig(): PiSwitchConfig;
  routingProbe(): Promise<{ url: string; reachable: boolean } | undefined>;
}

type ProbeTargetEnrichmentRuntime = Pick<
  ProbeCommandRuntime,
  "config" | "registration"
>;

type ProbePrecheckRuntime = Pick<
  ProbeCommandRuntime,
  "config" | "home" | "io" | "registration" | "routingProbe"
>;

// ── Transport (production) ──────────────────────────────────────────────────

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
  /** Effective Gemini compat settings used by normal provider requests. */
  geminiCompat?: import("../src/compat/gemini-tool-compat.ts").GeminiToolCompatConfig;
  /** Optional per-request observation sink for in-memory evidence normalization. */
  onObservation?: (obs: RawProbeObservation) => void;
}

function prepareCompatibilityRequest(
  request: ProbeRequest,
  model: Model<Api>,
  authHeaders: Record<string, string> | undefined,
  deps: Pick<
    ProbeTransportDeps,
    "claudeCompat" | "geminiCompat" | "headerVars"
  >,
): { plan: CompatibilityPlan; headers: Record<string, string> } {
  const plan = buildCompatibilityPlan({
    target: request.target,
    api: model.api,
    headerVars: (deps.headerVars ?? (() => ({})))(),
    claudeCompat: deps.claudeCompat,
    geminiCompat: deps.geminiCompat,
  });
  const applied = applyCompatibilityPlan({
    plan,
    headers: authHeaders,
    payload: undefined,
    claudeDeviceId: deps.claudeCompat?.deviceId,
  });
  return { plan, headers: applied.headers as Record<string, string> };
}

function createCompatibilityPayloadHook(
  plan: CompatibilityPlan,
  headers: Record<string, string>,
  claudeDeviceId: string | undefined,
): ((payload: unknown) => unknown) | undefined {
  if (!plan.claude && !plan.gemini) return undefined;

  return (payload: unknown) => {
    const next = applyCompatibilityPlan({
      plan,
      headers,
      payload,
      claudeDeviceId,
    }).payload;
    return next === payload ? undefined : next;
  };
}

function toSimpleContext(request: ProbeRequest) {
  return {
    ...(request.context.systemPrompt
      ? { systemPrompt: request.context.systemPrompt }
      : {}),
    messages: request.context.messages.map((message) => ({
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
    })),
    ...(request.context.tools?.length
      ? {
          tools: request.context.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as never,
          })),
        }
      : {}),
  };
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

    let compatibility: ReturnType<typeof prepareCompatibilityRequest>;
    try {
      compatibility = prepareCompatibilityRequest(
        request,
        model,
        auth.headers,
        deps,
      );
    } catch (err) {
      // Compatibility plan construction/application is local transport setup;
      // return the same explicit failure shape as auth/provider failures.
      return fail(request, `local compatibility setup failed: ${errText(err)}`);
    }

    const { plan, headers } = compatibility;
    const onPayload = createCompatibilityPayloadHook(
      plan,
      headers,
      deps.claudeCompat?.deviceId,
    );
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
      message = await completeFn(model, toSimpleContext(request), options);
    } catch (err) {
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
 * through editConfigStrict — the envelope's exact-source adapter (editConfig
 * merge-retries; Repair must abort on concurrent edits instead).
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

      const edited = editConfigStrict(
        { fs, configPath: path, pid },
        source,
        (doc) => applyRepairCandidateToConfigDocument(doc, provider, patch),
      );
      if (!edited.ok) {
        return edited.reason === "conflict"
          ? {
              ok: false,
              reason: "conflict",
              message: "pi-switch.json changed concurrently; aborting",
            }
          : { ok: false, reason: "error", message: edited.message };
      }
      return {
        ok: true,
        version: contentHash(JSON.stringify(edited.document, null, 2)),
      };
    },
  };
}

// ── Target enrichment from config ───────────────────────────────────────────

function enrichTarget(
  rt: ProbeTargetEnrichmentRuntime,
  provider: CcProvider,
  modelId: string,
): ProbeTargetEnrichment | undefined {
  const entry = resolveProviderOverride(rt.config.providerOverrides, provider);
  const out: ProbeTargetEnrichment = {};
  // Registration's truth: user layer included, conservative-default excluded.
  // A relay's reasoning model must reach the probe as reasoning (#83).
  const decision = rt.registration.decisionFor(provider, modelId);
  const reasoning = decision.resolved.reasoning;
  if (!decision.reasoningConservative && reasoning.value !== undefined) {
    out.reasoning = reasoning.value;
  }

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
  rt: ProbeCommandRuntime,
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
      const result = await fetchRemoteModels(provider, { userAgent: ua });
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

// ── Precheck facts (production) ─────────────────────────────────────────────

async function buildPrecheck(
  rt: ProbePrecheckRuntime,
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

  // Issue #63: surface unresolved maxTokens / conservative reasoning before
  // network — judged with registration's decision, formatted in one place.
  const capabilities = provider
    ? capabilitySoftCheck({
        decision: rt.registration.decisionFor(provider, target.modelId),
        providerLabel: `${provider.appType}/${provider.displayName}`,
        modelId: target.modelId,
      })
    : undefined;

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
    rt: ProbePrecheckRuntime,
    providers: CcProvider[],
    providersError: string | undefined,
    target: ProbeTarget,
  ) => Promise<ProbeRunPrecheckSnapshot | undefined>;
  /** Existing lifecycle in production; tests may use an uninstalled lifecycle. */
  registrationLifecycle?: SwitchLifecycle;
}

function buildProbeExecutor(
  rt: ProbeCommandRuntime,
  lifecycle: SwitchLifecycle,
  ctx: PiSwitchCtx,
  providers: CcProvider[],
  providersError: string | undefined,
  deps: ProbeCommandDeps,
): CompatibilityProbeExecutor {
  return createCompatibilityProbeExecutor({
    buildPrecheck: (target) =>
      deps.buildPrecheck
        ? deps.buildPrecheck(rt, providers, providersError, target)
        : buildPrecheck(rt, providers, providersError, target),
    ensureProbeTarget: (provider, modelId) =>
      lifecycle.ensureProbeTarget(ctx, provider, modelId),
    createTransport: (captureObservation) =>
      deps.transport ?? buildTransport(rt, ctx, captureObservation),
  });
}

export async function runProbeCommand(
  pi: ExtensionAPI,
  rt: ProbeCommandRuntime,
  ctx: PiSwitchCtx,
  deps: ProbeCommandDeps = {},
): Promise<void> {
  const recorder = createRepairCaseRecorder(createPiRepairCaseWriteAdapter(pi));
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

  const execution = await buildProbeExecutor(
    rt,
    deps.registrationLifecycle ?? createSwitchLifecycle(pi, rt),
    ctx,
    providers,
    error,
    deps,
  ).execute({ target, provider });
  if (execution.kind === "precheck-stopped") {
    reportPrecheckStop(ctx, "ps-probe", execution.result);
    // Headless / CI structured output (parity with post-runProbe path).
    if (ctx.mode === "json" || ctx.mode === "print") {
      console.log(formatProbeResultJson(execution.result));
    }
    recordProbeCase(recorder, execution.evidence);
    return;
  }
  if (execution.kind === "registration-failed") {
    ctx.ui.notify(
      `model not found in pi registry: ${provider.piName}/${modelId}\n` +
        `${execution.error}\n` +
        tf("maxTokensUnresolvedFix", { model: modelId }),
      "error",
    );
    return;
  }

  reportProbeResult(ctx, execution.result);
  // Headless / CI structured output (spec: ps-probe emits JSON without interaction).
  if (ctx.mode === "json" || ctx.mode === "print") {
    console.log(formatProbeResultJson(execution.result));
  }
  recordProbeCase(recorder, execution.evidence);
}

// ── Repair command ──────────────────────────────────────────────────────────

export async function runRepairCommand(
  pi: ExtensionAPI,
  rt: ProbeCommandRuntime,
  lifecycle: SwitchLifecycle,
  ctx: PiSwitchCtx,
  deps: ProbeCommandDeps = {},
): Promise<void> {
  if (ctx.mode === "json" || ctx.mode === "print") {
    ctx.ui.notify("ps-repair requires interactive confirmation; headless is not allowed", "error");
    return;
  }

  const recorder = createRepairCaseRecorder(createPiRepairCaseWriteAdapter(pi));

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

  const execution = await buildProbeExecutor(
    rt,
    lifecycle,
    ctx,
    providers,
    error,
    deps,
  ).execute({ target, provider });
  if (execution.kind === "registration-failed") {
    ctx.ui.notify(
      `model not found in pi registry: ${provider.piName}/${modelId}\n` +
        execution.error,
      "error",
    );
    return;
  }
  if (execution.kind === "precheck-stopped") {
    reportPrecheckStop(ctx, "ps-repair", execution.result);
    recordProbeCase(recorder, execution.evidence);
    return;
  }

  const { result: probeResult, evidence, verify } = execution;

  reportProbeResult(ctx, probeResult);
  const plan = buildRepairPlan(evidence);
  if (plan.recipes.length === 0) {
    ctx.ui.notify(
      `ps-repair: no whitelist recipe matched ${plan.preview.target}`,
      "warning",
    );
    recordRepairCase(
      recorder,
      evidence,
      createRepairCaseRepairEvent(
        {
          status: "no-recipe",
          plan,
          summary: "no whitelist Repair Recipe matched probe evidence",
          persisted: false,
        },
        { status: "not-offered" },
      ),
    );
    return;
  }

  const previewText = formatRepairPreview(plan.preview);
  const confirmed = await ctx.ui.confirm("确认执行修复？", previewText);
  if (!confirmed) {
    // Keep this probe run's evidence even though no patch was committed.
    recordRepairCase(
      recorder,
      evidence,
      createRepairCaseRepairEvent(
        { status: "cancelled", persisted: false },
        { status: "not-offered" },
      ),
    );
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
    verify,
    configStore: store,
  });

  notifyRepairOutcome(ctx, outcome);

  // Post-success explicit switch (only path that may setModel after repair).
  let switchRecord: RepairCaseSwitchRecord = {
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
          summary: sw.summary,
        };
      } else {
        ctx.ui.notify(sw.message, "error");
        switchRecord = {
          status: "failed",
          target: { ...t },
          summary: sw.message,
        };
      }
    }
  }

  recordRepairCase(
    recorder,
    evidence,
    createRepairCaseRepairEvent(outcome, switchRecord),
  );
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Build the production transport for a command run.
 * Auth failures are surfaced as explicit error results (evidence shows the
 * local cause), never silently downgraded to an anonymous 401/403.
 */
function buildTransport(
  rt: ProbeCommandRuntime,
  ctx: PiSwitchCtx,
  captureObservation: (observation: RawProbeObservation) => void,
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
    onObservation: captureObservation,
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

function recordProbeCase(
  recorder: RepairCaseRecorder,
  evidence: NormalizedProbeRunEvidence,
): void {
  recorder.record(evidence, { kind: "probe" });
}

function recordRepairCase(
  recorder: RepairCaseRecorder,
  evidence: NormalizedProbeRunEvidence,
  event: Extract<Parameters<RepairCaseRecorder["record"]>[1], { kind: "repair" }>,
): void {
  recorder.record(evidence, event);
}
