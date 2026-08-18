import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createSwitchLifecycle,
  resolveSessionTarget,
  sessionModelFromBranch,
  type SwitchLifecycleRuntime,
  type SwitchLifecycle,
} from "../extensions/switch-lifecycle.ts";
import { createRegistrationOperations } from "../extensions/registration-operations.ts";
import { readPiSwitchConfig, readSelection } from "../src/settings.ts";
import type { FsLike } from "../src/json-file.ts";
import type { PiSwitchCtx } from "../src/pi-context.ts";
import type {
  CcProvider,
  ModelMetaOverride,
  PiSwitchConfig,
  RecentEntry,
} from "../src/types.ts";
import { createLocalState } from "../src/local-state.ts";
import {
  resolveProviderWireCompat,
  type ResolvedProviderWireCompat,
} from "../src/provider-wire-compat.ts";

type Operation =
  | {
      op: "register";
      name: string;
      models?: string[];
      supportsStore?: boolean;
    }
  | { op: "find"; name: string }
  | { op: "setModel" }
  | { op: "unregister"; name: string };

type SessionStartHandler = (
  event: { reason: string },
  ctx: PiSwitchCtx,
) => Promise<void>;

function provider(
  partial: Partial<CcProvider> = {},
): CcProvider {
  return {
    id: "new",
    piName: "ps-codex-new",
    displayName: "new provider",
    appType: "codex",
    api: "openai-responses",
    baseUrl: "https://example.com",
    apiKey: "key",
    authHeader: true,
    configModels: ["gpt-5"],
    meta: {},
    isCurrentInCc: false,
    ...partial,
  };
}

function memFs(
  initial: Record<string, string> = {},
  failRenameTo: string[] = [],
): FsLike & { store: Record<string, string> } {
  const store = { ...initial };
  return {
    store,
    existsSync: (path) => path in store,
    readFileSync: (path) => {
      if (!(path in store)) throw new Error("missing");
      return store[path];
    },
    writeFileSync: (path, data) => {
      store[path] = data;
    },
    renameSync: (from, to) => {
      if (failRenameTo.includes(to)) throw new Error("disk full");
      store[to] = store[from];
      delete store[from];
    },
    unlinkSync: (path) => {
      delete store[path];
    },
  };
}

