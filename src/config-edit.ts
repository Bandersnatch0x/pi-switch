/**
 * Atomic config-edit envelope for pi-switch.json writers.
 *
 * Hides updateJsonObjectAtomic + pid temp naming + {ok,error} catch wrapping.
 * Domain writers supply only the document mutation (and optional result).
 */

import {
  updateJsonObjectAtomic,
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
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
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
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
