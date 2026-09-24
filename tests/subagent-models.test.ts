import { describe, expect, test } from "bun:test";
import type { FsLike } from "../src/json-file.ts";
import {
  listSubagentAgents,
  parseAgentFrontmatter,
  overrideCount,
  planSubagentRows,
  readSubagentSettings,
  resolveSubagentRow,
  writeSubagentModel,
  type SubagentAgentDefinition,
} from "../src/subagent-models.ts";
import { formatSubagentRows, runSubagentModelFlow } from "../src/ui/subagent-model-pick.ts";
import { formatFooterHints } from "../src/ui/three-level-pick.ts";
import { getLocale, setLocale, t, tf } from "../src/ui/tui-locale.ts";
import type { PiSwitchCtx } from "../src/pi-context.ts";

const SETTINGS = "/home/.pi/agent/settings.json";

function memFs(initial: Record<string, string> = {}): FsLike & {
  store: Record<string, string>;
} {
  const store = { ...initial };
  return {
    store,
    existsSync: (path) => path in store,
    readFileSync: (path) => {
      if (!(path in store)) throw new Error(`ENOENT: ${path}`);
      return store[path]!;
    },
    writeFileSync: (path, data) => {
      store[path] = data;
    },
    renameSync: (from, to) => {
      store[to] = store[from]!;
      delete store[from];
    },
    unlinkSync: (path) => {
      delete store[path];
    },
  };
}

function discoveryFs(files: Record<string, string>) {
  const dirs = new Map<string, string[]>();
  for (const path of Object.keys(files)) {
    const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const dir = path.slice(0, index);
    dirs.set(dir, [...(dirs.get(dir) ?? []), path.slice(index + 1)]);
  }
  return {
    existsSync: (path: string) => dirs.has(path) || path in files,
    readdirSync: (path: string) => dirs.get(path) ?? [],
    readFileSync: (path: string) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path]!;
    },
  };
}

function agentMd(name: string, extra = ""): string {
  return `---\nname: ${name}\n${extra}---\nbody\n`;
}

function readSettings(fs: FsLike & { store: Record<string, string> }): Record<string, unknown> {
  const source = fs.store[SETTINGS];
  return source ? (JSON.parse(source) as Record<string, unknown>) : {};
}

describe("agent frontmatter", () => {
  test("reads name and model from the leading block", () => {
    expect(parseAgentFrontmatter(agentMd("reviewer", "model: radius/deepseek-v4.1-flash\n"))).toEqual({
      name: "reviewer",
      model: "radius/deepseek-v4.1-flash",
    });
  });

  test("quoted values are unwrapped", () => {
    expect(parseAgentFrontmatter('---\nname: "scout"\nmodel: \'gpt-5.6-sol\'\n---\n')).toEqual({
      name: "scout",
      model: "gpt-5.6-sol",
    });
  });

  test("a file without frontmatter yields nothing", () => {
    expect(parseAgentFrontmatter("# just markdown\n")).toEqual({});
  });

  test("keys after the closing fence are ignored", () => {
    expect(parseAgentFrontmatter("---\nname: a\n---\nmodel: b\n").model).toBeUndefined();
  });
});

