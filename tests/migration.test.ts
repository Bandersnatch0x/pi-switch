import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateIdentityState } from "../src/migration.ts";
import { SETTINGS_KEY } from "../src/types.ts";
import { resolveProviderOverride } from "../src/provider-override.ts";
import type { CcProvider } from "../src/types.ts";

function mkProvider(id: string, appType: string, displayName: string): CcProvider {
  return {
    id,
    appType,
    displayName,
    piName: displayName,
    api: "openai-responses",
    baseUrl: "https://x.example",
    apiKey: "k",
    authHeader: true,
    configModels: ["m1"],
    meta: {},
    isCurrentInCc: false,
  };
}

const CODE = mkProvider("codex-1", "codex", "codexA");
const GEMINI = mkProvider("gem-1", "gemini", "gemA");
const PROVIDERS = [CODE, GEMINI];

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "pi-switch-mig-"));
  const settingsPath = join(dir, "settings.json");
  const configPath = join(dir, "pi-switch.json");
  const fs = {
    existsSync,
    readFileSync: (p: string, enc?: BufferEncoding) => readFileSync(p, enc as BufferEncoding),
    writeFileSync: (p: string, d: string, enc?: BufferEncoding) => writeFileSync(p, d, enc as BufferEncoding),
    renameSync: (a: string, b: string) => require("node:fs").renameSync(a, b),
  };
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, settingsPath, configPath, fs, cleanup };
}

function doc(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("migrateIdentityState (#16)", () => {
  test("single-hit migration: selection/pins/recent get appType; override moves to nested", () => {
    const env = makeEnv();
    try {
      writeFileSync(
        env.settingsPath,
        JSON.stringify({ [SETTINGS_KEY]: { dbId: "codex-1", model: "m1" } }),
      );
      writeFileSync(
        env.configPath,
        JSON.stringify({
          pins: [{ dbId: "gem-1", model: "m2" }],
          recent: [{ dbId: "codex-1", model: "m1", at: 1 }],
          providerOverrides: { "codex-1": { label: "l" } },
        }),
      );
      const s = migrateIdentityState({
        fs: env.fs,
        settingsPath: env.settingsPath,
        configPath: env.configPath,
        providers: PROVIDERS,
        pid: 1,
        now: Date.parse("2026-07-31T00:00:00Z"),
      });
      expect(s.migrated).toBeGreaterThanOrEqual(3);
      expect(s.ambiguous).toBe(0);

      const settings = doc(env.settingsPath);
      expect(settings[SETTINGS_KEY]).toMatchObject({ dbId: "codex-1", appType: "codex" });
      expect((settings.piSwitchMigration as { version?: number } | undefined)?.version).toBe(1);

      const config = doc(env.configPath);
      expect(config.pins).toEqual([{ dbId: "gem-1", model: "m2", appType: "gemini" }]);
      expect(config.recent).toEqual([{ dbId: "codex-1", model: "m1", at: 1, appType: "codex" }]);
      expect(config.providerOverrides).toEqual({ codex: { "codex-1": { label: "l" } } });
      expect((config.piSwitchMigration as { version?: number } | undefined)?.version).toBe(1);

      // backups exist
      expect(existsSync(`${env.settingsPath}.bak-${Date.parse("2026-07-31T00:00:00Z")}`)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  test("ambiguous (same id across app types) keeps entries, never guesses", () => {
    const env = makeEnv();
    try {
      const dup = mkProvider("shared-id", "claude", "claudeX");
      const provs = [CODE, mkProvider("shared-id", "codex", "codexY"), dup];
      writeFileSync(env.settingsPath, JSON.stringify({ [SETTINGS_KEY]: { dbId: "shared-id", model: "m" } }));
      writeFileSync(
        env.configPath,
        JSON.stringify({ providerOverrides: { "shared-id": { label: "ambig" } } }),
      );
      const s = migrateIdentityState({
        fs: env.fs,
        settingsPath: env.settingsPath,
        configPath: env.configPath,
        providers: provs,
        pid: 1,
      });
      expect(s.ambiguous).toBeGreaterThanOrEqual(2);
      const settings = doc(env.settingsPath);
      expect((settings[SETTINGS_KEY] as { appType?: string }).appType).toBeUndefined(); // not guessed
      const config = doc(env.configPath);
      const overrides = config.providerOverrides as Record<string, { label?: string }>;
      expect(overrides["shared-id"]).toEqual({ label: "ambig" }); // kept top-level
      // back-compat: top-level key still resolves
      expect(
        resolveProviderOverride(
          overrides as never,
          { id: "shared-id", appType: "codex", piName: "codexY", displayName: "codexY" },
        )?.label,
      ).toBe("ambig");
    } finally {
      env.cleanup();
    }
  });

  test("zero-hit entries are kept as stale, never dropped", () => {
    const env = makeEnv();
    try {
      writeFileSync(env.settingsPath, JSON.stringify({ [SETTINGS_KEY]: { dbId: "gone", model: "m" } }));
      writeFileSync(env.configPath, JSON.stringify({ pins: [{ dbId: "gone", model: "m" }] }));
      const s = migrateIdentityState({
        fs: env.fs,
        settingsPath: env.settingsPath,
        configPath: env.configPath,
        providers: PROVIDERS,
        pid: 1,
      });
      expect(s.stale).toBeGreaterThanOrEqual(2);
      const settings = doc(env.settingsPath);
      expect(settings[SETTINGS_KEY]).toMatchObject({ dbId: "gone" });
      const config = doc(env.configPath);
      expect(config.pins).toEqual([{ dbId: "gone", model: "m" }]); // preserved
    } finally {
      env.cleanup();
    }
  });

  test("idempotent: marker prevents re-migration, no second backup churn", () => {
    const env = makeEnv();
    try {
      writeFileSync(env.settingsPath, JSON.stringify({ [SETTINGS_KEY]: { dbId: "codex-1", model: "m1" } }));
      writeFileSync(env.configPath, JSON.stringify({}));
      const first = migrateIdentityState({
        fs: env.fs,
        settingsPath: env.settingsPath,
        configPath: env.configPath,
        providers: PROVIDERS,
        pid: 1,
      });
      expect(first.migrated).toBe(1);
      const second = migrateIdentityState({
        fs: env.fs,
        settingsPath: env.settingsPath,
        configPath: env.configPath,
        providers: PROVIDERS,
        pid: 2,
      });
      expect(second.skipped).toBe("already-migrated");
      expect((doc(env.settingsPath)[SETTINGS_KEY] as { appType?: string }).appType).toBe("codex");
    } finally {
      env.cleanup();
    }
  });

  test("no usable provider snapshot skips migration", () => {
    const env = makeEnv();
    try {
      writeFileSync(env.settingsPath, JSON.stringify({ [SETTINGS_KEY]: { dbId: "codex-1", model: "m1" } }));
      writeFileSync(env.configPath, JSON.stringify({}));
      const s = migrateIdentityState({
        fs: env.fs,
        settingsPath: env.settingsPath,
        configPath: env.configPath,
        providers: [],
        pid: 1,
      });
      expect(s.skipped).toBe("no-provider-snapshot");
      expect((doc(env.settingsPath)[SETTINGS_KEY] as { appType?: string }).appType).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });
});