function setup(options?: {
  providers?: CcProvider[];
  selection?: { dbId: string; model: string; appType?: string };
  recent?: RecentEntry[];
  config?: PiSwitchConfig;
  setModelResult?: boolean;
  setModelResultFor?: (model: unknown) => boolean;
  emitModelSelectOnSet?: boolean;
  failSelectionWrite?: boolean;
  failRecentWrite?: boolean;
  failUnregister?: boolean;
  hasUnregister?: boolean;
  /** Session model already set on ctx (Pi restore succeeded). */
  sessionModel?: { provider: string; id: string };
  /** Session branch for getBranch (continue/resume model recovery). */
  branch?: Array<Record<string, unknown>>;
  /** Stub for Runtime.providerWireCompatFor (issue #62). */
  providerWireCompatFor?: (
    provider: Pick<CcProvider, "id" | "piName" | "displayName" | "api" | "baseUrl"> & {
      appType?: string;
    },
  ) => ResolvedProviderWireCompat | undefined;
  /** Stub for Runtime.modelMetaFor — return undefined to trigger a #63 skip. */
  modelMetaFor?: (
    provider: Pick<CcProvider, "id" | "piName" | "displayName">,
    modelId?: string,
  ) => ModelMetaOverride | undefined;
  findModel?: (providerName: string, modelId: string) => unknown;
  onRegister?: () => void;
}) {
  const home = "/home/test";
  const settingsPath = `${home}/.pi/agent/settings.json`;
  const configPath = `${home}/.pi/agent/pi-switch.json`;
  const configBody: Record<string, unknown> = {
    ...(options?.recent ? { recent: options.recent } : {}),
    ...(options?.config ?? {}),
  };
  const initial: Record<string, string> = {
    [configPath]: JSON.stringify(configBody),
    ...(options?.selection
      ? {
          [settingsPath]: JSON.stringify({
            piSwitchSelection: options.selection,
          }),
        }
      : {}),
  };
  const fs = memFs(
    initial,
    [
      ...(options?.failSelectionWrite ? [settingsPath] : []),
      ...(options?.failRecentWrite ? [configPath] : []),
    ],
  );
  const operations: Operation[] = [];
  const providers = options?.providers ?? [provider()];
  let sessionStart: SessionStartHandler | undefined;
  let modelSelect: ((event: { model: { provider: string; id: string }; source: string }, ctx: PiSwitchCtx) => void | Promise<void>) | undefined;

  const pi = {
    registerProvider: (
      name: string,
      config?: {
        models?: Array<{ id: string; compat?: { supportsStore?: boolean } }>;
      },
    ) => {
      options?.onRegister?.();
      operations.push({
        op: "register",
        name,
        models: config?.models?.map((m) => m.id),
        supportsStore: config?.models?.[0]?.compat?.supportsStore,
      });
    },
    setModel: async (model: unknown) => {
      operations.push({ op: "setModel" });
      const activated = options?.setModelResultFor
        ? options.setModelResultFor(model)
        : (options?.setModelResult ?? true);
      if (activated && options?.emitModelSelectOnSet) {
        await modelSelect?.(
          {
            model: model as { provider: string; id: string },
            source: "set",
          },
          ctx,
        );
      }
      return activated;
    },
    on: (event: string, handler: SessionStartHandler) => {
      if (event === "session_start") sessionStart = handler;
      if (event === "model_select") modelSelect = handler as unknown as typeof modelSelect;
    },
    ...(options?.hasUnregister === false
      ? {}
      : {
          unregisterProvider: (name: string) => {
            operations.push({ op: "unregister", name });
            if (options?.failUnregister) throw new Error("provider busy");
          },
        }),
  };

  const config: PiSwitchConfig = {
    recentLimit: 5,
    recent: options?.recent,
    ...options?.config,
  };
  const scheduleCalls: string[] = [];
  const modelMetaFor =
    options?.modelMetaFor ??
    (() => ({ maxTokens: 32_000, reasoning: true }));
  const registration = createRegistrationOperations({
    headerRules: () => [],
    headerOverrideOpts: () => ({}),
    headerVars: () => ({}),
    debug: () => false,
    rejectSink: () => undefined,
    // Trusted maxTokens so registration is eligible under issue #63.
    modelMetaFactsFor: (provider, modelId) => ({
      userMeta: modelMetaFor(provider, modelId),
      userMapScopes: {},
    }),
    modelsDevFor: () => undefined,
    providerWireCompatFor: (provider) =>
      options?.providerWireCompatFor?.(provider),
    tupleCompatFor: () => undefined,
  });
  const runtime: SwitchLifecycleRuntime & { scheduleCalls: string[] } = {
    state: createLocalState({ fs, home, pid: 1 }),
    config,
    registeredPsNames: ["ps-claude-old"],
    warnedMissingDbId: false,
    lastGoodProviders: providers,
    refreshSnapshot: () => ({ providers }),
    migrateIdentity: () => undefined,
    registration,
    scheduleModelsDevRefresh: (modelId: string) => {
      scheduleCalls.push(modelId);
    },
    scheduleCalls,
  };

  const ctx = {
    modelRegistry: {
      find: (name: string, modelId?: string) => {
        operations.push({ op: "find", name });
        if (options?.findModel) return options.findModel(name, modelId ?? "gpt-5");
        return { provider: name, id: modelId ?? "gpt-5" };
      },
    },
    model: options?.sessionModel,
    sessionManager: options?.branch
      ? { getBranch: () => options.branch ?? [] }
      : undefined,
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
    },
  } as unknown as PiSwitchCtx;

  const lifecycle: SwitchLifecycle = createSwitchLifecycle(
    pi as unknown as ExtensionAPI,
    runtime,
  );
  return {
    lifecycle,
    runtime,
    ctx,
    fs,
    operations,
    settingsPath,
    configPath,
    getSessionStart: () => sessionStart,
    getModelSelect: () => modelSelect,
  };
}

