/**
 * Subagent model picker (picker key `s` and `/ps-subagents`).
 *
 * Two sequential lists, never nested inside another custom TUI (H1):
 *   1. target — the global default row plus every discovered agent definition,
 *      each showing which layer currently supplies its model;
 *   2. value — use the provider/model that was focused in the switcher, clear
 *      the layer, open the cc-switch provider/model picker, or type an id.
 *
 * Writing `subagents.defaultModel` / `subagents.agentOverrides.<agent>.model`
 * is what makes a subagent run a different model from the parent session.
 */

import type { CcProvider } from "../types.ts";
import type { PiSwitchCtx } from "../pi-context.ts";
import type { StateWriteResult } from "../local-state.ts";
import type { SubagentRow, SubagentTarget } from "../subagent-models.ts";
import { GLYPH } from "./tui-theme.ts";
import { pickOverrideProvider } from "./provider-override-pick.ts";
import { t, tf } from "./tui-locale.ts";

export function formatSubagentRow(row: SubagentRow): string {
  const name = row.kind === "default" ? t("subagentRowDefault") : row.name;
  const model = row.model ?? "";
  const badge =
    row.source === "override"
      ? `${GLYPH.override} ${tf("subagentSourceOverride", { model })}`
      : row.source === "frontmatter"
        ? tf("subagentSourceFrontmatter", { model })
        : row.source === "default"
          ? tf("subagentSourceDefault", { model })
          : t("subagentSourceInherit");
  return `${name} · ${badge}`;
}

export function formatSubagentRows(rows: SubagentRow[]): string[] {
  return rows.map(formatSubagentRow);
}

function targetLabel(row: SubagentRow): string {
  return row.kind === "default" ? t("subagentRowDefault") : row.name;
}

export function targetFor(row: SubagentRow): SubagentTarget {
  return row.kind === "default" ? { kind: "default" } : { kind: "agent", name: row.name };
}

type ValueChoice =
  | { kind: "seed"; model: string }
  | { kind: "clear" }
  | { kind: "pick" }
  | { kind: "manual" }
  | { kind: "cancel" };

export interface SubagentModelFlowDeps {
  rows(): SubagentRow[];
  save(target: SubagentTarget, model: string | null): StateWriteResult;
  /** Provider/model chosen in the switcher before pressing `s` (optional). */
  seed?: { provider: CcProvider; modelId?: string };
  /** Opens the read-only cc-switch provider/model picker. */
  pickModel(): Promise<{ provider: CcProvider; modelId: string } | undefined>;
}

function valueChoices(row: SubagentRow, seedModel: string | undefined): ValueChoice[] {
  const choices: ValueChoice[] = [];
  if (seedModel) choices.push({ kind: "seed", model: seedModel });
  if (row.override) choices.push({ kind: "clear" });
  choices.push({ kind: "pick" }, { kind: "manual" }, { kind: "cancel" });
  return choices;
}

function choiceLabel(choice: ValueChoice): string {
  switch (choice.kind) {
    case "seed":
      return tf("subagentUseFocused", { model: choice.model });
    case "clear":
      return t("subagentClear");
    case "pick":
      return t("subagentPick");
    case "manual":
      return t("subagentManual");
    case "cancel":
      return t("cancel");
  }
}

async function chooseValue(
  ctx: PiSwitchCtx,
  row: SubagentRow,
  seedModel: string | undefined,
): Promise<ValueChoice> {
  const choices = valueChoices(row, seedModel);
  const idx = await pickOverrideProvider(
    ctx,
    tf("subagentValueTitle", { target: targetLabel(row) }),
    choices.map(choiceLabel),
  );
  return (idx === undefined ? { kind: "cancel" } : choices[idx]) ?? { kind: "cancel" };
}

function reportWrite(
  ctx: PiSwitchCtx,
  row: SubagentRow,
  model: string | null,
  result: StateWriteResult,
): void {
  if (!result.ok) {
    ctx.ui?.notify?.(tf("subagentWriteFailed", { error: result.error ?? "unknown" }), "error");
    return;
  }
  ctx.ui?.notify?.(
    model === null
      ? tf("subagentCleared", { target: targetLabel(row) })
      : tf("subagentSaved", { target: targetLabel(row), model }),
    "info",
  );
}

export async function runSubagentModelFlow(
  ctx: PiSwitchCtx,
  deps: SubagentModelFlowDeps,
): Promise<void> {
  const seedModel =
    deps.seed?.provider && deps.seed.modelId
      ? `${deps.seed.provider.piName}/${deps.seed.modelId}`
      : undefined;

  for (;;) {
    const rows = deps.rows();
    const idx = await pickOverrideProvider(
      ctx,
      rows.length > 1 ? t("subagentTitle") : t("subagentTitleEmpty"),
      formatSubagentRows(rows),
    );
    if (idx === undefined) return;
    const row = rows[idx];
    if (!row) return;

    const choice = await chooseValue(ctx, row, seedModel);
    if (choice.kind === "cancel") continue;

    let model: string | null;
    if (choice.kind === "clear") {
      model = null;
    } else if (choice.kind === "seed") {
      model = choice.model;
    } else if (choice.kind === "pick") {
      const picked = await deps.pickModel();
      if (!picked) continue;
      model = `${picked.provider.piName}/${picked.modelId}`;
    } else {
      const typed = (await ctx.ui.input(t("subagentManualPrompt"), row.model ?? ""))?.trim();
      if (!typed) continue;
      model = typed;
    }

    reportWrite(ctx, row, model, deps.save(targetFor(row), model));
  }
}
