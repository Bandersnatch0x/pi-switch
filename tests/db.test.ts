import { test, expect, describe } from "bun:test";
import {
  parseTableInfo,
  hasCompositeId,
  readProviders,
  type DbReaderDeps,
} from "../src/db.ts";

/** sqlite3 CLI `-json PRAGMA table_info(providers)` output shapes. */
const V16_TABLE_INFO = JSON.stringify([
  { cid: 0, name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
  { cid: 1, name: "app_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
  { cid: 2, name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { cid: 3, name: "settings_config", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { cid: 4, name: "is_current", type: "INTEGER", notnull: 0, dflt_value: "0", pk: 0 },
  { cid: 5, name: "website_url", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { cid: 6, name: "notes", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { cid: 7, name: "meta", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { cid: 8, name: "category", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { cid: 9, name: "sort_index", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
]);

const LEGACY_TABLE_INFO = JSON.stringify([
  { cid: 0, name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
  { cid: 1, name: "app_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { cid: 2, name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { cid: 3, name: "settings_config", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { cid: 4, name: "is_current", type: "INTEGER", notnull: 0, dflt_value: "0", pk: 0 },
  { cid: 5, name: "website_url", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { cid: 6, name: "notes", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { cid: 7, name: "meta", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { cid: 8, name: "provider_type", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  { cid: 9, name: "sort_index", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
]);

function makeDeps(opts: {
  tableInfo?: string;
  select?: string;
  probeFails?: boolean;
  selectFails?: boolean;
  userVersion?: string;
}): DbReaderDeps {
  let calls = 0;
  const { tableInfo = V16_TABLE_INFO, select, probeFails, selectFails, userVersion } = opts;
  return {
    execFileSync(file, args, _o) {
      const isProbe = args.includes("PRAGMA table_info(providers)");
      if (isProbe) {
        if (probeFails) throw new Error("probe boom");
        return tableInfo;
      }
      if (args.includes("PRAGMA user_version")) {
        return userVersion ?? JSON.stringify([{ user_version: 16 }]);
      }
      calls += 1;
      if (selectFails) throw new Error("select boom");
      if (select !== undefined) return select;
      throw new Error("no select stub");
    },
    existsSync: () => true,
    sqlite3Path: "sqlite3",
    dbPath: "/fake/cc-switch.db",
  };
}

const V16_SELECT = JSON.stringify([
  {
    id: "id-a",
    app_type: "claude",
    name: "sbai",
    settings_config: JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "https://relay.example/v1", ANTHROPIC_AUTH_TOKEN: "sk-x" },
    }),
    is_current: 1,
    website_url: null,
    notes: null,
    meta: null,
    category: "third_party",
    sort_index: 0,
  },
  {
    id: "id-a",
    app_type: "codex",
    name: "official-codex",
    settings_config: JSON.stringify({ auth: {} }),
    is_current: 0,
    website_url: null,
    notes: null,
    meta: null,
    category: "official",
    sort_index: 1,
  },
]);

describe("parseTableInfo", () => {
  test("extracts column names from PRAGMA -json output", () => {
    const cols = parseTableInfo(V16_TABLE_INFO);
    expect(cols).toContain("id");
    expect(cols).toContain("app_type");
    expect(cols).toContain("category");
    expect(cols).not.toContain("provider_type");
  });

  test("empty / malformed input yields []", () => {
    expect(parseTableInfo("")).toEqual([]);
    expect(parseTableInfo("not json")).toEqual([]);
    expect(parseTableInfo("[1,2,3]")).toEqual([]);
  });
});

describe("hasCompositeId", () => {
  test("v16 (id, app_type) composite PK detected", () => {
    expect(hasCompositeId(V16_TABLE_INFO)).toBe(true);
  });

  test("legacy single id PK not composite", () => {
    expect(hasCompositeId(LEGACY_TABLE_INFO)).toBe(false);
  });
});

describe("readProviders schema probing", () => {
  test("v16 schema: category column used, capabilities reported, category surfaced", () => {
    const deps = makeDeps({ select: V16_SELECT });
    const r = readProviders(deps);
    expect(r.ok).toBe(true);
    expect(r.capabilities?.hasCategory).toBe(true);
    expect(r.capabilities?.hasProviderType).toBe(false);
    expect(r.capabilities?.compositeId).toBe(true);
    expect(r.capabilities?.columns).toContain("category");
    expect(r.capabilities?.userVersion).toBe(16);
    expect(r.providers).toHaveLength(2);
    // Same id across app types is kept distinct (composite identity read path).
    expect(r.providers.map((p) => `${p.appType}/${p.id}`).sort()).toEqual([
      "claude/id-a",
      "codex/id-a",
    ]);
    const claude = r.providers.find((p) => p.appType === "claude")!;
    expect(claude.category).toBe("third_party");
    expect(claude.baseUrl).toBe("https://relay.example/v1");
    expect(claude.apiKey).toBe("sk-x");
    const official = r.providers.find((p) => p.appType === "codex")!;
    expect(official.category).toBe("official");
    expect(official.parseError).toBeTruthy();
    // category=official without direct creds → managed-auth label (not a
    // confusing missing-credential error).
    expect(official.parseError).toContain("凭据由 cc-switch 托管");
  });

  test("legacy schema: provider_type present, no category, single-id PK", () => {
    const deps = makeDeps({
      tableInfo: LEGACY_TABLE_INFO,
      select: JSON.stringify([
        {
          id: "legacy-1",
          app_type: "claude",
          name: "old",
          settings_config: JSON.stringify({
            env: { ANTHROPIC_BASE_URL: "https://a.example", ANTHROPIC_AUTH_TOKEN: "k" },
          }),
          is_current: 1,
          website_url: null,
          notes: null,
          meta: null,
          provider_type: "anthropic",
          sort_index: 0,
        },
      ]),
    });
    const r = readProviders(deps);
    expect(r.ok).toBe(true);
    expect(r.capabilities?.hasProviderType).toBe(true);
    expect(r.capabilities?.hasCategory).toBe(false);
    expect(r.capabilities?.compositeId).toBe(false);
    expect(r.providers[0]?.category).toBeUndefined();
    expect(r.providers[0]?.baseUrl).toBe("https://a.example");
  });

  test("user_version probe failure keeps capabilities (informational only)", () => {
    const deps = makeDeps({ select: V16_SELECT, userVersion: "not-json" });
    const r = readProviders(deps);
    expect(r.ok).toBe(true);
    expect(r.capabilities?.hasCategory).toBe(true);
    expect(r.capabilities?.userVersion).toBeUndefined();
  });

  test("probe failure falls back to core columns and still reads", () => {
    const deps = makeDeps({
      probeFails: true,
      select: JSON.stringify([
        {
          id: "x",
          app_type: "hermes",
          name: "h",
          settings_config: JSON.stringify({
            base_url: "https://h.example",
            api_key: "k",
            api_mode: "openai",
          }),
          is_current: 0,
          website_url: null,
          notes: null,
          meta: null,
          sort_index: 0,
        },
      ]),
    });
    const r = readProviders(deps);
    expect(r.ok).toBe(true);
    expect(r.capabilities).toBeUndefined();
    expect(r.providers[0]?.baseUrl).toBe("https://h.example/v1"); // host-only openai → /v1 normalization
  });

  test("SELECT failure keeps last-good semantics: ok=false + error + capabilities", () => {
    const deps = makeDeps({ selectFails: true });
    const r = readProviders(deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("sqlite3 failed");
    expect(r.capabilities?.compositeId).toBe(true);
  });

  test("missing DB file → ok=false database not found", () => {
    const deps = makeDeps({ selectFails: true });
    deps.existsSync = () => false;
    const r = readProviders(deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("database not found");
  });
});