describe("agent discovery", () => {
  test("project definitions win over user and package ones", () => {
    const deps = discoveryFs({
      "/project/.pi/agents/reviewer.md": agentMd("reviewer", "model: project-model\n"),
      "/home/.pi/agent/agents/reviewer.md": agentMd("reviewer", "model: user-model\n"),
      "/pkg/agents/reviewer.md": agentMd("reviewer", "model: package-model\n"),
      "/pkg/agents/scout.md": agentMd("scout"),
    });

    const agents = listSubagentAgents(deps, [
      { dir: "/project/.pi/agents", source: "project" },
      { dir: "/home/.pi/agent/agents", source: "user" },
      { dir: "/pkg/agents", source: "package" },
    ]);

    expect(agents.map((agent) => `${agent.name}:${agent.model ?? "-"}:${agent.source}`)).toEqual([
      "reviewer:project-model:project",
      "scout:-:package",
    ]);
  });

  test("a definition without a name falls back to the file stem", () => {
    const deps = discoveryFs({ "/home/.pi/agent/agents/oracle.md": "no frontmatter\n" });
    const agents = listSubagentAgents(deps, [{ dir: "/home/.pi/agent/agents", source: "user" }]);
    expect(agents.map((agent) => agent.name)).toEqual(["oracle"]);
  });

  test("missing roots and non-markdown files are skipped", () => {
    const deps = discoveryFs({
      "/home/.pi/agent/agents/notes.txt": "x",
      "/home/.pi/agent/agents/reviewer.md": agentMd("reviewer"),
    });
    const agents = listSubagentAgents(deps, [
      { dir: "/nope", source: "project" },
      { dir: "/home/.pi/agent/agents", source: "user" },
    ]);
    expect(agents.map((agent) => agent.name)).toEqual(["reviewer"]);
  });
});

describe("subagent settings snapshot", () => {
  test("reads defaultModel and per-agent overrides", () => {
    const fs = memFs({
      [SETTINGS]: JSON.stringify({
        theme: "material-darker",
        subagents: {
          defaultThinking: "high",
          defaultModel: "radius/cheap",
          agentOverrides: {
            reviewer: { model: "opencode-go/glm-5.3", thinking: "low" },
            scout: { thinking: "low" },
          },
        },
      }),
    });

    expect(readSubagentSettings(fs, SETTINGS)).toEqual({
      defaultModel: "radius/cheap",
      overrides: { reviewer: "opencode-go/glm-5.3" },
    });
  });

  test("a malformed block reads as absent instead of throwing", () => {
    const fs = memFs({ [SETTINGS]: JSON.stringify({ subagents: "nope" }) });
    expect(readSubagentSettings(fs, SETTINGS)).toEqual({ overrides: {} });
  });

  test("an unparsable settings.json reads as absent", () => {
    const fs = memFs({ [SETTINGS]: "{ broken" });
    expect(readSubagentSettings(fs, SETTINGS)).toEqual({ overrides: {} });
  });
});

describe("row resolution", () => {
  const reviewer: SubagentAgentDefinition = {
    name: "reviewer",
    model: "frontmatter-model",
    source: "package",
    path: "/pkg/agents/reviewer.md",
  };

  test("precedence is override > frontmatter > defaultModel > inherit", () => {
    expect(
      resolveSubagentRow(reviewer, { defaultModel: "d", overrides: { reviewer: "o" } }).source,
    ).toBe("override");
    expect(resolveSubagentRow(reviewer, { defaultModel: "d", overrides: {} }).source).toBe(
      "frontmatter",
    );
    expect(resolveSubagentRow({ ...reviewer, model: undefined }, { defaultModel: "d", overrides: {} }).source).toBe("default");
    expect(resolveSubagentRow({ ...reviewer, model: undefined }, { overrides: {} }).source).toBe(
      "inherit",
    );
  });

  test("the default row comes first and carries defaultModel", () => {
    const rows = planSubagentRows([reviewer], { defaultModel: "radius/cheap", overrides: {} });
    expect(rows[0]).toMatchObject({ kind: "default", source: "default", model: "radius/cheap" });
    expect(rows[1]).toMatchObject({ kind: "agent", name: "reviewer", source: "frontmatter" });
  });

  test("no defaultModel leaves the default row inheriting the session model", () => {
    const rows = planSubagentRows([], { overrides: {} });
    expect(rows).toEqual([{ kind: "default", name: "", source: "inherit" }]);
  });

  test("override count only counts agent overrides", () => {
    expect(overrideCount({ defaultModel: "d", overrides: { a: "x", b: "y" } })).toBe(2);
  });
});

