import { test, expect, describe } from "bun:test";
import {
  migrateLegacySelection,
  readSelection,
  writeSelection,
  type FsLike,
} from "../src/settings.ts";
import type { CcProvider } from "../src/types.ts";

function memFs(initial: Record<string, string> = {}): FsLike & { store: Record<string, string> } {
  const store = { ...initial };
  return {
    store,
    existsSync: (p) => p in store,
    readFileSync: (p) => {
      if (!(p in store)) throw new Error("missing");
      return store[p];
    },
    writeFileSync: (p, data) => {
      store[p] = data;
    },
    renameSync: (from, to) => {
      store[to] = store[from];
      delete store[from];
    },
  };
}

const provider = (id: string, name: string): CcProvider => ({
  id,
  piName: `ps-codex-${id}`,
  displayName: name,
  appType: "codex",
  api: "openai-responses",
  baseUrl: "https://x",
  apiKey: "k",
  authHeader: true,
  configModels: ["m"],
  meta: {},
  isCurrentInCc: false,
});

describe("selection persistence", () => {
  test("write and read by dbId", () => {
    const fs = memFs();
    const path = "/tmp/settings.json";
    writeSelection(
      fs,
      path,
      { dbId: "abc", model: " m1 ", tab: "codex", appType: "codex", provider: "ps-codex-abc" },
      1,
    );
    const sel = readSelection(fs, path);
    expect(sel?.dbId).toBe("abc");
    expect(sel?.model).toBe("m1");
  });
});

describe("legacy migration", () => {
  test("unique name match migrates", () => {
    const fs = memFs({
      "/s.json": JSON.stringify({
        ccSwitchSelection: { provider: "ccs-sbai", model: "gpt-5" },
      }),
    });
    const sel = migrateLegacySelection(fs, "/s.json", [provider("id1", "sbai")], 1);
    expect(sel?.dbId).toBe("id1");
    expect(sel?.model).toBe("gpt-5");
    expect(readSelection(fs, "/s.json")?.dbId).toBe("id1");
  });

  test("ambiguous name does not migrate", () => {
    const fs = memFs({
      "/s.json": JSON.stringify({
        ccSwitchSelection: { provider: "ccs-x", model: "m" },
      }),
    });
    const sel = migrateLegacySelection(
      fs,
      "/s.json",
      [provider("1", "x"), provider("2", "x")],
      1,
    );
    expect(sel).toBeUndefined();
  });
});
