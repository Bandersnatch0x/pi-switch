/**
 * Command-level flow tests for /ps-probe and /ps-repair.
 *
 * Exercises the full orchestration inside runProbeCommand / runRepairCommand:
 * target resolve → doctor precheck → probe → confirm → verify → CAS → switch
 * → Repair Case record. Zero network and zero FS writes: transport, config
 * store and precheck are injected, and rt/ctx/pi/lifecycle are stubbed.
 */
import { describe, expect, test } from "bun:test";
import {
  runProbeCommand,
  runRepairCommand,
  type ProbeCommandDeps,
} from "../extensions/probe-commands.ts";
import { registerCommands } from "../extensions/commands.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../extensions/runtime.ts";
import type { SwitchLifecycle } from "../extensions/switch-lifecycle.ts";
import type { PiSwitchCtx } from "../src/pi-context.ts";
import type { FsLike } from "../src/json-file.ts";
import type { CcProvider } from "../src/types.ts";
import type {
  ProbeRunPrecheckSnapshot,
  ProbeRequest,
  ProbeTransport,
  ProbeTransportResult,
  RepairConfigStore,
} from "../src/probe/index.ts";

// ── fakes ───────────────────────────────────────────────────────────────────

function provider(id: string, name: string, appType = "codex"): CcProvider {
  return {
    id,
    piName: `ps-${id}`,
    displayName: name,
    appType,
    api: "openai-responses",
    baseUrl: "https://x",
    apiKey: "k",
    authHeader: true,
    configModels: ["m1"],
    meta: {},
    isCurrentInCc: false,
  } as CcProvider;
}

function okText(text = "probe_ok"): ProbeTransportResult {
  return {
    httpStatus: 200,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    },
  };
}

function okTool(): ProbeTransportResult {
  return {
    httpStatus: 200,
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc1",
          name: "probe_echo",
          arguments: { msg: "probe_ok" },
        },
      ],
      stopReason: "toolUse",
    },
  };
}

function reasoningRejected(): ProbeTransportResult {
  // Recipe1 signature: reasoning / thinking + unsupported wording.
  // No httpStatus — evaluateContract reads stopReason:"error" + errorMessage
  // into the stage summary (status >=400 would short-circuit via classifyHttpStatus).
  return {
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "reasoning parameter not supported",
    },
  };
}

/** Transport where basic+tool pass but reasoning fails (drives Recipe1). */
function recipe1Transport() {
  const calls: ProbeRequest[] = [];
  const transport: ProbeTransport = async (req) => {
    calls.push(req);
    if (req.contract === "basic") return okText();
    if (req.contract === "tool") return okTool();
    if (req.contract === "reasoning") return reasoningRejected();
    throw new Error(`unexpected contract ${req.contract}`);
  };
  return { transport, calls };
}

/** Transport where every contract passes (yields no recipe). */
async function allPassTransport(req: ProbeRequest): Promise<ProbeTransportResult> {
  if (req.contract === "basic") return okText();
  if (req.contract === "tool") return okTool();
  if (req.contract === "reasoning") return okText();
  throw new Error(`unexpected contract ${req.contract}`);
}

function makeRt(
  providers: CcProvider[],
  opts: { reasoning?: boolean } = {},
): Runtime {
  return {
    reloadConfig: () => undefined,
    refreshSnapshot: () => ({ providers, error: undefined }),
    readSelectionCached: () => undefined,
    config: { providerOverrides: {} },
    modelMetaFor: () => (opts.reasoning ? { reasoning: true } : undefined),
    headerRules: [],
    headerOverrideOpts: () => ({}),
    rejectSink: () => undefined,
    modelsDevFor: () => undefined,
    headerVars: () => ({}),
    home: "/home/user",
    fsLike: (): FsLike =>
      ({
        existsSync: () => false,
        readFileSync: () => "",
      }) as unknown as FsLike,
    io: { existsSync: () => false } as unknown as Runtime["io"],
    routingProbe: async () => undefined,
  } as unknown as Runtime;
}

