/**
 * Subagent model configuration (pi-subagents compatible, no hard dependency).
 *
 * pi-subagents resolves each child model as:
 *   per-run `model` → `subagents.agentOverrides.<agent>.model` →
 *   agent frontmatter `model` → `subagents.defaultModel` → parent session model
 *
 * This module owns the two settings layers pi-switch can write (the per-agent
 * override and the global default) plus read-only discovery of the agent
 * definitions whose frontmatter participates in that chain. It writes into the
 * host's `settings.json` with the same atomic + CAS path as the rest of
 * pi-switch, so a concurrent Pi write aborts instead of being clobbered.
 */

import {
  readJsonObjectLenient,
  updateJsonObjectAtomic,
  type FsLike,
  type JsonObject,
} from "./json-file.ts";
import type { StateWriteResult } from "./local-state.ts";

export type SubagentAgentSource = "project" | "user" | "package";

export interface SubagentAgentDefinition {
  name: string;
  /** `model:` from frontmatter when present. */
  model?: string;
  source: SubagentAgentSource;
  path: string;
}

export interface SubagentAgentRoot {
  dir: string;
  source: SubagentAgentSource;
}

export interface SubagentSettingsSnapshot {
  defaultModel?: string;
  /** agent name → overridden model. */
  overrides: Record<string, string>;
}

/** Which layer actually supplies a row's model, in pi-subagents' precedence. */
export type SubagentModelSource = "override" | "frontmatter" | "default" | "inherit";

export interface SubagentRow {
  /** `default` = `subagents.defaultModel`; `agent` = one named agent. */
  kind: "default" | "agent";
  /** Agent name; empty for the default row. */
  name: string;
  definition?: SubagentAgentDefinition;
  source: SubagentModelSource;
  model?: string;
  /** The override pi-switch would clear/set for this row. */
  override?: string;
}

export interface DiscoveryDeps {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: "utf8"): string;
}

const FRONTMATTER_FIELD = /^([A-Za-z][\w-]*):\s*(.*)$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Read the leading `---` block. Deliberately minimal: pi-switch only needs
 * `name` and `model`, and a full YAML dependency would be disproportionate.
 */
export function parseAgentFrontmatter(source: string): {
  name?: string;
  model?: string;
} {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const match = FRONTMATTER_FIELD.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (rawValue === undefined) continue;
    const value = unquote(rawValue);
    if (value) fields[key!] = value;
  }
  return {
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.model ? { model: fields.model } : {}),
  };
}

function stem(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.md$/i, "");
}

/**
 * Discover agent definitions from the given roots, first root winning per name
 * (project > user > package, matching pi-subagents' precedence).
 */
