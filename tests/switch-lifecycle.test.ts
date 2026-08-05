import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createSwitchLifecycle,
  sessionModelFromBranch,
  type SwitchLifecycle,
} from "../extensions/switch-lifecycle.ts";
import { readPiSwitchConfig, readSelection, type FsLike } from "../src/settings.ts";
import type { PiSwitchCtx } from "../src/pi-context.ts";
import type { CcProvider, PiSwitchConfig, RecentEntry } from "../src/types.ts";
import type { Runtime } from "../extensions/runtime.ts";
import { createLocalState } from "../src/local-state.ts";
import { resolveProviderWireCompat } from "../src/provider-wire-compat.ts";

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
  setModelResult?: boolean;
  failSelectionWrite?: boolean;
  failRecentWrite?: boolean;
  failUnregister?: boolean;
  hasUnregister?: boolean;
  /** Active model already set on ctx (Pi restore succeeded). */
  activeModel?: { provider: string; id: string };
  /** Session branch for getBranch (continue/resume model recovery). */
  branch?: Array<Record<string, unknown>>;
  /** Stub for Runtime.providerWireCompatFor (issue #62). */
  providerWireCompatFor?: Runtime["providerWireCompatFor"];
}) {
  const home = "/home/test";
  const settingsPath = `${home}/.pi/agent/settings.json`;
  const configPath = `${home}/.pi/agent/pi-switch.json`;
  const configBody: Record<string, unknown> = options?.recent
    ? { recent: options.recent }
    : {};
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

  const pi = {
    registerProvider: (
      name: string,
      config?: {
        models?: Array<{ id: string; compat?: { supportsStore?: boolean } }>;
      },
    ) => {
      operations.push({
        op: "register",
        name,
        models: config?.models?.map((m) => m.id),
        supportsStore: config?.models?.[0]?.compat?.supportsStore,
      });
    },
    setModel: async () => {
      operations.push({ op: "setModel" });
      return options?.setModelResult ?? true;
    },
    on: (event: string, handler: SessionStartHandler) => {
      if (event === "session_start") sessionStart = handler;
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
  };
  const scheduleCalls: string[] = [];
  const runtime = {
    home,
    state: createLocalState({ fs, home, pid: 1 }),
    config,
    headerRules: [],
    registeredPsNames: ["ps-claude-old"],
    warnedMissingDbId: false,
    lastGoodProviders: providers,
    fsLike: () => fs,
    refreshSnapshot: () => ({ providers }),
    migrateIdentity: () => undefined,
    migrationSummary: undefined,
    reloadConfig: () => config,
    headerOverrideOpts: () => ({}),
    headerVars: () => ({}),
    rejectSink: () => undefined,
    // Trusted maxTokens so registration is eligible under issue #63.
    modelMetaFor: () => ({ maxTokens: 32_000, reasoning: true }),
    modelsDevFor: () => undefined,
    providerWireCompatFor:
      options?.providerWireCompatFor ?? (() => undefined),
    scheduleModelsDevRefresh: (modelId: string) => {
      scheduleCalls.push(modelId);
    },
    scheduleCalls,
  } as unknown as Runtime & { scheduleCalls: string[] };

  const ctx = {
    modelRegistry: {
      find: (name: string, modelId?: string) => {
        operations.push({ op: "find", name });
        return { provider: name, id: modelId ?? "gpt-5" };
      },
    },
    model: options?.activeModel,
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
  };
}

describe("switch lifecycle interface", () => {
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
    const calls = (state.runtime as unknown as { scheduleCalls: string[] }).scheduleCalls;
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
    const calls = (state.runtime as unknown as { scheduleCalls: string[] }).scheduleCalls;
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
      stages: { modelSwitch: { status: "failed" } },
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

  test("resume re-applies session model without rewriting selection", async () => {
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
      activeModel: { provider: "zhipu-glm-en", id: "glm-5.2" },
    });

    state.lifecycle.install();
    state.operations.length = 0;

    await state.getSessionStart()?.({ reason: "startup" }, state.ctx);
    expect(state.operations.map((item) => item.op)).toEqual(["register", "find"]);
    expect(state.operations.some((item) => item.op === "setModel")).toBe(false);
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
