/**
 * Atomic config-edit envelope for pi-switch.json writers.
 *
 * Hides updateJsonObjectAtomic + pid temp naming + {ok,error} catch wrapping.
 * Domain writers supply only the document mutation (and optional result).
 */

import {
  JsonFileConflictError,
  updateJsonObjectAtomic,
  writeJsonObjectAtomic,
  type FsLike,
  type JsonObject,
} from "./json-file.ts";

/**
 * The atomic-write target for config edits: filesystem, config path, and the
 * pid used for temp-file naming. Bundled because every override write passes
 * these three unchanged to updateJsonObjectAtomic.
 */
export interface ConfigWriteTarget {
  fs: FsLike;
  configPath: string;
  pid: number;
}

export type ConfigEditResult = { ok: true } | { ok: false; error: string };

export type ConfigEditResultWith<T> =
  | { ok: true; result: T }
  | { ok: false; error: string };

/** Map a thrown value to the failure arm of ConfigEditResult. */
export function configEditError(err: unknown): { ok: false; error: string } {
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

/** Mutate the config document under CAS; map failures to {ok,error}. */
export function editConfig(
  target: ConfigWriteTarget,
  mutate: (raw: JsonObject) => JsonObject,
): ConfigEditResult {
  try {
    updateJsonObjectAtomic(target.fs, target.configPath, target.pid, (raw) => ({
      document: mutate(raw),
      result: undefined,
    }));
    return { ok: true };
  } catch (err) {
    return configEditError(err);
  }
}

/** Like editConfig, but surface a value computed inside the atomic section. */
export function editConfigWithResult<T>(
  target: ConfigWriteTarget,
  mutate: (raw: JsonObject) => { document: JsonObject; result: T },
): ConfigEditResultWith<T> {
  try {
    const result = updateJsonObjectAtomic(
      target.fs,
      target.configPath,
      target.pid,
      mutate,
    );
    return { ok: true, result };
  } catch (err) {
    return configEditError(err);
  }
}

export type StrictEditResult =
  | { ok: true; document: JsonObject }
  | { ok: false; reason: "conflict" | "error"; message: string };

/**
 * Strict-CAS edit: parse exactly `expectedSource`, mutate, and write only if
 * the file on disk still matches that source. Unlike editConfig this never
 * merge-retries against a newer file — a concurrent external edit is a
 * conflict to abort on, not something to absorb (Repair's commit semantics).
 */
export function editConfigStrict(
  target: ConfigWriteTarget,
  expectedSource: string | undefined,
  mutate: (raw: JsonObject) => JsonObject,
): StrictEditResult {
  try {
    let raw: JsonObject = {};
    if (expectedSource !== undefined) {
      const value: unknown = JSON.parse(expectedSource);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`invalid JSON object in ${target.configPath}`);
      }
      raw = value as JsonObject;
    }
    const document = mutate(raw);
    writeJsonObjectAtomic(
      target.fs,
      target.configPath,
      document,
      target.pid,
      expectedSource,
    );
    return { ok: true, document };
  } catch (err) {
    if (err instanceof JsonFileConflictError) {
      return {
        ok: false,
        reason: "conflict",
        message: err.message,
      };
    }
    return {
      ok: false,
      reason: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
