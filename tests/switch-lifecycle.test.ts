import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createSwitchLifecycle,
  type SwitchLifecycle,
} from "../extensions/switch-lifecycle.ts";
import { readSelection, type FsLike } from "../src/settings.ts";
import type { PiSwitchCtx } from "../src/pi-context.ts";
import type { CcProvider, PiSwitchConfig } from "../src/types.ts";
import type { Runtime } from "../extensions/runtime.ts";
import { createLocalState } from "../src/local-state.ts";

type Operation =
  | { op: "register"; name: string }
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
  selection?: { dbId: string; model: string };
  setModelResult?: boolean;
  failSelectionWrite?: boolean;
  failRecentWrite?: boolean;
  failUnregister?: boolean;
  hasUnregister?: boolean;
}) {
  const home = "/home/test";
  const settingsPath = `${home}/.pi/agent/settings.json`;
  const configPath = `${home}/.pi/agent/pi-switch.json`;
  const initial: Record<string, string> = options?.selection
    ? {
        [settingsPath]: JSON.stringify({
          piSwitchSelection: options.selection,
        }),
        [configPath]: "{}",
      }
    : { [configPath]: "{}" };
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
    registerProvider: (name: string) => {
      operations.push({ op: "register", name });
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

  const config: PiSwitchConfig = { recentLimit: 5 };
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
    reloadConfig: () => config,
    headerOverrideOpts: () => ({}),
    headerVars: () => ({}),
    rejectSink: () => undefined,
    modelMetaFor: () => undefined,
  } as unknown as Runtime;

  const ctx = {
    modelRegistry: {
      find: (name: string) => {
        operations.push({ op: "find", name });
        return { provider: name, id: "gpt-5" };
      },
    },
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
    expect(state.runtime.registeredPsNames).toEqual(["ps-codex-new"]);
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
});
