import { test, expect, describe } from "bun:test";
import {
  extractSemver,
  readPackageVersion,
  resolveVersion,
  detectCliVersion,
  codexCandidatePaths,
  claudeCandidatePaths,
  geminiCandidatePaths,
  detectOsInfo,
  buildHeaderVars,
  FALLBACK_CODEX_VERSION,
  FALLBACK_CLAUDE_CODE_VERSION,
  type ProbeDeps,
} from "../src/headers/vars.ts";

/** Build a fake ProbeDeps with controllable exec/file behavior. */
function fakeDeps(over: Partial<{
  execOut: (file: string, args: string[]) => string | undefined;
  files: Record<string, string>;
  platform: string;
  arch: string;
  release: string;
  homedir: string;
}> = {}): ProbeDeps {
  const execOut = over.execOut ?? (() => undefined);
  const files = over.files ?? {};
  return {
    execFileSync: (file, args) => {
      const r = execOut(file, args);
      if (r === undefined) throw new Error("exec fake miss");
      return r;
    },
    existsSync: (p) => p in files,
    readFileSync: (p) => files[p] ?? "",
    platform: over.platform ?? "linux",
    arch: over.arch ?? "x64",
    release: over.release ?? "6.1.0",
    homedir: over.homedir ?? "/home/u",
  };
}

describe("extractSemver", () => {
  test("pulls semver from CLI output", () => {
    expect(extractSemver("codex-cli 0.144.5\n")).toBe("0.144.5");
    expect(extractSemver("claude-code v2.1.190 (build 1234)")).toBe("2.1.190");
  });
  test("returns undefined on no match", () => {
    expect(extractSemver("not a version")).toBeUndefined();
  });
});

describe("readPackageVersion", () => {
  test("reads version from package.json", () => {
    const d = fakeDeps({ files: { "/x/p.json": JSON.stringify({ version: "1.2.3" }) } });
    expect(readPackageVersion(d, "/x/p.json")).toBe("1.2.3");
  });
  test("undefined when file missing or malformed", () => {
    const d = fakeDeps();
    expect(readPackageVersion(d, "/nope.json")).toBeUndefined();
    const d2 = fakeDeps({ files: { "/p": "not json{" } });
    expect(readPackageVersion(d2, "/p")).toBeUndefined();
  });
});

describe("resolveVersion", () => {
  test("config wins", () => {
    const r = resolveVersion("9.9.9", () => "1.0.0", "0.0.0");
    expect(r).toEqual({ version: "9.9.9", source: "config" });
  });
  test("local detection next", () => {
    const r = resolveVersion(undefined, () => "3.3.3", "0.0.0");
    expect(r).toEqual({ version: "3.3.3", source: "local" });
  });
  test("fallback last", () => {
    const r = resolveVersion(undefined, () => undefined, "0.141.0");
    expect(r).toEqual({ version: "0.141.0", source: "fallback" });
  });
});

describe("detectCliVersion", () => {
  test("uses CLI --version first", () => {
    const d = fakeDeps({
      execOut: (f, a) => (f === "codex" && a[0] === "--version" ? "codex 0.144.5" : undefined),
    });
    expect(detectCliVersion(d, "codex", "@openai/codex", [])).toBe("0.144.5");
  });
  test("falls to npm root -g + package.json", () => {
    const d = fakeDeps({
      execOut: (f) => (f === "npm" ? "/global/root" : undefined),
      files: { "/global/root/@openai/codex/package.json": JSON.stringify({ version: "0.140.0" }) },
    });
    expect(detectCliVersion(d, "codex", "@openai/codex", [])).toBe("0.140.0");
  });
  test("falls to candidate path list", () => {
    const d = fakeDeps({
      execOut: () => undefined,
      files: { "/opt/codex/package.json": JSON.stringify({ version: "0.130.0" }) },
    });
    expect(detectCliVersion(d, "codex", "@openai/codex", ["/opt/codex/package.json"])).toBe(
      "0.130.0",
    );
  });
  test("undefined when all sources miss", () => {
    const d = fakeDeps();
    expect(detectCliVersion(d, "codex", "@openai/codex", [])).toBeUndefined();
  });
});

