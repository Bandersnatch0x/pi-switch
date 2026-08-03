import { describe, expect, test } from "bun:test";
import { Runtime, type NodeIo } from "../extensions/runtime.ts";
import { isModelsDevMiss, makeMiss, MODELS_DEV_API_URL } from "../src/capabilities/models-dev.ts";
import { piSwitchCachePath } from "../src/settings.ts";

const SAMPLE_CATALOG = {
  vivgrid: {
    models: {
      "gpt-5.6-sol": {
        id: "gpt-5.6-sol",
        limit: { context: 1000000, output: 384000 },
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        last_updated: "2026-04-24",
      },
    },
  },
};

function memFs(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    store,
    existsSync: (path: string) => path in store,
    readFileSync: (path: string, _enc?: string) => {
      if (!(path in store)) throw new Error(`ENOENT: ${path}`);
      return store[path];
    },
    writeFileSync: (path: string, data: string | Buffer, _enc?: string) => {
      store[path] = String(data);
    },
    renameSync: (from: string, to: string) => {
      store[to] = store[from];
      delete store[from];
    },
    unlinkSync: (path: string) => {
      delete store[path];
    },
  };
}

function makeIo(opts?: {
  home?: string;
  fs?: ReturnType<typeof memFs>;
  fetchJson?: (url: string) => Promise<unknown>;
}): { rt: Runtime; fs: ReturnType<typeof memFs>; fetchCount: { n: number } } {
  const home = opts?.home ?? "/home/test";
  const fs = opts?.fs ?? memFs();
  const fetchCount = { n: 0 };
  const underlying =
    opts?.fetchJson ??
    (async (_url: string) => SAMPLE_CATALOG);
  const io: NodeIo = {
    execFileSync: (() => {
      throw new Error("no exec");
    }) as NodeIo["execFileSync"],
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync as NodeIo["readFileSync"],
    writeFileSync: fs.writeFileSync as NodeIo["writeFileSync"],
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
    randomUUID: () => "test-uuid",
    resolvePackageVersion: () => undefined,
    snapshotPath: "/dev/null",
    probeHttp: async () => false,
    fetchJson: async (url) => {
      fetchCount.n += 1;
      return underlying(url);
    },
    release: "test",
    home,
  };
  return { rt: new Runtime(io), fs, fetchCount };
}

describe("Runtime capabilities cache (issue #39)", () => {
  test("hit writes positive entry; miss writes negative; modelsDevFor filters miss", async () => {
    const { rt, fs } = makeIo();
    await rt.refreshCapabilities(["gpt-5.6-sol", "private-proxy-id"]);

    const hit = rt.rawCacheEntry("gpt-5.6-sol");
    expect(hit).toBeDefined();
    expect(isModelsDevMiss(hit)).toBe(false);
    expect(rt.modelsDevFor("gpt-5.6-sol")?.contextWindow).toBe(1000000);

    const miss = rt.rawCacheEntry("private-proxy-id");
    expect(isModelsDevMiss(miss)).toBe(true);
    expect(rt.modelsDevFor("private-proxy-id")).toBeUndefined();

    const disk = JSON.parse(fs.store[piSwitchCachePath("/home/test")]);
    expect(disk.version).toBe(1);
    expect(disk.capabilities["private-proxy-id"].missing).toBe(true);
    expect(disk.capabilities["gpt-5.6-sol"].source).toBe("models-dev");
  });

  test("register path modelsDevFor is zero-IO (fetchJson stays 0)", () => {
    const cachePath = piSwitchCachePath("/home/test");
    const { rt, fetchCount } = makeIo({
      fs: memFs({
        [cachePath]: JSON.stringify({
          version: 1,
          capabilities: {
            "private-proxy-id": makeMiss("2026-08-01T00:00:00Z"),
            "gpt-5.6-sol": {
              contextWindow: 1000000,
              maxTokens: 384000,
              reasoning: true,
              vision: true,
              observedAt: "2026-04-24",
              source: "models-dev",
            },
          },
        }),
      }),
    });
    expect(rt.modelsDevFor("private-proxy-id")).toBeUndefined();
    expect(rt.modelsDevFor("gpt-5.6-sol")?.contextWindow).toBe(1000000);
    expect(rt.modelsDevFor("never-seen")).toBeUndefined();
    expect(fetchCount.n).toBe(0);
  });

  test("cold scheduleModelsDevRefresh fetches once; second schedule stays gated", async () => {
    const { rt, fetchCount } = makeIo();
    rt.scheduleModelsDevRefresh("gpt-5.6-sol");
    // Wait for fire-and-forget inflight to settle.
    for (let i = 0; i < 20 && fetchCount.n === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(fetchCount.n).toBe(1);

    // Fresh entry → second schedule must not re-fetch.
    rt.scheduleModelsDevRefresh("gpt-5.6-sol");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCount.n).toBe(1);
  });

  test("fetchJson throw does not write miss; sets failedAt; cooldown blocks second", async () => {
    const { rt, fs, fetchCount } = makeIo({
      fetchJson: async () => {
        throw new Error("network down");
      },
    });
    await rt.refreshCapabilities(["gpt-5.6-sol"]);
    expect(fetchCount.n).toBe(1);
    expect(rt.rawCacheEntry("gpt-5.6-sol")).toBeUndefined();
    expect(fs.store[piSwitchCachePath("/home/test")]).toBeUndefined();
    const fail = rt.lastRefreshFailure();
    expect(fail?.message).toContain("network down");

    // Schedule during cooldown → no second fetch.
    rt.scheduleModelsDevRefresh("gpt-5.6-sol");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCount.n).toBe(1);
  });

  test("legacy positive-only cache format still works (no missing field)", () => {
    const cachePath = piSwitchCachePath("/home/test");
    const { rt, fetchCount } = makeIo({
      fs: memFs({
        [cachePath]: JSON.stringify({
          version: 1,
          updatedAt: "2026-07-01T00:00:00Z",
          capabilities: {
            "gpt-5.6-sol": {
              contextWindow: 1000000,
              maxTokens: 384000,
              reasoning: true,
              vision: true,
              observedAt: "2026-04-24",
              source: "models-dev",
            },
          },
        }),
      }),
    });
    expect(rt.modelsDevFor("gpt-5.6-sol")?.maxTokens).toBe(384000);
    expect(isModelsDevMiss(rt.rawCacheEntry("gpt-5.6-sol"))).toBe(false);
    expect(fetchCount.n).toBe(0);
  });

  test("capabilitiesInflight dedupes concurrent refreshCapabilities", async () => {
    let resolveFetch!: (v: unknown) => void;
    const gate = new Promise<unknown>((r) => {
      resolveFetch = r;
    });
    const { rt, fetchCount } = makeIo({
      fetchJson: async () => gate,
    });
    const p1 = rt.refreshCapabilities(["a"]);
    const p2 = rt.refreshCapabilities(["b"]);
    expect(p1).toBe(p2);
    resolveFetch(SAMPLE_CATALOG);
    await p1;
    expect(fetchCount.n).toBe(1);
  });

  test("MODELS_DEV_API_URL is requested on refresh", async () => {
    const urls: string[] = [];
    const { rt } = makeIo({
      fetchJson: async (url) => {
        urls.push(url);
        return SAMPLE_CATALOG;
      },
    });
    await rt.refreshCapabilities(["x"]);
    expect(urls).toEqual([MODELS_DEV_API_URL]);
  });
});