describe("writeSubagentModel", () => {
  test("sets a per-agent override and preserves unrelated settings", () => {
    const fs = memFs({
      [SETTINGS]: JSON.stringify({
        theme: "material-darker",
        subagents: { defaultThinking: "high" },
      }),
    });

    const result = writeSubagentModel(
      { fs, settingsPath: SETTINGS, pid: 1 },
      { kind: "agent", name: "reviewer" },
      "radius/deepseek-v4.1-flash",
    );

    expect(result.ok).toBe(true);
    expect(readSettings(fs)).toEqual({
      theme: "material-darker",
      subagents: {
        defaultThinking: "high",
        agentOverrides: { reviewer: { model: "radius/deepseek-v4.1-flash" } },
      },
    });
  });

  test("keeps other keys inside an existing agent override entry", () => {
    const fs = memFs({
      [SETTINGS]: JSON.stringify({
        subagents: { agentOverrides: { reviewer: { thinking: "low", disabled: false } } },
      }),
    });

    writeSubagentModel(
      { fs, settingsPath: SETTINGS, pid: 1 },
      { kind: "agent", name: "reviewer" },
      "radius/cheap",
    );

    const subagents = readSettings(fs).subagents as Record<string, unknown>;
    const entries = subagents.agentOverrides as Record<string, Record<string, unknown>>;
    expect(entries.reviewer).toEqual({
      thinking: "low",
      disabled: false,
      model: "radius/cheap",
    });
  });

  test("clearing an override prunes empty scaffolding", () => {
    const fs = memFs({
      [SETTINGS]: JSON.stringify({
        theme: "material-darker",
        subagents: { agentOverrides: { reviewer: { model: "x/y" } } },
      }),
    });

    writeSubagentModel(
      { fs, settingsPath: SETTINGS, pid: 1 },
      { kind: "agent", name: "reviewer" },
      null,
    );

    expect(readSettings(fs)).toEqual({ theme: "material-darker" });
  });

  test("clearing defaultModel leaves sibling subagent keys intact", () => {
    const fs = memFs({
      [SETTINGS]: JSON.stringify({
        subagents: { defaultModel: "x/y", defaultThinking: "high" },
      }),
    });

    writeSubagentModel({ fs, settingsPath: SETTINGS, pid: 1 }, { kind: "default" }, null);

    expect((readSettings(fs).subagents as Record<string, unknown>).defaultModel).toBeUndefined();
    expect((readSettings(fs).subagents as Record<string, unknown>).defaultThinking).toBe("high");
  });

  test("the global default is written as subagents.defaultModel", () => {
    const fs = memFs();
    writeSubagentModel(
      { fs, settingsPath: SETTINGS, pid: 1 },
      { kind: "default" },
      "opencode-go/glm-5.3",
    );
    expect(readSettings(fs).subagents).toEqual({ defaultModel: "opencode-go/glm-5.3" });
  });

  test("blank input is rejected without touching the file", () => {
    const fs = memFs({ [SETTINGS]: JSON.stringify({ theme: "x" }) });
    expect(
      writeSubagentModel({ fs, settingsPath: SETTINGS, pid: 1 }, { kind: "default" }, "   "),
    ).toEqual({ ok: false, error: "empty model id" });
    expect(
      writeSubagentModel(
        { fs, settingsPath: SETTINGS, pid: 1 },
        { kind: "agent", name: "  " },
        "x/y",
      ).ok,
    ).toBe(false);
    expect(readSettings(fs)).toEqual({ theme: "x" });
  });
});

describe("subagent picker labels", () => {
  test("each layer is visible in the row badge", () => {
    const previous = getLocale();
    setLocale("zh");
    try {
      const labels = formatSubagentRows([
        { kind: "default", name: "", source: "inherit" },
        { kind: "agent", name: "reviewer", source: "override", model: "radius/cheap" },
        { kind: "agent", name: "scout", source: "frontmatter", model: "gpt-5.6-sol" },
        { kind: "agent", name: "oracle", source: "default", model: "radius/cheap" },
      ]);

      expect(labels[0]).toContain("全部 Subagent 默认");
      expect(labels[0]).toContain("继承会话模型");
      expect(labels[1]).toContain("覆写 radius/cheap");
      expect(labels[2]).toContain("frontmatter gpt-5.6-sol");
      expect(labels[3]).toContain("默认 radius/cheap");
    } finally {
      setLocale(previous);
    }
  });

  test("the picker footer advertises the s key once a provider is focused", () => {
    const label = t("subagent");
    expect(formatFooterHints(undefined, { revealed: 1, col: 1 })).toContain(label);
    expect(formatFooterHints(undefined, { revealed: 0, col: 0 })).not.toContain(label);
    // readOnly hides every mutating action (probe target selection).
    expect(
      formatFooterHints(undefined, { revealed: 1, col: 1, readOnly: true }),
    ).not.toContain(label);
  });
});