describe("candidate paths", () => {
  test("codex paths include unix + windows roots", () => {
    const p = codexCandidatePaths("/home/u");
    expect(p.length).toBeGreaterThanOrEqual(3);
    expect(p.every((x) => x.endsWith("/package.json") || x.endsWith("\\package.json"))).toBe(true);
    expect(p.some((x) => x.includes("@openai/codex"))).toBe(true);
  });
  test("claude paths include unix + windows roots", () => {
    const p = claudeCandidatePaths("/home/u");
    expect(p.length).toBeGreaterThanOrEqual(3);
    expect(p.every((x) => x.includes("claude-code"))).toBe(true);
  });
  test("gemini paths include google + bare package names", () => {
    const p = geminiCandidatePaths("/home/u");
    expect(p.length).toBeGreaterThanOrEqual(3);
    expect(p.some((x) => x.includes("@google/gemini-cli"))).toBe(true);
  });
});

describe("detectOsInfo", () => {
  test("windows shape: Windows <release>; <arch>", () => {
    const d = fakeDeps({ platform: "win32", release: "10.0.26200", arch: "x64" });
    expect(detectOsInfo(d)).toBe("Windows 10.0.26200; x64");
  });
  test("darwin uses sw_vers productVersion over kernel release", () => {
    const d = fakeDeps({
      platform: "darwin",
      release: "24.0.0", // Darwin kernel — should NOT be used
      arch: "arm64",
      execOut: (f, a) =>
        f === "sw_vers" && a[0] === "-productVersion" ? "15.7.2" : undefined,
    });
    expect(detectOsInfo(d)).toBe("MacOS 15.7.2; arm64");
  });
  test("darwin falls back to os.release when sw_vers unavailable", () => {
    const d = fakeDeps({ platform: "darwin", release: "24.1.0", arch: "arm64" });
    expect(detectOsInfo(d)).toBe("MacOS 24.1.0; arm64");
  });
  test("linux shape", () => {
    const d = fakeDeps({ platform: "linux", release: "6.6.0", arch: "x64" });
    expect(detectOsInfo(d)).toBe("Linux 6.6.0; x64");
  });
});

describe("buildHeaderVars", () => {
  test("configured versions override detection", () => {
    const d = fakeDeps({
      execOut: (f, a) => (f === "codex" && a[0] === "--version" ? "0.999.0" : undefined),
    });
    const v = buildHeaderVars(d, { codexVersion: "1.1.1" });
    expect(v.codexVersion).toBe("1.1.1");
    expect(v.codexVersionSource).toBe("config");
    // claude not configured, not detected → fallback
    expect(v.claudeCodeVersion).toBe(FALLBACK_CLAUDE_CODE_VERSION);
    expect(v.claudeCodeVersionSource).toBe("fallback");
  });
  test("detection fills when not configured", () => {
    const d = fakeDeps({
      execOut: (f, a) =>
        f === "claude" && a[0] === "--version" ? "claude-code 2.5.0" : undefined,
      platform: "win32",
      release: "10.0.19045",
      arch: "x64",
    });
    const v = buildHeaderVars(d);
    expect(v.claudeCodeVersion).toBe("2.5.0");
    expect(v.claudeCodeVersionSource).toBe("local");
    expect(v.codexVersion).toBe(FALLBACK_CODEX_VERSION);
    expect(v.osInfo).toBe("Windows 10.0.19045; x64");
  });
  test("fallback constants are current (not the stale 1.0.0)", () => {
    // Regression: old code hardcoded claudeCodeVersion "1.0.0" which contradicts
    // the bundled anthropic-beta "claude-code-20250219" flags — a fingerprint mismatch.
    expect(FALLBACK_CLAUDE_CODE_VERSION).not.toBe("1.0.0");
    expect(FALLBACK_CODEX_VERSION).not.toBe("0.144.0");
  });
  test("includes codex originator + anthropic beta fingerprint fields", () => {
    const d = fakeDeps();
    const v = buildHeaderVars(d);
    expect(v.codexOriginator).toBeTruthy();
    expect(v.anthropicVersion).toBe("2023-06-01");
    expect(v.anthropicBeta).toContain("claude-code-");
    expect(v.geminiVersion).toBeTruthy();
  });
  test("config can override fingerprint fields", () => {
    const d = fakeDeps();
    const v = buildHeaderVars(d, {
      anthropicBeta: "custom-beta",
      codexOriginator: "custom_originator",
      geminiVersion: "9.9.9",
    });
    expect(v.anthropicBeta).toBe("custom-beta");
    expect(v.codexOriginator).toBe("custom_originator");
    expect(v.geminiVersion).toBe("9.9.9");
    expect(v.geminiVersionSource).toBe("config");
  });
});
