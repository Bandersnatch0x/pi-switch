import { describe, expect, test } from "bun:test";
import {
  updateJsonObjectAtomic,
  type FsLike,
} from "../src/json-file.ts";

function codedError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function memFs(initial: Record<string, string> = {}): FsLike & {
  store: Record<string, string>;
  delays: number[];
} {
  const store = { ...initial };
  const delays: number[] = [];
  return {
    store,
    delays,
    existsSync: (path) => path in store,
    readFileSync: (path) => {
      if (!(path in store)) throw codedError("missing", "ENOENT");
      return store[path];
    },
    writeFileSync: (path, data) => {
      store[path] = data;
    },
    renameSync: (from, to) => {
      store[to] = store[from];
      delete store[from];
    },
    unlinkSync: (path) => {
      if (!(path in store)) throw codedError("missing", "ENOENT");
      delete store[path];
    },
    sleepSync: (ms) => delays.push(ms),
  };
}

describe("JSON file transactions", () => {
  test("retries transient Windows rename failures", () => {
    const fs = memFs({ "/config.json": JSON.stringify({ old: true }) });
    let attempts = 0;
    fs.renameSync = (from, to) => {
      attempts += 1;
      if (attempts < 3) throw codedError("busy", "EBUSY");
      fs.store[to] = fs.store[from];
      delete fs.store[from];
    };

    updateJsonObjectAtomic(fs, "/config.json", 7, (document) => ({
      document: { ...document, next: true },
      result: undefined,
    }));

    expect(attempts).toBe(3);
    expect(fs.delays).toEqual([25, 50]);
    expect(JSON.parse(fs.store["/config.json"])).toEqual({ old: true, next: true });
  });

  test("retries a concurrent edit and merges against the latest document", () => {
    const fs = memFs({ "/config.json": JSON.stringify({ base: true }) });
    const write = fs.writeFileSync;
    let injected = false;
    fs.writeFileSync = (path, data, encoding) => {
      write(path, data, encoding);
      if (!injected && path.includes(".tmp-")) {
        injected = true;
        fs.store["/config.json"] = JSON.stringify({ base: true, external: true });
      }
    };

    updateJsonObjectAtomic(fs, "/config.json", 8, (document) => ({
      document: { ...document, local: true },
      result: undefined,
    }));

    expect(JSON.parse(fs.store["/config.json"])).toEqual({
      base: true,
      external: true,
      local: true,
    });
    expect(Object.keys(fs.store).filter((path) => path.includes(".tmp-"))).toEqual([]);
  });

  test("preserves the original and reports the recovery file on permanent failure", () => {
    const source = JSON.stringify({ stable: true });
    const fs = memFs({ "/config.json": source });
    fs.renameSync = () => {
      throw codedError("disk full", "ENOSPC");
    };

    expect(() =>
      updateJsonObjectAtomic(fs, "/config.json", 9, (document) => ({
        document: { ...document, next: true },
        result: undefined,
      })),
    ).toThrow(/disk full.*recovery file:/);
    expect(fs.store["/config.json"]).toBe(source);
    expect(Object.keys(fs.store).some((path) => path.includes(".tmp-9-"))).toBe(true);
  });

  test("refuses to overwrite malformed JSON", () => {
    const source = "{broken";
    const fs = memFs({ "/config.json": source });

    expect(() =>
      updateJsonObjectAtomic(fs, "/config.json", 10, (document) => ({
        document: { ...document, next: true },
        result: undefined,
      })),
    ).toThrow("invalid JSON in /config.json");
    expect(fs.store["/config.json"]).toBe(source);
    expect(Object.keys(fs.store)).toEqual(["/config.json"]);
  });
});