/** Scripted ui.select/ui.input host used to drive the flow without a TTY. */
function scriptedCtx(script: Array<string | undefined>) {
  const notified: Array<{ message: string; level: string }> = [];
  const asked: Array<{ title: string; labels: string[] }> = [];
  const typed: string[] = [];
  let step = 0;
  const ctx = {
    mode: "rpc",
    ui: {
      select: async (title: string, labels: string[]) => {
        asked.push({ title, labels });
        const answer = script[step];
        step += 1;
        if (answer === undefined) return undefined;
        if (!labels.includes(answer)) throw new Error(`script step ${step} not offered: ${answer}`);
        return answer;
      },
      input: async () => {
        const answer = script[step];
        step += 1;
        typed.push(String(answer));
        return answer;
      },
      notify: (message: string, level = "info") => notified.push({ message, level }),
      setStatus: () => undefined,
    },
  } as unknown as PiSwitchCtx;
  return { ctx, notified, asked, typed };
}

describe("runSubagentModelFlow", () => {
  const rows = [
    { kind: "default" as const, name: "", source: "inherit" as const },
    { kind: "agent" as const, name: "reviewer", source: "frontmatter" as const, model: "gpt-5.6-sol" },
  ];
  // Labels come from the same formatters the flow uses, so the scripted host
  // stays locale-independent.
  const REVIEWER_ROW = formatSubagentRows(rows)[1]!;
  const DEFAULT_ROW = formatSubagentRows(rows)[0]!;
  const OVERRIDE_ROW = formatSubagentRows([
    { kind: "agent", name: "reviewer", source: "override", model: "radius/cheap", override: "radius/cheap" },
  ])[0]!;
  const SEED_ROW = tf("subagentUseFocused", { model: "ps-codex-a/gpt-5.6-luna" });
  const CANCEL = t("cancel");

  test("assigns the focused provider/model to an agent", async () => {
    const { ctx, notified } = scriptedCtx([REVIEWER_ROW, SEED_ROW]);
    const saved: Array<[unknown, string | null]> = [];

    await runSubagentModelFlow(ctx, {
      rows: () => rows,
      save: (target, model) => {
        saved.push([target, model]);
        return { ok: true };
      },
      seed: {
        provider: { piName: "ps-codex-a" } as never,
        modelId: "gpt-5.6-luna",
      },
      pickModel: async () => undefined,
    });

    expect(saved).toEqual([[{ kind: "agent", name: "reviewer" }, "ps-codex-a/gpt-5.6-luna"]]);
    expect(notified[0]!.message).toBe(
      tf("subagentSaved", { target: "reviewer", model: "ps-codex-a/gpt-5.6-luna" }),
    );
  });

  test("the focused-model row is absent without a seed", async () => {
    const { ctx, asked } = scriptedCtx([REVIEWER_ROW, CANCEL]);

    await runSubagentModelFlow(ctx, {
      rows: () => rows,
      save: () => ({ ok: true }),
      pickModel: async () => undefined,
    });

    const valueLabels = asked[1]!.labels;
    expect(valueLabels.some((label) => label.startsWith(t("subagentUseFocused").split("{")[0]!.trim()))).toBe(false);
    expect(valueLabels).toContain(t("subagentPick"));
  });

  test("the clear row only appears for a row that has an override", async () => {
    const withOverride = [
      rows[0]!,
      {
        kind: "agent" as const,
        name: "reviewer",
        source: "override" as const,
        model: "radius/cheap",
        override: "radius/cheap",
      },
    ];
    const { ctx, asked } = scriptedCtx([OVERRIDE_ROW, t("subagentClear")]);
    const saved: Array<[unknown, string | null]> = [];

    await runSubagentModelFlow(ctx, {
      rows: () => withOverride,
      save: (target, model) => {
        saved.push([target, model]);
        return { ok: true };
      },
      pickModel: async () => undefined,
    });

    expect(asked[1]!.labels[0]).toBe(t("subagentClear"));
    expect(saved).toEqual([[{ kind: "agent", name: "reviewer" }, null]]);
  });

  test("manual entry accepts an id the provider list does not contain", async () => {
    const { ctx, typed } = scriptedCtx([
      REVIEWER_ROW,
      t("subagentManual"),
      "huggingface/thinkingmachines/Inkling",
    ]);
    const saved: Array<[unknown, string | null]> = [];

    await runSubagentModelFlow(ctx, {
      rows: () => rows,
      save: (target, model) => {
        saved.push([target, model]);
        return { ok: true };
      },
      pickModel: async () => undefined,
    });

    expect(typed).toEqual(["huggingface/thinkingmachines/Inkling"]);
    expect(saved[0]![1]).toBe("huggingface/thinkingmachines/Inkling");
  });

  test("empty manual input saves nothing", async () => {
    const { ctx } = scriptedCtx([REVIEWER_ROW, t("subagentManual"), "   ", undefined]);
    let saves = 0;

    await runSubagentModelFlow(ctx, {
      rows: () => rows,
      save: () => {
        saves += 1;
        return { ok: true };
      },
      pickModel: async () => undefined,
    });

    expect(saves).toBe(0);
  });

  test("the provider picker result is stored as provider/model", async () => {
    const { ctx } = scriptedCtx([DEFAULT_ROW, t("subagentPick")]);
    const saved: Array<[unknown, string | null]> = [];

    await runSubagentModelFlow(ctx, {
      rows: () => rows,
      save: (target, model) => {
        saved.push([target, model]);
        return { ok: true };
      },
      pickModel: async () => ({
        provider: { piName: "cline-e5a5ddc3" } as never,
        modelId: "cline-pass/deepseek-v4.1-flash",
      }),
    });

    expect(saved).toEqual([
      [{ kind: "default" }, "cline-e5a5ddc3/cline-pass/deepseek-v4.1-flash"],
    ]);
  });

  test("a cancelled provider picker leaves the config untouched", async () => {
    const { ctx } = scriptedCtx([REVIEWER_ROW, t("subagentPick")]);
    let saves = 0;

    await runSubagentModelFlow(ctx, {
      rows: () => rows,
      save: () => {
        saves += 1;
        return { ok: true };
      },
      pickModel: async () => undefined,
    });

    expect(saves).toBe(0);
  });

  test("a failed write is reported as an error", async () => {
    const { ctx, notified } = scriptedCtx([REVIEWER_ROW, SEED_ROW]);

    await runSubagentModelFlow(ctx, {
      rows: () => rows,
      save: () => ({ ok: false, error: "settings.json changed" }),
      seed: { provider: { piName: "ps-codex-a" } as never, modelId: "gpt-5.6-luna" },
      pickModel: async () => undefined,
    });

    expect(notified[0]!.level).toBe("error");
    expect(notified[0]!.message).toBe(
      tf("subagentWriteFailed", { error: "settings.json changed" }),
    );
  });

  test("the row list is rebuilt after every write so badges stay current", async () => {
    const { ctx } = scriptedCtx([REVIEWER_ROW, SEED_ROW, undefined]);
    let rowCalls = 0;

    await runSubagentModelFlow(ctx, {
      rows: () => {
        rowCalls += 1;
        return rows;
      },
      save: () => ({ ok: true }),
      seed: { provider: { piName: "ps-codex-a" } as never, modelId: "gpt-5.6-luna" },
      pickModel: async () => undefined,
    });

    expect(rowCalls).toBe(2);
  });
});