function makeCtx(
  overrides: {
    mode?: string;
    model?: { provider?: string; id?: string };
    findModel?: () => unknown;
    confirm?: (title: string, message: string) => Promise<boolean>;
    select?: (title: string, options: string[]) => Promise<string | undefined>;
  } = {},
): { ctx: PiSwitchCtx; msgs: Array<{ msg: string; level: string }> } {
  const msgs: Array<{ msg: string; level: string }> = [];
  const ctx = {
    mode: overrides.mode ?? "tui",
    model: overrides.model ?? { provider: "ps-p1", id: "m1" },
    modelRegistry: {
      find: () =>
        overrides.findModel
          ? overrides.findModel()
          : { id: "m1", api: "anthropic-messages" },
    },
    ui: {
      notify: (msg: string, level: string) => msgs.push({ msg, level }),
      confirm: overrides.confirm ?? (async () => true),
      select: overrides.select,
    },
  } as unknown as PiSwitchCtx;
  return { ctx, msgs };
}

function makePi(registerProvider?: () => void) {
  const sent: unknown[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  return {
    pi: {
      sendMessage: (m: unknown) => sent.push(m),
      appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
      ...(registerProvider ? { registerProvider } : {}),
    } as unknown as ExtensionAPI,
    sent,
    entries,
  };
}

function makeLifecycle(activateImpl?: () => unknown) {
  const activated: unknown[] = [];
  return {
    lifecycle: {
      activate: async (target: unknown, _ctx: PiSwitchCtx) => {
        activated.push(target);
        if (activateImpl) return activateImpl();
        return { kind: "activated" };
      },
    } as unknown as SwitchLifecycle,
    activated,
  };
}

function makeStore(commitResult?: unknown) {
  const commits: unknown[] = [];
  return {
    store: {
      read: async () => ({ version: "v1" }),
      commit: async (input: unknown) => {
        commits.push(input);
        return (commitResult ?? { ok: true, version: "v2" }) as never;
      },
    } as unknown as RepairConfigStore,
    commits,
  };
}

const precheckPass = async (): Promise<ProbeRunPrecheckSnapshot | undefined> =>
  undefined;
const precheckFail = async (): Promise<ProbeRunPrecheckSnapshot> => ({
  status: "fail",
  allowProbe: false,
  checks: [],
  summary: "doctor failed",
});

// ── slash registration ──────────────────────────────────────────────────────

describe("registerCommands (probe/repair wiring)", () => {
  function captureCommands() {
    const commands = new Map<
      string,
      {
        description: string;
        handler: (args: string, ctx: PiSwitchCtx) => Promise<void> | void;
      }
    >();
    const pi = {
      registerCommand: (
        name: string,
        command: {
          description: string;
          handler: (args: string, ctx: PiSwitchCtx) => Promise<void> | void;
        },
      ) => commands.set(name, command),
    } as unknown as ExtensionAPI;
    const rt = { config: { aliasCcs: false } } as unknown as Runtime;
    const lifecycle = makeLifecycle().lifecycle;
    registerCommands(pi, rt, lifecycle);
    return { commands, pi, rt, lifecycle };
  }

  test("registers ps-probe and ps-repair with descriptions + handlers", () => {
    const { commands } = captureCommands();
    const probe = commands.get("ps-probe");
    const repair = commands.get("ps-repair");

    expect(probe).toBeDefined();
    expect(probe?.description).toContain("兼容性探针");
    expect(typeof probe?.handler).toBe("function");
    expect(repair).toBeDefined();
    expect(repair?.description).toContain("证据驱动修复");
    expect(typeof repair?.handler).toBe("function");
  });

  test("registered ps-repair handler forwards headless rejection", async () => {
    const { commands } = captureCommands();
    const { ctx, msgs } = makeCtx({ mode: "json" });

    await commands.get("ps-repair")!.handler("", ctx);

    expect(msgs).toEqual([
      {
        msg: "ps-repair requires interactive confirmation; headless is not allowed",
        level: "error",
      },
    ]);
  });
});

// ── /ps-probe ───────────────────────────────────────────────────────────────

describe("runProbeCommand (command flow)", () => {
  const providers = [provider("p1", "Relay One")];

  test("success: probes, notifies info, records a Repair Case", async () => {
    const { transport, calls } = recipe1Transport();
    const { pi, entries } = makePi();
    const { ctx, msgs } = makeCtx();

    await runProbeCommand(pi, makeRt(providers), ctx, {
      transport,
      buildPrecheck: precheckPass,
    });

    // Basic + tool probed (reasoning skipped: target does not claim it).
    expect(calls.map((c) => c.contract)).toEqual(["basic", "tool"]);
    // A result was emitted (info for ok, warning for partial failure here).
    expect(msgs.length).toBeGreaterThan(0);
    // Case recorded: summary sent + detail entry appended.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("ps-repair-case-detail");
  });

  test("RPC picker can probe a non-session target without switching the session model", async () => {
    const providers = [provider("p1", "Relay One"), provider("p2", "Relay Two")];
    const calls: ProbeRequest[] = [];
    const transport: ProbeTransport = async (req) => {
      calls.push(req);
      if (req.contract === "tool") return okTool();
      return okText();
    };
    const { pi } = makePi();
    const { ctx } = makeCtx({
      mode: "rpc",
      select: async (title, options) => {
        if (title === "选择类型") return options[0];
        if (title.includes("选择名称")) {
          return options.find((option) => option.startsWith("Relay Two"));
        }
        return options.find((option) => option === "m1");
      },
    });

    await runProbeCommand(pi, makeRt(providers), ctx, {
      transport,
      buildPrecheck: precheckPass,
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.target.provider === "ps-p2")).toBe(true);
    expect(ctx.model?.provider).toBe("ps-p1");
  });

  test("effective global compat modes enrich the production probe target", async () => {
    const claude = {
      ...provider("p1", "Anyrouter"),
      api: "anthropic-messages" as const,
      baseUrl: "https://anyrouter.top",
    };
    const rt = makeRt([claude]);
    rt.config = {
      providerOverrides: {},
      claudeCodeCompat: { mode: "auto" },
    };
    const calls: ProbeRequest[] = [];
    const { pi } = makePi();
    const { ctx } = makeCtx({ mode: "tui" });

    await runProbeCommand(pi, rt, ctx, {
      transport: async (req) => {
        calls.push(req);
        if (req.contract === "tool") return okTool();
        return okText();
      },
      buildPrecheck: precheckPass,
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.target.claudeCodeCompat === true)).toBe(true);
  });

  test("missing registry model is registered for probing without setModel", async () => {
    let registered = false;
    const { pi, entries } = makePi(() => {
      registered = true;
    });
    const { ctx } = makeCtx({
      mode: "tui",
      findModel: () =>
        registered ? { id: "m1", api: "openai-responses" } : undefined,
    });
    const calls: ProbeRequest[] = [];

    await runProbeCommand(pi, makeRt(providers), ctx, {
      transport: async (req) => {
        calls.push(req);
        if (req.contract === "tool") return okTool();
        return okText();
      },
      buildPrecheck: precheckPass,
    });

    expect(registered).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(ctx.model?.provider).toBe("ps-p1");
    expect(entries).toHaveLength(1);
  });

  test("model not found in registry → error notify, no case recorded", async () => {
    const { pi, entries } = makePi();
    const { ctx, msgs } = makeCtx({ findModel: () => undefined });
    const transportSpy = { transport: async () => okText() };

    await runProbeCommand(pi, makeRt(providers), ctx, {
      transport: transportSpy.transport,
      buildPrecheck: precheckPass,
    });

    expect(msgs.some((m) => m.msg.includes("model not found in pi registry"))).toBe(true);
    expect(msgs[msgs.length - 1]!.level).toBe("error");
    expect(entries).toHaveLength(0);
  });

  test("doctor precheck fail → blocks probing (error), no network", async () => {
    const { pi, entries } = makePi();
    const { ctx, msgs } = makeCtx();
    let calls = 0;
    const transport: ProbeTransport = async () => {
      calls += 1;
      return okText();
    };

    await runProbeCommand(pi, makeRt(providers), ctx, {
      transport,
      buildPrecheck: precheckFail,
    });

    expect(calls).toBe(0);
    expect(msgs.some((m) => m.msg.startsWith("ps-probe stopped"))).toBe(true);
    expect(msgs[msgs.length - 1]!.level).toBe("error");
    expect(entries).toHaveLength(0);
  });

  test("unresolvable target → error notify, no case", async () => {
    const { pi, entries } = makePi();
    // Session model references a provider absent from the snapshot.
    const { ctx, msgs } = makeCtx({ model: { provider: "ps-nope", id: "m1" } });
    const transportSpy = { transport: async () => okText() };

    await runProbeCommand(pi, makeRt(providers), ctx, {
      transport: transportSpy.transport,
      buildPrecheck: precheckPass,
    });

    expect(msgs[msgs.length - 1]!.level).toBe("error");
    expect(entries).toHaveLength(0);
  });

  test("headless (json) mode still probes and records (spec: structured output)", async () => {
    const { pi, entries } = makePi();
    const { ctx, msgs } = makeCtx({ mode: "json" });
    const log = console.log.bind(console);
    let jsonOut = "";
    console.log = (m?: unknown) => {
      if (typeof m === "string") jsonOut = m;
      return undefined as never;
    };
    try {
      await runProbeCommand(pi, makeRt(providers), ctx, {
        transport: allPassTransport,
        buildPrecheck: precheckPass,
      });
    } finally {
      console.log = log;
    }
    expect(msgs.length).toBeGreaterThan(0);
    expect(entries).toHaveLength(1);
    expect(jsonOut.length).toBeGreaterThan(0);
  });
});

// ── /ps-repair ──────────────────────────────────────────────────────────────

describe("runRepairCommand (command flow)", () => {
  const providers = [provider("p1", "Relay One")];
  // reasoning:true so the reasoning contract runs and Recipe1 evidence forms.
  const rt = makeRt(providers, { reasoning: true });

  test("headless (json) mode rejected → error, no probe/commit", async () => {
    const { pi, entries } = makePi();
    const { ctx, msgs } = makeCtx({ mode: "json" });
    const { transport, calls } = recipe1Transport();
    const { store, commits } = makeStore();

    await runRepairCommand(pi, rt, makeLifecycle().lifecycle, ctx, {
      transport,
      configStore: store,
      buildPrecheck: precheckPass,
    });

    expect(calls).toHaveLength(0);
    expect(commits).toHaveLength(0);
    expect(msgs.some((m) => m.msg.includes("requires interactive confirmation"))).toBe(true);
    expect(entries).toHaveLength(0);
  });

  test("no matching recipe → warning, case recorded, zero commit", async () => {
    const { pi, entries } = makePi();
    const { ctx, msgs } = makeCtx();
    const { store, commits } = makeStore();

    await runRepairCommand(pi, rt, makeLifecycle().lifecycle, ctx, {
      transport: allPassTransport,
      configStore: store,
      buildPrecheck: precheckPass,
    });

    expect(msgs.some((m) => m.msg.includes("no whitelist recipe matched"))).toBe(true);
    expect(msgs[msgs.length - 1]!.level).toBe("warning");
    expect(commits).toHaveLength(0);
    expect(entries).toHaveLength(1);
  });

  test("user cancels plan → cancelled notify, case recorded, zero commit", async () => {
    const { pi, entries } = makePi();
    const { ctx, msgs } = makeCtx({ confirm: async () => false });
    const { transport } = recipe1Transport();
    const { store, commits } = makeStore();

    await runRepairCommand(pi, rt, makeLifecycle().lifecycle, ctx, {
      transport,
      configStore: store,
      buildPrecheck: precheckPass,
    });

    expect(commits).toHaveLength(0);
    expect(msgs.some((m) => m.msg.includes("cancelled"))).toBe(true);
    expect(msgs[msgs.length - 1]!.level).toBe("info");
    expect(entries).toHaveLength(1); // probe evidence kept
  });

  test("confirmation preview names every affected model", async () => {
    let preview = "";
    const { pi } = makePi();
    const { ctx } = makeCtx({
      confirm: async (_title, message) => {
        preview = message;
        return false;
      },
    });
    const { transport } = recipe1Transport();

    await runRepairCommand(pi, rt, makeLifecycle().lifecycle, ctx, {
      transport,
      configStore: makeStore().store,
      buildPrecheck: precheckPass,
    });

    expect(preview).toContain("影响模型");
    expect(preview).toContain("m1");
  });

  test("confirmed → verify twice → CAS commit → explicit switch accepted", async () => {
    const { pi, entries, sent } = makePi();
    const { ctx, msgs } = makeCtx({ confirm: async () => true });
    const { transport, calls } = recipe1Transport();
    const { store, commits } = makeStore();
    const { lifecycle, activated } = makeLifecycle();

    await runRepairCommand(pi, rt, lifecycle, ctx, {
      transport,
      configStore: store,
      buildPrecheck: precheckPass,
    });

    // Initial probe: basic + reasoning (reasoning fails → tool halted).
    // Then 2 verify passes, each probing basic + tool on the candidate.
    expect(calls.filter((c) => c.contract === "reasoning")).toHaveLength(1);
    expect(calls.filter((c) => c.contract === "basic")).toHaveLength(3); // 1 initial + 2 verify
    expect(calls.filter((c) => c.contract === "tool")).toHaveLength(2); // 2 verify
    expect(commits).toHaveLength(1);
    expect(msgs.some((m) => m.msg.includes("ps-repair committed"))).toBe(true);
    // Explicit switch went through the lifecycle (session model change path).
    expect(activated).toHaveLength(1);
    expect(entries).toHaveLength(1);
    const detail = entries[0]!.data as {
      repair?: {
        status: string;
        persisted: boolean;
        verificationAttempts: unknown[];
        switch?: { status: string };
      };
    };
    expect(detail.repair?.status).toBe("committed");
    expect(detail.repair?.persisted).toBe(true);
    expect(detail.repair?.verificationAttempts).toHaveLength(2);
    expect(detail.repair?.switch?.status).toBe("succeeded");
    expect(JSON.stringify(sent)).toContain("repair=committed");
  });

  test("confirmed + commit → switch declined → no lifecycle activation", async () => {
    const confirmValues = [true, false]; // plan yes, switch no
    const { pi } = makePi();
    const { ctx } = makeCtx({
      confirm: async () => (confirmValues.length ? confirmValues.shift()! : true),
    });
    const { transport } = recipe1Transport();
    const { store, commits } = makeStore();
    const { lifecycle, activated } = makeLifecycle();

    await runRepairCommand(pi, rt, lifecycle, ctx, {
      transport,
      configStore: store,
      buildPrecheck: precheckPass,
    });

    expect(commits).toHaveLength(1); // repair committed
    expect(activated).toHaveLength(0); // but user declined the switch
  });

  test("CAS conflict → error notify, no switch, no overwrite", async () => {
    const { pi, entries } = makePi();
    const { ctx, msgs } = makeCtx();
    const { transport } = recipe1Transport();
    const { store, commits } = makeStore({
      ok: false,
      reason: "conflict",
      message: "config changed externally during repair",
    } as never);
    const { lifecycle, activated } = makeLifecycle();

    await runRepairCommand(pi, rt, lifecycle, ctx, {
      transport,
      configStore: store,
      buildPrecheck: precheckPass,
    });

    expect(commits).toHaveLength(1);
    expect(msgs.some((m) => m.msg.includes("ps-repair cas-conflict"))).toBe(true);
    expect(msgs[msgs.length - 1]!.level).toBe("error");
    expect(activated).toHaveLength(0);
    expect(entries).toHaveLength(1);
    const detail = entries[0]!.data as {
      repair?: { status: string; verificationAttempts: unknown[] };
    };
    expect(detail.repair?.status).toBe("cas-conflict");
    expect(detail.repair?.verificationAttempts).toHaveLength(2);
  });

  test("commit error → error notify, case recorded with attempts, no switch", async () => {
    const { pi, entries } = makePi();
    const { ctx, msgs } = makeCtx();
    const { transport } = recipe1Transport();
    // Store returns a non-conflict write error (disk-full / permission / parse).
    const { store, commits } = makeStore({
      ok: false,
      reason: "error",
      message: "disk full while persisting repair candidate",
    } as never);
    const { lifecycle, activated } = makeLifecycle();

    await runRepairCommand(pi, rt, lifecycle, ctx, {
      transport,
      configStore: store,
      buildPrecheck: precheckPass,
    });

    expect(commits).toHaveLength(1);
    expect(msgs.some((m) => m.msg.includes("ps-repair commit-error"))).toBe(true);
    expect(msgs.some((m) => m.msg.includes("disk full"))).toBe(true);
    expect(msgs[msgs.length - 1]!.level).toBe("error");
    expect(activated).toHaveLength(0);
    expect(entries).toHaveLength(1);
    const detail = entries[0]!.data as {
      repair?: {
        status: string;
        persisted: boolean;
        verificationAttempts: unknown[];
      };
    };
    expect(detail.repair?.status).toBe("commit-error");
    expect(detail.repair?.persisted).toBe(false);
    // Commit error still carries the 2 verification attempts for durability.
    expect(detail.repair?.verificationAttempts).toHaveLength(2);
  });
});