export function listSubagentAgents(
  deps: DiscoveryDeps,
  roots: SubagentAgentRoot[],
): SubagentAgentDefinition[] {
  const found = new Map<string, SubagentAgentDefinition>();
  for (const root of roots) {
    if (!root.dir || !deps.existsSync(root.dir)) continue;
    let entries: string[];
    try {
      entries = deps.readdirSync(root.dir);
    } catch {
      continue;
    }
    for (const entry of [...entries].sort()) {
      if (!/\.md$/i.test(entry)) continue;
      const path = `${root.dir.replace(/[\\/]+$/, "")}/${entry}`;
      let source: string;
      try {
        source = deps.readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const frontmatter = parseAgentFrontmatter(source);
      const name = frontmatter.name ?? stem(path);
      if (!name || found.has(name)) continue;
      found.set(name, {
        name,
        ...(frontmatter.model ? { model: frontmatter.model } : {}),
        source: root.source,
        path,
      });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function asRecord(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

/** Read the `subagents` block; anything malformed is treated as absent. */
export function readSubagentSettings(
  fs: FsLike,
  settingsPath: string,
): SubagentSettingsSnapshot {
  const subagents = asRecord(readJsonObjectLenient(fs, settingsPath).subagents);
  if (!subagents) return { overrides: {} };
  const defaultModel =
    typeof subagents.defaultModel === "string" && subagents.defaultModel.trim()
      ? subagents.defaultModel.trim()
      : undefined;
  const overrides: Record<string, string> = {};
  const agentOverrides = asRecord(subagents.agentOverrides);
  for (const [name, value] of Object.entries(agentOverrides ?? {})) {
    const model = asRecord(value)?.model;
    if (typeof model === "string" && model.trim()) overrides[name] = model.trim();
  }
  return {
    ...(defaultModel ? { defaultModel } : {}),
    overrides,
  };
}

export type SubagentTarget = { kind: "default" } | { kind: "agent"; name: string };

/** Resolve which layer supplies a row's model. */
export function resolveSubagentRow(
  definition: SubagentAgentDefinition | undefined,
  settings: SubagentSettingsSnapshot,
): SubagentRow {
  const name = definition?.name ?? "";
  const override = definition ? settings.overrides[name] : undefined;
  if (override) {
    return { kind: "agent", name, definition, source: "override", model: override, override };
  }
  if (definition?.model) {
    return { kind: "agent", name, definition, source: "frontmatter", model: definition.model };
  }
  if (settings.defaultModel) {
    return {
      kind: "agent",
      name,
      definition,
      source: "default",
      model: settings.defaultModel,
    };
  }
  return { kind: "agent", name, definition, source: "inherit" };
}

/** Default row first, then the discovered agents (already name-sorted). */
export function planSubagentRows(
  agents: SubagentAgentDefinition[],
  settings: SubagentSettingsSnapshot,
): SubagentRow[] {
  const defaultRow: SubagentRow = settings.defaultModel
    ? { kind: "default", name: "", source: "default", model: settings.defaultModel }
    : { kind: "default", name: "", source: "inherit" };
  return [defaultRow, ...agents.map((agent) => resolveSubagentRow(agent, settings))];
}

/** Count of agents carrying an explicit override (drives row badges). */
export function overrideCount(settings: SubagentSettingsSnapshot): number {
  return Object.keys(settings.overrides).length;
}

export interface SubagentWriteDeps {
  fs: FsLike;
  settingsPath: string;
  pid: number;
}

/**
 * Set or clear one subagent model layer. `null` removes it so the layer falls
 * back to the next one in pi-subagents' chain. Empty containers are pruned so
 * the file never accumulates `{}` scaffolding.
 */
export function writeSubagentModel(
  deps: SubagentWriteDeps,
  target: SubagentTarget,
  model: string | null,
): StateWriteResult {
  const trimmed = model?.trim();
  if (model !== null && !trimmed) {
    return { ok: false, error: "empty model id" };
  }
  if (target.kind === "agent" && !target.name.trim()) {
    return { ok: false, error: "empty agent name" };
  }
  try {
    updateJsonObjectAtomic(deps.fs, deps.settingsPath, deps.pid, (document) => {
      const next: JsonObject = { ...document };
      const subagents: JsonObject = { ...(asRecord(next.subagents) ?? {}) };

      if (target.kind === "default") {
        if (trimmed) subagents.defaultModel = trimmed;
        else delete subagents.defaultModel;
      } else {
        const agentOverrides: JsonObject = {
          ...(asRecord(subagents.agentOverrides) ?? {}),
        };
        const entry: JsonObject = {
          ...(asRecord(agentOverrides[target.name]) ?? {}),
        };
        if (trimmed) entry.model = trimmed;
        else delete entry.model;
        if (Object.keys(entry).length) agentOverrides[target.name] = entry;
        else delete agentOverrides[target.name];
        if (Object.keys(agentOverrides).length) subagents.agentOverrides = agentOverrides;
        else delete subagents.agentOverrides;
      }

      if (Object.keys(subagents).length) next.subagents = subagents;
      else delete next.subagents;
      return { document: next, result: undefined };
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
