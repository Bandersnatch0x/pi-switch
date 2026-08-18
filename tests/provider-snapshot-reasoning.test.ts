import { describe, expect, test } from "bun:test";
import { ProviderSnapshot } from "../src/provider-snapshot.ts";

const TABLE_INFO = JSON.stringify([
  { name: "id", pk: 1 },
  { name: "app_type", pk: 2 },
  { name: "name", pk: 0 },
  { name: "settings_config", pk: 0 },
  { name: "is_current", pk: 0 },
  { name: "website_url", pk: 0 },
  { name: "notes", pk: 0 },
  { name: "meta", pk: 0 },
  { name: "sort_index", pk: 0 },
  { name: "category", pk: 0 },
]);

function makeSnapshot() {
  let failSelect = false;
  const rows = [
    {
      id: "p1",
      app_type: "codex",
      name: "catalog provider",
      settings_config: JSON.stringify({
        auth: { OPENAI_API_KEY: "key" },
        config: `model = "gpt-5.6-sol"\nmodel_provider = "relay"\nwire_api = "responses"\n[model_providers.relay]\nbase_url = "https://relay.example/v1"`,
        modelCatalog: {
          models: [
            {
              slug: "gpt-5.6-sol",
              supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }],
            },
          ],
        },
      }),
      is_current: 1,
      website_url: null,
      notes: null,
      meta: null,
      category: "third_party",
      sort_index: 0,
    },
  ];
  const snapshot = new ProviderSnapshot({
    home: "C:/Users/test",
    existsSync: () => true,
    execFileSync: (_file, args) => {
      const sql = args[args.length - 1] ?? "";
      if (sql.includes("PRAGMA table_info")) return TABLE_INFO;
      if (sql.includes("PRAGMA user_version")) return JSON.stringify([{ user_version: 16 }]);
      if (failSelect) throw new Error("database is busy");
      return JSON.stringify(rows);
    },
    now: () => 1_755_388_800_000,
  });
  return {
    snapshot,
    fail: () => {
      failSelect = true;
    },
  };
}

describe("ProviderSnapshot reasoning catalog freshness", () => {
  test("keeps one ingestion timestamp for all parsed provider profiles", () => {
    const { snapshot } = makeSnapshot();
    const result = snapshot.refresh();
    expect(result.providers[0]?.reasoningCatalog?.observedAt).toBe(
      "2025-08-17T00:00:00.000Z",
    );
    expect(result.providers[0]?.reasoningCatalog?.stale).toBeUndefined();
  });

  test("marks last-good reasoning facts stale when the database read falls back", () => {
    const { snapshot, fail } = makeSnapshot();
    snapshot.refresh();
    fail();

    const result = snapshot.refresh();
    expect(result.error).toContain("database is busy");
    expect(result.providers[0]?.reasoningCatalog?.stale).toBe(true);
    expect(snapshot.lastGoodProviders[0]?.reasoningCatalog?.stale).toBe(true);
  });
});