describe("switch lifecycle interface", () => {
  test("ensureProbeTarget registers a missing model without changing Session Model state", () => {
    let registered = false;
    const state = setup({
      onRegister: () => {
        registered = true;
      },
      findModel: (providerName, modelId) =>
        registered ? { provider: providerName, id: modelId } : undefined,
    });

    const result = state.lifecycle.ensureProbeTarget(
      state.ctx,
      provider(),
      "gpt-5",
    );

    expect(result).toEqual({
      kind: "ready",
      source: "registered",
      model: { provider: "ps-codex-new", id: "gpt-5" },
    });
    expect(state.operations.map((item) => item.op)).toEqual([
      "find",
      "register",
      "find",
    ]);
    expect(state.runtime.registeredPsNames).toEqual(["ps-claude-old"]);
    expect(readSelection(state.fs, state.settingsPath)).toBeUndefined();
    expect(readPiSwitchConfig(state.fs, state.configPath).recent).toBeUndefined();
    expect(state.runtime.scheduleCalls).toEqual(["gpt-5"]);
  });

  test("activate commits register, setModel, cleanup, and selection in order", async () => {
    const state = setup();
    const result = await state.lifecycle.activate(
      { provider: provider(), modelId: "gpt-5", commit: "selection" },
      state.ctx,
    );

    expect(result).toEqual({
      kind: "activated",
      stages: {
        providerRegistration: { status: "succeeded" },
        modelSwitch: { status: "succeeded" },
        providerCleanup: { status: "succeeded" },
        selectionPersistence: { status: "succeeded" },
        recentPersistence: { status: "succeeded" },
      },
    });
    expect(state.operations.map((item) => item.op)).toEqual([
      "register",
      "find",
      "setModel",
      "unregister",
    ]);
    expect(readSelection(state.fs, state.settingsPath)).toMatchObject({
      dbId: "new",
      model: "gpt-5",
    });
    // Composite identity (#16): recents must carry appType or /ps dedupes wrong.
    expect(readPiSwitchConfig(state.fs, state.configPath).recent?.[0]).toMatchObject({
      dbId: "new",
      model: "gpt-5",
      appType: "codex",
    });
    expect(state.runtime.registeredPsNames).toEqual(["ps-codex-new"]);
  });

  test("activate success schedules models.dev refresh once with modelId (#39)", async () => {
    const state = setup();
    await state.lifecycle.activate(
      { provider: provider(), modelId: "gpt-5", commit: "selection" },
      state.ctx,
    );
    const calls = state.runtime.scheduleCalls;
    expect(calls).toEqual(["gpt-5"]);
  });

  test("activate forwards providerWireCompat into registered model compat (#62)", async () => {
    const chatProvider = provider({
      api: "openai-completions",
      baseUrl: "https://relay.example/v1",
      configModels: ["relay-model"],
    });
    const providerWireCompat = resolveProviderWireCompat({
      provider: chatProvider,
      override: { api: "openai-completions", supportsStore: true },
    });
    const state = setup({
      providers: [chatProvider],
      providerWireCompatFor: () => providerWireCompat,
    });

    const result = await state.lifecycle.activate(
      { provider: chatProvider, modelId: "relay-model", commit: "selection" },
      state.ctx,
    );

    expect(result.kind).toBe("activated");
    const registerOp = state.operations.find((item) => item.op === "register");
    expect(registerOp).toMatchObject({
      op: "register",
      name: chatProvider.piName,
      models: ["relay-model"],
      supportsStore: true,
    });
  });

  test("activate register failure does not schedule models.dev refresh (#39)", async () => {
    const state = setup({
      selection: { dbId: "old", model: "old-model" },
    });
    await state.lifecycle.activate(
      {
        provider: provider({ api: null, parseError: "unsupported apiFormat: magic" }),
        modelId: "gpt-5",
        commit: "selection",
      },
      state.ctx,
    );
    const calls = state.runtime.scheduleCalls;
    expect(calls).toEqual([]);
  });

  test("non-switchable provider fails at register without touching pi state", async () => {
    const state = setup({
      selection: { dbId: "old", model: "old-model" },
    });
    const result = await state.lifecycle.activate(
      { provider: provider({ api: null, parseError: "unsupported apiFormat: magic" }), modelId: "gpt-5", commit: "selection" },
      state.ctx,
    );

    expect(result).toMatchObject({
      kind: "failed",
      failedStage: "providerRegistration",
      error: "unsupported apiFormat: magic",
      stages: { providerRegistration: { status: "failed" } },
    });
    expect(state.operations).toEqual([]);
    expect(state.runtime.registeredPsNames).toEqual(["ps-claude-old"]);
    expect(readSelection(state.fs, state.settingsPath)).toMatchObject({
      dbId: "old",
      model: "old-model",
    });
  });

  test("setModel failure leaves previous registrations and selection", async () => {
    const state = setup({
      setModelResult: false,
      selection: { dbId: "old", model: "old-model" },
    });
    const result = await state.lifecycle.activate(
      { provider: provider(), modelId: "gpt-5", commit: "selection" },
      state.ctx,
    );

    expect(result).toMatchObject({
      kind: "failed",
      failedStage: "modelSwitch",
      stages: {
        // Registration ran and succeeded before setModel failed — the recorder
        // must say so, not skipped("not attempted") (spec-review finding).
        providerRegistration: { status: "succeeded" },
        modelSwitch: { status: "failed" },
      },
    });
    expect(state.operations.some((item) => item.op === "unregister")).toBe(false);
    expect(readSelection(state.fs, state.settingsPath)).toMatchObject({
      dbId: "old",
      model: "old-model",
    });
    expect(state.runtime.registeredPsNames).toEqual(["ps-claude-old"]);
  });

  test("missing registered model fails before setModel", async () => {
    const state = setup();
    state.ctx.modelRegistry = { find: () => undefined };
    const result = await state.lifecycle.activate(
      { provider: provider(), modelId: "ghost", commit: "selection" },
      state.ctx,
    );

    expect(result).toMatchObject({
      kind: "failed",
      failedStage: "providerRegistration",
      error: "model not found after register: ps-codex-new / ghost",
    });
    expect(state.operations.some((item) => item.op === "setModel")).toBe(false);
  });

  test("persistence failure keeps activated model and reports partial success", async () => {
    const state = setup({ failSelectionWrite: true });
    const result = await state.lifecycle.activate(
      { provider: provider(), modelId: "gpt-5", commit: "selection" },
      state.ctx,
    );

    expect(result).toMatchObject({
      kind: "activated",
      stages: {
        selectionPersistence: {
          status: "failed",
          error: expect.stringContaining("disk full"),
        },
        recentPersistence: { status: "succeeded" },
      },
    });
    expect(state.operations.some((item) => item.op === "setModel")).toBe(true);
    expect(state.runtime.registeredPsNames).toEqual(["ps-codex-new"]);
  });

  test("recent failure is reported independently from selection persistence", async () => {
    const state = setup({ failRecentWrite: true });
    const result = await state.lifecycle.activate(
      { provider: provider(), modelId: "gpt-5", commit: "selection" },
      state.ctx,
    );

    expect(result).toMatchObject({
      kind: "activated",
      stages: {
        selectionPersistence: { status: "succeeded" },
        recentPersistence: {
          status: "failed",
          error: expect.stringContaining("disk full"),
        },
      },
    });
  });

  test("cleanup failure retains the old registration and reports the stage", async () => {
    const state = setup({ failUnregister: true });
    const result = await state.lifecycle.activate(
      { provider: provider(), modelId: "gpt-5", commit: "selection" },
      state.ctx,
    );

    expect(result).toMatchObject({
      kind: "activated",
      stages: {
        providerCleanup: {
          status: "failed",
          error: "ps-claude-old: provider busy",
        },
      },
    });
    expect(state.runtime.registeredPsNames).toEqual([
      "ps-codex-new",
      "ps-claude-old",
    ]);
  });

  test("runtime-only activation skips selection persistence", async () => {
    const state = setup();
    const result = await state.lifecycle.activate(
      { provider: provider(), modelId: "gpt-5", commit: "runtime-only" },
      state.ctx,
    );

    expect(result).toMatchObject({
      kind: "activated",
      stages: {
        selectionPersistence: {
          status: "skipped",
          reason: "runtime-only activation",
        },
        recentPersistence: {
          status: "skipped",
          reason: "runtime-only activation",
        },
      },
    });
    expect(readSelection(state.fs, state.settingsPath)).toBeUndefined();
  });

  test("runtime-only activation ignores model_select emitted by its own setModel", async () => {
    const saved = provider({
      id: "saved",
      piName: "xkool",
      displayName: "xkool",
      configModels: ["old-model", "new-model"],
    });
    const state = setup({
      providers: [saved],
      selection: { dbId: "saved", model: "old-model", appType: "codex" },
      emitModelSelectOnSet: true,
    });
    state.lifecycle.install();

    const result = await state.lifecycle.activate(
      { provider: saved, modelId: "new-model", commit: "runtime-only" },
      state.ctx,
    );

    expect(result.kind).toBe("activated");
    expect(readSelection(state.fs, state.settingsPath)).toMatchObject({
      dbId: "saved",
      model: "old-model",
    });
  });

  test("install registers saved provider and startup activates it", async () => {
    const saved = provider({ id: "saved", piName: "ps-codex-saved" });
    const state = setup({
      providers: [saved],
      selection: { dbId: "saved", model: "gpt-5" },
    });

    state.lifecycle.install();
    expect(state.operations.map((item) => item.op)).toEqual(["register"]);
    const handler = state.getSessionStart();
    expect(handler).toBeDefined();
    await handler?.({ reason: "startup" }, state.ctx);
    expect(state.operations.map((item) => item.op)).toEqual([
      "register",
      "register",
      "find",
      "setModel",
    ]);
    expect(state.runtime.registeredPsNames).toEqual(["ps-codex-saved"]);
  });

  test("install pre-registers recent providers so session restore can find them", () => {
    const saved = provider({ id: "saved", piName: "xkool", displayName: "xkool" });
    const zhipu = provider({
      id: "zhipu-id",
      piName: "zhipu-glm-en",
      displayName: "Zhipu GLM en",
      configModels: ["glm-5.2"],
    });
    const state = setup({
      providers: [saved, zhipu],
      selection: { dbId: "saved", model: "gpt-5" },
      recent: [
        { dbId: "zhipu-id", model: "glm-5.2", appType: "codex", at: 1 },
        { dbId: "saved", model: "gpt-5", appType: "codex", at: 2 },
      ],
    });

    state.lifecycle.install();

    const registers = state.operations.filter((item) => item.op === "register");
    expect(registers.map((item) => item.name).sort()).toEqual([
      "xkool",
      "zhipu-glm-en",
    ]);
    expect(state.runtime.registeredPsNames.sort()).toEqual([
      "xkool",
      "zhipu-glm-en",
    ]);
  });

  test("install: #63-skipped recent entry is silent but still schedules models.dev refresh", () => {
    const stale = provider({
      id: "stale-id",
      piName: "abrdns",
      displayName: "abrdns",
      configModels: ["mystery-model"],
    });
    const state = setup({
      providers: [stale],
      recent: [{ dbId: "stale-id", model: "mystery-model", appType: "codex", at: 1 }],
      // No trusted maxTokens authority anywhere → registration skips (#63).
      modelMetaFor: () => undefined,
    });

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(" "));
    try {
      state.lifecycle.install();
    } finally {
      console.warn = origWarn;
    }

    // Recent-only pre-registration failure must not nag on every launch...
    expect(warns).toEqual([]);
    // ...but the refresh must fire anyway, or the model can never become
    // registerable (the success-only #39 hook would deadlock the cold cache).
    expect(state.runtime.scheduleCalls).toContain("mystery-model");
  });

  test("install: selection registration failure still warns at launch", () => {
    const broken = provider({
      id: "sel-id",
      piName: "abrdns",
      displayName: "abrdns",
      configModels: ["mystery-model"],
    });
    const state = setup({
      providers: [broken],
      selection: { dbId: "sel-id", model: "mystery-model", appType: "codex" },
      modelMetaFor: () => undefined,
    });

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(" "));
    try {
      state.lifecycle.install();
    } finally {
      console.warn = origWarn;
    }

    expect(warns.some((w) => w.includes("install registration failed"))).toBe(true);
  });

  test("resume with selection-first (default) prefers ps-config selection", async () => {
    const saved = provider({ id: "saved", piName: "xkool", displayName: "xkool" });
    const zhipu = provider({
      id: "zhipu-id",
      piName: "zhipu-glm-en",
      displayName: "Zhipu GLM en",
      configModels: ["glm-5.2"],
    });
    const state = setup({
      providers: [saved, zhipu],
      selection: { dbId: "saved", model: "gpt-5", appType: "codex" },
      recent: [{ dbId: "zhipu-id", model: "glm-5.2", appType: "codex", at: 1 }],
      branch: [
        { type: "model_change", provider: "zhipu-glm-en", modelId: "glm-5.2" },
      ],
      // sessionModelStrategy defaults to "selection-first"
    });

    state.lifecycle.install();
    state.operations.length = 0;

    const handler = state.getSessionStart();
    await handler?.({ reason: "resume" }, state.ctx);

    expect(state.operations.map((item) => item.op)).toEqual([
      "register",
      "find",
      "setModel",
    ]);
    // selection-first uses ps-config selection (xkool), not session (zhipu)
    expect(state.operations[0]).toMatchObject({
      op: "register",
      name: "xkool",
    });
    // Selection stays on the saved value
    expect(readSelection(state.fs, state.settingsPath)).toEqual({
      dbId: "saved",
      model: "gpt-5",
      appType: "codex",
    });
  });

  test("selection-first falls back to session when selection registration fails", async () => {
    const saved = provider({ id: "saved", piName: "xkool", displayName: "xkool" });
    const zhipu = provider({
      id: "zhipu-id",
      piName: "zhipu-glm-en",
      displayName: "Zhipu GLM en",
      configModels: ["glm-5.2"],
    });
    const state = setup({
      providers: [saved, zhipu],
      selection: { dbId: "saved", model: "gpt-5", appType: "codex" },
      branch: [{ type: "model_change", provider: "zhipu-glm-en", modelId: "glm-5.2" }],
      modelMetaFor: (candidate) =>
        candidate.id === "saved" ? undefined : { maxTokens: 32_000, reasoning: true },
    });

    state.lifecycle.install();
    state.operations.length = 0;
    await state.getSessionStart()?.({ reason: "resume" }, state.ctx);

    expect(state.operations.map((item) => item.op)).toEqual([
      "register",
      "find",
      "setModel",
    ]);
    expect(state.operations[0]).toMatchObject({ name: "zhipu-glm-en" });
  });

  test("selection-first falls back to session when selection setModel fails", async () => {
    const saved = provider({ id: "saved", piName: "xkool", displayName: "xkool" });
    const zhipu = provider({
      id: "zhipu-id",
      piName: "zhipu-glm-en",
      displayName: "Zhipu GLM en",
      configModels: ["glm-5.2"],
    });
    const state = setup({
      providers: [saved, zhipu],
      selection: { dbId: "saved", model: "gpt-5", appType: "codex" },
      branch: [{ type: "model_change", provider: "zhipu-glm-en", modelId: "glm-5.2" }],
      setModelResultFor: (model) => (model as { provider?: string }).provider !== "xkool",
    });

    state.lifecycle.install();
    state.operations.length = 0;
    await state.getSessionStart()?.({ reason: "resume" }, state.ctx);

    expect(state.operations.map((item) => item.op)).toEqual([
      "register",
      "find",
      "setModel",
      "register",
      "find",
      "setModel",
    ]);
    expect(state.operations[3]).toMatchObject({ name: "zhipu-glm-en" });
  });

  test("resume with session-first (legacy) prefers session model", async () => {
    const saved = provider({ id: "saved", piName: "xkool", displayName: "xkool" });
    const zhipu = provider({
      id: "zhipu-id",
      piName: "zhipu-glm-en",
      displayName: "Zhipu GLM en",
      configModels: ["glm-5.2"],
    });
    const state = setup({
      providers: [saved, zhipu],
      selection: { dbId: "saved", model: "gpt-5" },
      recent: [{ dbId: "zhipu-id", model: "glm-5.2", appType: "codex", at: 1 }],
      branch: [
        { type: "model_change", provider: "zhipu-glm-en", modelId: "glm-5.2" },
      ],
      config: { sessionModelStrategy: "session-first" },
    });

    state.lifecycle.install();
    state.operations.length = 0;

    const handler = state.getSessionStart();
    await handler?.({ reason: "resume" }, state.ctx);

    expect(state.operations.map((item) => item.op)).toEqual([
      "register",
      "find",
      "setModel",
    ]);
    // session-first uses session model (zhipu)
    expect(state.operations[0]).toMatchObject({
      op: "register",
      name: "zhipu-glm-en",
    });
    // Selection stays on the default, not the session model.
    expect(readSelection(state.fs, state.settingsPath)).toEqual({
      dbId: "saved",
      model: "gpt-5",
    });
  });

  test("session-first falls back to selection when session setModel fails", async () => {
    const saved = provider({ id: "saved", piName: "xkool", displayName: "xkool" });
    const zhipu = provider({
      id: "zhipu-id",
      piName: "zhipu-glm-en",
      displayName: "Zhipu GLM en",
      configModels: ["glm-5.2"],
    });
    const state = setup({
      providers: [saved, zhipu],
      selection: { dbId: "saved", model: "gpt-5", appType: "codex" },
      branch: [{ type: "model_change", provider: "zhipu-glm-en", modelId: "glm-5.2" }],
      config: { sessionModelStrategy: "session-first" },
      setModelResultFor: (model) => (model as { provider?: string }).provider !== "zhipu-glm-en",
    });

    state.lifecycle.install();
    state.operations.length = 0;
    await state.getSessionStart()?.({ reason: "resume" }, state.ctx);

    expect(state.operations.map((item) => item.op)).toEqual([
      "register",
      "find",
      "setModel",
      "register",
      "find",
      "setModel",
    ]);
    expect(state.operations[3]).toMatchObject({ name: "xkool" });
  });

  test("resume with selection-only ignores session model", async () => {
    const saved = provider({ id: "saved", piName: "xkool", displayName: "xkool" });
    const zhipu = provider({
      id: "zhipu-id",
      piName: "zhipu-glm-en",
      displayName: "Zhipu GLM en",
      configModels: ["glm-5.2"],
    });
    const state = setup({
      providers: [saved, zhipu],
      selection: { dbId: "saved", model: "gpt-5", appType: "codex" },
      recent: [{ dbId: "zhipu-id", model: "glm-5.2", appType: "codex", at: 1 }],
      branch: [
        { type: "model_change", provider: "zhipu-glm-en", modelId: "glm-5.2" },
      ],
      config: { sessionModelStrategy: "selection-only" },
    });

    state.lifecycle.install();
    state.operations.length = 0;

    const handler = state.getSessionStart();
    await handler?.({ reason: "resume" }, state.ctx);

    expect(state.operations.map((item) => item.op)).toEqual([
      "register",
      "find",
      "setModel",
    ]);
    // selection-only ONLY uses ps-config selection
    expect(state.operations[0]).toMatchObject({
      op: "register",
      name: "xkool",
    });
  });

  test("selection-only does not fall back to session after activation failure", async () => {
    const saved = provider({ id: "saved", piName: "xkool", displayName: "xkool" });
    const zhipu = provider({
      id: "zhipu-id",
      piName: "zhipu-glm-en",
      displayName: "Zhipu GLM en",
      configModels: ["glm-5.2"],
    });
    const state = setup({
      providers: [saved, zhipu],
      selection: { dbId: "saved", model: "gpt-5", appType: "codex" },
      branch: [{ type: "model_change", provider: "zhipu-glm-en", modelId: "glm-5.2" }],
      config: { sessionModelStrategy: "selection-only" },
      setModelResult: false,
    });

    state.lifecycle.install();
    state.operations.length = 0;
    await state.getSessionStart()?.({ reason: "resume" }, state.ctx);

    expect(state.operations.map((item) => item.op)).toEqual([
      "register",
      "find",
      "setModel",
    ]);
    expect(state.operations.some((item) => item.op === "register" && item.name === "zhipu-glm-en")).toBe(false);
  });

  test("fork (subagent) with selection-first uses ps-config selection", async () => {
    const saved = provider({ id: "saved", piName: "xkool", displayName: "xkool" });
    const zhipu = provider({
      id: "zhipu-id",
      piName: "zhipu-glm-en",
      displayName: "Zhipu GLM en",
      configModels: ["glm-5.2"],
    });
    const state = setup({
      providers: [saved, zhipu],
      selection: { dbId: "saved", model: "gpt-5", appType: "codex" },
      branch: [
        { type: "model_change", provider: "zhipu-glm-en", modelId: "glm-5.2" },
      ],
      // Default strategy is selection-first
    });

    state.lifecycle.install();
    state.operations.length = 0;

    const handler = state.getSessionStart();
    await handler?.({ reason: "fork" }, state.ctx);

    expect(state.operations.map((item) => item.op)).toEqual([
      "register",
      "find",
      "setModel",
    ]);
    // fork uses ps-config selection, ignoring parent session model
    expect(state.operations[0]).toMatchObject({
      op: "register",
      name: "xkool",
    });
  });

  test("fork (subagent) with session-first uses session model", async () => {
    const saved = provider({ id: "saved", piName: "xkool", displayName: "xkool" });
    const zhipu = provider({
      id: "zhipu-id",
      piName: "zhipu-glm-en",
      displayName: "Zhipu GLM en",
      configModels: ["glm-5.2"],
    });
    const state = setup({
      providers: [saved, zhipu],
      selection: { dbId: "saved", model: "gpt-5", appType: "codex" },
      branch: [
        { type: "model_change", provider: "zhipu-glm-en", modelId: "glm-5.2" },
      ],
      config: { sessionModelStrategy: "session-first" },
    });

    state.lifecycle.install();
    state.operations.length = 0;

    const handler = state.getSessionStart();
    await handler?.({ reason: "fork" }, state.ctx);

    expect(state.operations.map((item) => item.op)).toEqual([
      "register",
      "find",
      "setModel",
    ]);
    // session-first honors session model even for fork
    expect(state.operations[0]).toMatchObject({
      op: "register",
      name: "zhipu-glm-en",
    });
  });

  test("fork (subagent) with selection-only ignores parent session model", async () => {
    const saved = provider({ id: "saved", piName: "xkool", displayName: "xkool" });
    const zhipu = provider({
      id: "zhipu-id",
      piName: "zhipu-glm-en",
      displayName: "Zhipu GLM en",
      configModels: ["glm-5.2"],
    });
    const state = setup({
      providers: [saved, zhipu],
      selection: { dbId: "saved", model: "gpt-5", appType: "codex" },
      branch: [
        { type: "model_change", provider: "zhipu-glm-en", modelId: "glm-5.2" },
      ],
      config: { sessionModelStrategy: "selection-only" },
    });

    state.lifecycle.install();
    state.operations.length = 0;

    const handler = state.getSessionStart();
    await handler?.({ reason: "fork" }, state.ctx);

    expect(state.operations.map((item) => item.op)).toEqual([
      "register",
      "find",
      "setModel",
    ]);
    // selection-only: subagent gets the ps-config selection, never the parent's model
    expect(state.operations[0]).toMatchObject({
      op: "register",
      name: "xkool",
    });
  });

  test("startup skips setModel when Pi already restored the session model", async () => {
    const zhipu = provider({
      id: "zhipu-id",
      piName: "zhipu-glm-en",
      displayName: "Zhipu GLM en",
      configModels: ["glm-5.2"],
    });
    const state = setup({
      providers: [zhipu],
      selection: { dbId: "zhipu-id", model: "glm-5.2" },
      branch: [
        { type: "model_change", provider: "zhipu-glm-en", modelId: "glm-5.2" },
      ],
      sessionModel: { provider: "zhipu-glm-en", id: "glm-5.2" },
    });

    state.lifecycle.install();
    state.operations.length = 0;

    await state.getSessionStart()?.({ reason: "startup" }, state.ctx);
    expect(state.operations.map((item) => item.op)).toEqual(["register", "find"]);
    expect(state.operations.some((item) => item.op === "setModel")).toBe(false);
  });

  test("native model_select persists user changes but ignores restore", async () => {
    const saved = provider({ id: "saved", piName: "xkool", displayName: "xkool" });
    const state = setup({
      providers: [saved],
      selection: { dbId: "saved", model: "old-model", appType: "codex" },
    });
    state.lifecycle.install();

    await state.getModelSelect()?.(
      { model: { provider: "xkool", id: "new-model" }, source: "set" },
      state.ctx,
    );
    expect(readSelection(state.fs, state.settingsPath)).toMatchObject({
      dbId: "saved",
      model: "new-model",
      provider: "xkool",
    });

    await state.getModelSelect()?.(
      { model: { provider: "xkool", id: "restored-model" }, source: "restore" },
      state.ctx,
    );
    expect(readSelection(state.fs, state.settingsPath)).toMatchObject({
      dbId: "saved",
      model: "new-model",
    });
  });
});

