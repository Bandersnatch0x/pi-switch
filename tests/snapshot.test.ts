import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { mergeHeaders } from "../src/headers/merge.ts";
import { parseHeaderRulesFile } from "../src/headers/rules.ts";
import { HEADER_ALLOWLIST, type PiApi } from "../src/types.ts";
import {
  FALLBACK_ANTHROPIC_BETA,
  FALLBACK_ANTHROPIC_VERSION,
  FALLBACK_CLAUDE_CODE_VERSION,
  FALLBACK_CODEX_ORIGINATOR,
  FALLBACK_CODEX_VERSION,
  FALLBACK_GEMINI_VERSION,
} from "../src/headers/vars.ts";

interface SnapshotShape {
  "User-Agent": string;
  originator?: string;
  "anthropic-version"?: string;
  "anthropic-beta"?: string;
  "x-goog-api-client"?: string;
}

interface SnapshotFile {
  snapshotVersion: number;
  observedAt: string;
  upstream: {
    codex: { version: string; source: string };
    claudeCode: { version: string; source: string };
    gemini: { version: string; source: string };
    anthropicVersion: string;
    anthropicBeta: string;
    originator: string;
  };
  shapes: Record<"codex" | "claudeCode" | "gemini", SnapshotShape>;
}

function loadSnapshot(): SnapshotFile {
  return JSON.parse(
    readFileSync("defaults/fingerprint-snapshot.json", "utf8"),
  ) as SnapshotFile;
}

const snapshot = loadSnapshot();

const OS_INFO = "Windows 10.0; x64";

/** Map shape key to the mergeHeaders api selector. */
const API_BY_SHAPE: Record<keyof SnapshotFile["shapes"], PiApi> = {
  codex: "openai-responses",
  claudeCode: "anthropic-messages",
  gemini: "google-generative-ai",
};

/** Render a shape template (contains {osInfo}) with the fixed fixture. */
function render(shape: SnapshotShape): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(shape)) {
    out[k] = v.replace("{osInfo}", OS_INFO);
  }
  return out;
}

describe("fingerprint snapshot (#12)", () => {
  test("golden shapes: fixed fallback vars reproduce every snapshot shape exactly", () => {
    const { upstream } = snapshot;
    const vars = {
      codexVersion: upstream.codex.version,
      claudeCodeVersion: upstream.claudeCode.version,
      geminiVersion: upstream.gemini.version,
      osInfo: OS_INFO,
      anthropicVersion: upstream.anthropicVersion,
      anthropicBeta: upstream.anthropicBeta,
      codexOriginator: upstream.originator,
    };
    for (const [shapeKey, shape] of Object.entries(snapshot.shapes)) {
      const api = API_BY_SHAPE[shapeKey as keyof SnapshotFile["shapes"]];
      const out = mergeHeaders({ api, rules: parseHeaderRulesFile(JSON.parse(readFileSync("defaults/headers.json", "utf8"))), vars });
      expect(out).toEqual(render(shape));
    }
  });

  test("single source of truth: fallback constants equal snapshot upstream values", () => {
    const { upstream } = snapshot;
    expect(FALLBACK_CODEX_VERSION).toBe(upstream.codex.version);
    expect(FALLBACK_CLAUDE_CODE_VERSION).toBe(upstream.claudeCode.version);
    expect(FALLBACK_GEMINI_VERSION).toBe(upstream.gemini.version);
    expect(FALLBACK_ANTHROPIC_VERSION).toBe(upstream.anthropicVersion);
    expect(FALLBACK_ANTHROPIC_BETA).toBe(upstream.anthropicBeta);
    expect(FALLBACK_CODEX_ORIGINATOR).toBe(upstream.originator);
  });

  test("no-leak batch: every shape key is allowlisted and values carry no secret shapes", () => {
    const secret = /(sk-|Bearer\s|key\s*=|api[_-]?key)/i;
    for (const shape of Object.values(snapshot.shapes)) {
      for (const [k, v] of Object.entries(shape)) {
        expect(HEADER_ALLOWLIST.has(k.toLowerCase())).toBe(true);
        expect(v).not.toMatch(secret);
      }
    }
  });

  test("provenance: snapshot is versioned, dated, and sources are re-runnable", () => {
    expect(snapshot.snapshotVersion).toBeGreaterThanOrEqual(1);
    expect(snapshot.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const entry of Object.values(snapshot.upstream)) {
      if (typeof entry === "object" && "source" in entry) {
        expect(entry.source.startsWith("npm:")).toBe(true);
      }
    }
    expect(snapshot.upstream.originator).toBe("codex_cli_rs");
  });
});
