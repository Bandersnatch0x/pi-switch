/**
 * Pins + recents domain: identity matching, toggle/push logic, parsing, and
 * the two envelope writers. The only place that knows how a pin/recent entry
 * is identified (issue #16 composite identity + legacy healing).
 */

import type { PinEntry, RecentEntry } from "./types.ts";
import { DEFAULT_RECENT_LIMIT } from "./types.ts";
import {
  editConfigWithResult,
  type ConfigWriteTarget,
} from "./config-edit.ts";

/**
 * Same provider+model identity. An appType-carrying probe also claims
 * appType-less legacy entries (pre-migration / appType-stripping bug); a
 * legacy probe never claims an appType-carrying entry (can't disambiguate).
 */
function sameEntry(
  stored: { dbId: string; model: string; appType?: string },
  probe: { dbId: string; model: string; appType?: string },
): boolean {
  if (stored.dbId !== probe.dbId) return false;
  if (stored.model.trim() !== probe.model.trim()) return false;
  return stored.appType === probe.appType || (!stored.appType && Boolean(probe.appType));
}

export function isPinned(
  pins: PinEntry[] | undefined,
  dbId: string,
  model: string,
  appType?: string,
): boolean {
  return (pins ?? []).some((p) => sameEntry(p, { dbId, model, appType }));
}

/** Toggle a pin entry. Returns the new pins array. */
export function togglePinEntry(
  pins: PinEntry[] | undefined,
  entry: PinEntry,
): { pins: PinEntry[]; pinned: boolean } {
  const list = [...(pins ?? [])];
  // Unpin removes every match, healing duplicates accumulated by the old
  // appType-stripping read path.
  const kept = list.filter((p) => !sameEntry(p, entry));
  if (kept.length !== list.length) {
    return { pins: kept, pinned: false };
  }
  list.unshift({
    dbId: entry.dbId,
    model: entry.model.trim(),
    appType: entry.appType,
    label: entry.label,
  });
  return { pins: list, pinned: true };
}

export function pushRecentEntry(
  recent: RecentEntry[] | undefined,
  entry: Omit<RecentEntry, "at"> & { at?: number },
  limit = DEFAULT_RECENT_LIMIT,
): RecentEntry[] {
  const next: RecentEntry = {
    dbId: entry.dbId,
    model: entry.model.trim(),
    appType: entry.appType,
    at: entry.at ?? Date.now(),
  };
  const filtered = (recent ?? []).filter((r) => !sameEntry(r, next));
  return [next, ...filtered].slice(0, Math.max(1, limit));
}

export function parsePins(raw: unknown): PinEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PinEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const dbId = typeof rec.dbId === "string" ? rec.dbId.trim() : "";
    const model = typeof rec.model === "string" ? rec.model.trim() : "";
    if (!dbId || !model) continue;
    const label =
      typeof rec.label === "string" && rec.label.trim() ? rec.label.trim() : undefined;
    const appType =
      typeof rec.appType === "string" && rec.appType.trim() ? rec.appType.trim() : undefined;
    out.push({ dbId, model, appType, label });
  }
  return out;
}

export function parseRecent(raw: unknown): RecentEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: RecentEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const dbId = typeof rec.dbId === "string" ? rec.dbId.trim() : "";
    const model = typeof rec.model === "string" ? rec.model.trim() : "";
    const at =
      typeof rec.at === "number" && Number.isFinite(rec.at) ? Math.floor(rec.at) : 0;
    if (!dbId || !model) continue;
    const appType =
      typeof rec.appType === "string" && rec.appType.trim() ? rec.appType.trim() : undefined;
    out.push({ dbId, model, appType, at });
  }
  return out;
}

export type TogglePinWriteResult =
  | { ok: true; pins: PinEntry[]; pinned: boolean }
  | { ok: false; error: string; pins: PinEntry[]; pinned: boolean };

export type RecordRecentWriteResult =
  | { ok: true; recent: RecentEntry[] }
  | { ok: false; error: string; recent: RecentEntry[] };

export function togglePinAndWrite(
  target: ConfigWriteTarget,
  entry: PinEntry,
): TogglePinWriteResult {
  const edited = editConfigWithResult(target, (raw) => {
    const toggled = togglePinEntry(parsePins(raw.pins), entry);
    return {
      document: { ...raw, pins: toggled.pins },
      result: toggled,
    };
  });
  if (!edited.ok) {
    return { ok: false, error: edited.error, pins: [], pinned: false };
  }
  return { ok: true, ...edited.result };
}

export function recordRecentAndWrite(
  target: ConfigWriteTarget,
  entry: Omit<RecentEntry, "at"> & { at?: number },
): RecordRecentWriteResult {
  const edited = editConfigWithResult(target, (raw) => {
    // Parse the two fields we need straight off the in-flight document —
    // recordRecent used to fake a whole FsLike just to reuse readPiSwitchConfig.
    const limit =
      typeof raw.recentLimit === "number" && raw.recentLimit > 0
        ? Math.floor(raw.recentLimit)
        : undefined;
    const next = pushRecentEntry(parseRecent(raw.recent), entry, limit);
    return {
      document: { ...raw, recent: next },
      result: next,
    };
  });
  if (!edited.ok) {
    return { ok: false, error: edited.error, recent: [] };
  }
  return { ok: true, recent: edited.result };
}
