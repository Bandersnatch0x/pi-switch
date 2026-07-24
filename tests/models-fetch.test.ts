import { test, expect, describe } from "bun:test";
import {
  buildModelUrlCandidates,
  deriveFromFullUrl,
  mergeModelLists,
  extractModelIds,
} from "../src/models-fetch.ts";

describe("buildModelUrlCandidates", () => {
  test("modelsUrl override is sole candidate", () => {
    expect(
      buildModelUrlCandidates({
        baseUrl: "https://x.com/v1",
        modelsUrl: "https://custom/models",
      }),
    ).toEqual(["https://custom/models"]);
  });

  test("base ending in /v1 uses /models first", () => {
    expect(buildModelUrlCandidates({ baseUrl: "https://x.com/v1" })).toEqual([
      "https://x.com/v1/models",
    ]);
  });

  test("base ending in /v2 also keeps /v1/models fallback", () => {
    const c = buildModelUrlCandidates({ baseUrl: "https://x.com/v2" });
    expect(c[0]).toBe("https://x.com/v2/models");
    expect(c).toContain("https://x.com/v2/v1/models");
  });

  test("plain base uses /v1/models", () => {
    expect(buildModelUrlCandidates({ baseUrl: "https://x.com" })).toEqual([
      "https://x.com/v1/models",
    ]);
  });

  test("compat suffix adds stripped candidates", () => {
    const c = buildModelUrlCandidates({ baseUrl: "https://x.com/api/coding" });
    expect(c[0]).toBe("https://x.com/api/coding/v1/models");
    expect(c).toContain("https://x.com/v1/models");
    expect(c).toContain("https://x.com/models");
  });

  // Regression: cc-switch KNOWN_COMPAT_SUFFIXES — pi-switch previously carried
  // only 3 of 9, so /claude, /claudecode, /step_plan, /apps/anthropic, /api/claudecode
  // produced NO stripped fallback candidates (root cause of elysiver-claude fetch failing
  // while cc-switch succeeded).
  test("regression: /claude suffix strips to root candidates", () => {
    const c = buildModelUrlCandidates({ baseUrl: "https://www.right.codes/claude" });
    expect(c[0]).toBe("https://www.right.codes/claude/v1/models");
    expect(c).toContain("https://www.right.codes/v1/models");
    expect(c).toContain("https://www.right.codes/models");
  });

  test("regression: /step_plan suffix strips to root candidates", () => {
    const c = buildModelUrlCandidates({ baseUrl: "https://api.stepfun.com/step_plan" });
    expect(c).toContain("https://api.stepfun.com/v1/models");
    expect(c).toContain("https://api.stepfun.com/models");
  });

  test("regression: /api/claudecode suffix strips whole suffix", () => {
    const c = buildModelUrlCandidates({ baseUrl: "https://api.aicodemirror.com/api/claudecode" });
    expect(c).toContain("https://api.aicodemirror.com/v1/models");
    expect(c).toContain("https://api.aicodemirror.com/models");
  });

  test("regression: /apps/anthropic suffix strips to root candidates", () => {
    const c = buildModelUrlCandidates({ baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic" });
    expect(c).toContain("https://dashscope.aliyuncs.com/v1/models");
    expect(c).toContain("https://dashscope.aliyuncs.com/models");
  });

  // Longest-prefix wins: /api/anthropic must strip the WHOLE suffix, not just /anthropic,
  // otherwise the derived root is a broken "…/api" (cc-switch test_candidates_longer_suffix_wins).
  test("longest compat suffix wins: /api/anthropic strips whole suffix", () => {
    const c = buildModelUrlCandidates({ baseUrl: "https://api.z.ai/api/anthropic" });
    expect(c).toContain("https://api.z.ai/v1/models");
    expect(c).toContain("https://api.z.ai/models");
    expect(c.every((u) => !u.includes("/api/v1/models") && !u.includes("/api/models"))).toBe(true);
  });

  test("isFullUrl derives from embedded /v1/", () => {
    expect(
      buildModelUrlCandidates({
        baseUrl: "https://x.com/v1/messages",
        isFullUrl: true,
      }),
    ).toEqual(["https://x.com/v1/models"]);
  });
});

describe("deriveFromFullUrl", () => {
  test("strips final segment when no /v1/", () => {
    const u = deriveFromFullUrl("https://x.com/zen/go/chat");
    expect(u).toBe("https://x.com/zen/go/v1/models");
  });
});

describe("mergeModelLists", () => {
  test("config first exact dedupe preserves case", () => {
    expect(mergeModelLists(["A", "b"], ["b", "C", "A"])).toEqual(["A", "b", "C"]);
  });
});

describe("extractModelIds", () => {
  test("reads data[].id", () => {
    expect(extractModelIds({ data: [{ id: "m1" }, { id: "m2" }] })).toEqual(["m1", "m2"]);
  });
});
