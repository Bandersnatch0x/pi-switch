import { describe, expect, test } from "bun:test";
import {
  appendCappedJsonLog,
  redactUrlCredentials,
  type LogFs,
} from "../extensions/compat-log.ts";

function memFs(initial: Record<string, string> = {}): { fs: LogFs; files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    fs: {
      existsSync: (path) => path in files,
      readFileSync: (path) => {
        if (!(path in files)) throw new Error("ENOENT");
        return files[path];
      },
      writeFileSync: (path, data) => {
        files[path] = data;
      },
    },
  };
}

describe("redactUrlCredentials", () => {
  test("strips inline user:pass", () => {
    expect(redactUrlCredentials("https://user:secret@relay.example.com/v1")).toBe(
      "https://relay.example.com/v1",
    );
  });
  test("strips username-only credentials", () => {
    expect(redactUrlCredentials("https://token@relay.example.com/")).toBe(
      "https://relay.example.com/",
    );
  });
  test("returns clean URLs unchanged (no reserialization)", () => {
    const url = "https://relay.example.com/v1beta";
    expect(redactUrlCredentials(url)).toBe(url);
  });
  test("null/empty → null", () => {
    expect(redactUrlCredentials(null)).toBe(null);
    expect(redactUrlCredentials(undefined)).toBe(null);
    expect(redactUrlCredentials("")).toBe(null);
  });
  test("unparseable input passes through", () => {
    expect(redactUrlCredentials("not a url")).toBe("not a url");
  });
});

describe("appendCappedJsonLog", () => {
  test("appends timestamped JSON line to a new file", () => {
    const { fs, files } = memFs();
    appendCappedJsonLog(fs, "/log", { phase: "request", n: 1 });
    const lines = files["/log"].trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.phase).toBe("request");
    expect(entry.n).toBe(1);
    expect(typeof entry.t).toBe("string");
  });

  test("keeps only the last `cap` lines", () => {
    const { fs, files } = memFs();
    for (let i = 0; i < 7; i++) {
      appendCappedJsonLog(fs, "/log", { n: i }, 5);
    }
    const lines = files["/log"].trim().split("\n");
    expect(lines).toHaveLength(5);
    expect((JSON.parse(lines[0]) as { n: number }).n).toBe(2);
    expect((JSON.parse(lines[4]) as { n: number }).n).toBe(6);
  });

  test("swallows read errors and still writes", () => {
    const { files } = memFs();
    const fs: LogFs = {
      existsSync: () => true,
      readFileSync: () => {
        throw new Error("EACCES");
      },
      writeFileSync: (path, data) => {
        files[path] = data;
      },
    };
    appendCappedJsonLog(fs, "/log", { n: 1 });
    expect(files["/log"]).toContain('"n":1');
  });

  test("swallows write errors without throwing", () => {
    const fs: LogFs = {
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync: () => {
        throw new Error("EROFS");
      },
    };
    expect(() => appendCappedJsonLog(fs, "/log", { n: 1 })).not.toThrow();
  });
});