describe("sessionModelFromBranch", () => {
  test("returns last model_change", () => {
    expect(
      sessionModelFromBranch([
        { type: "model_change", provider: "a", modelId: "m1" },
        { type: "model_change", provider: "zhipu-glm-en", modelId: "glm-5.2" },
      ]),
    ).toEqual({ provider: "zhipu-glm-en", modelId: "glm-5.2" });
  });

  test("assistant message updates model after model_change", () => {
    expect(
      sessionModelFromBranch([
        { type: "model_change", provider: "a", modelId: "m1" },
        {
          type: "message",
          message: { role: "assistant", provider: "b", model: "m2" },
        },
      ]),
    ).toEqual({ provider: "b", modelId: "m2" });
  });

  test("empty branch yields undefined", () => {
    expect(sessionModelFromBranch([])).toBeUndefined();
    expect(sessionModelFromBranch(undefined)).toBeUndefined();
  });
});

describe("resolveSessionTarget (pure function)", () => {
  const providers: CcProvider[] = [
    provider({ id: "p1", piName: "ps-codex-p1", appType: "codex", configModels: ["m1"] }),
    provider({ id: "p2", piName: "ps-claude-p2", appType: "claude", configModels: ["m2"] }),
  ];

  test("selection-first (default): uses selection when available", () => {
    const result = resolveSessionTarget(
      "selection-first",
      providers,
      { dbId: "p1", model: "m1", appType: "codex" },
      { provider: "ps-claude-p2", modelId: "m2" },
    );
    expect(result?.provider.id).toBe("p1");
    expect(result?.modelId).toBe("m1");
    expect(result?.source).toBe("selection");
  });

  test("selection-first: falls back to session when selection unavailable", () => {
    const result = resolveSessionTarget(
      "selection-first",
      providers,
      { dbId: "missing", model: "m999", appType: "codex" },
      { provider: "ps-claude-p2", modelId: "m2" },
    );
    expect(result?.provider.id).toBe("p2");
    expect(result?.modelId).toBe("m2");
    expect(result?.source).toBe("session");
  });

  test("session-first: uses session when available", () => {
    const result = resolveSessionTarget(
      "session-first",
      providers,
      { dbId: "p1", model: "m1", appType: "codex" },
      { provider: "ps-claude-p2", modelId: "m2" },
    );
    expect(result?.provider.id).toBe("p2");
    expect(result?.modelId).toBe("m2");
    expect(result?.source).toBe("session");
  });

  test("session-first: falls back to selection when session unavailable", () => {
    const result = resolveSessionTarget(
      "session-first",
      providers,
      { dbId: "p1", model: "m1", appType: "codex" },
      { provider: "ps-missing", modelId: "m999" },
    );
    expect(result?.provider.id).toBe("p1");
    expect(result?.modelId).toBe("m1");
    expect(result?.source).toBe("selection");
  });

  test("selection-only: ignores session entirely", () => {
    const result = resolveSessionTarget(
      "selection-only",
      providers,
      { dbId: "p1", model: "m1", appType: "codex" },
      { provider: "ps-claude-p2", modelId: "m2" },
    );
    expect(result?.provider.id).toBe("p1");
    expect(result?.modelId).toBe("m1");
    expect(result?.source).toBe("selection");
  });

  test("selection-only: returns undefined when selection unavailable", () => {
    const result = resolveSessionTarget(
      "selection-only",
      providers,
      { dbId: "missing", model: "m999", appType: "codex" },
      { provider: "ps-claude-p2", modelId: "m2" },
    );
    expect(result).toBeUndefined();
  });

  test("undefined strategy defaults to selection-first", () => {
    const result = resolveSessionTarget(
      undefined,
      providers,
      { dbId: "p1", model: "m1", appType: "codex" },
      { provider: "ps-claude-p2", modelId: "m2" },
    );
    expect(result?.provider.id).toBe("p1");
    expect(result?.source).toBe("selection");
  });

  test("no selection and no session returns undefined", () => {
    const result = resolveSessionTarget("selection-first", providers, undefined, undefined);
    expect(result).toBeUndefined();
  });

  test("matches provider by appType when provided", () => {
    const result = resolveSessionTarget(
      "selection-first",
      providers,
      { dbId: "p1", model: "m1", appType: "claude" }, // Wrong appType
      undefined,
    );
    expect(result).toBeUndefined(); // Should not match p1 (codex) when appType is claude
  });
});
