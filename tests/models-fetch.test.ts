import { test, expect, describe } from "bun:test";
import {
  buildModelUrlCandidates,
  deriveFromFullUrl,
  extractModelIds,
  fetchRemoteModels,
  firstListedModel,
  mergeModelLists,
  resolveListedModel,
} from "../src/models-fetch.ts";

function recordingFetch(body: unknown) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, headers: new Headers(init?.headers) });
    return Response.json(body);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

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

  test("native Gemini keeps an existing models endpoint", () => {
    expect(
      buildModelUrlCandidates({
        api: "google-generative-ai",
        authHeader: false,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
      }),
    ).toEqual(["https://generativelanguage.googleapis.com/v1beta/models"]);
  });

  test("native Gemini derives models endpoint from a full request URL", () => {
    expect(
      buildModelUrlCandidates({
        api: "google-generative-ai",
        authHeader: false,
        baseUrl:
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
        isFullUrl: true,
      }),
    ).toEqual(["https://generativelanguage.googleapis.com/v1beta/models"]);
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

  test("filters bracket 1M / 1m model tags", () => {
    expect(
      mergeModelLists(
        ["claude-opus-5", "claude-opus-5[1M]", "claude-fable-5[1m]"],
        ["claude-opus-5[1M]", "other"],
      ),
    ).toEqual(["claude-opus-5", "other"]);
  });
});

describe("resolveListedModel", () => {
  test("maps preferred [1M] tag to plain id when listed", () => {
    expect(
      resolveListedModel(["claude-opus-5", "claude-opus-5[1M]"], "claude-opus-5[1M]"),
    ).toBe("claude-opus-5");
  });

  test("firstListedModel skips tags", () => {
    expect(firstListedModel(["x[1M]", "y"])).toBe("y");
  });
});

describe("extractModelIds", () => {
  test("reads data[].id", () => {
    expect(extractModelIds({ data: [{ id: "m1" }, { id: "m2" }] })).toEqual(["m1", "m2"]);
  });
});

describe("fetchRemoteModels protocol requests", () => {
  test("native Anthropic API key uses x-api-key instead of Bearer", async () => {
    const { calls, fetchImpl } = recordingFetch({ data: [{ id: "claude-sonnet-4" }] });

    const result = await fetchRemoteModels({
      api: "anthropic-messages",
      authHeader: false,
      baseUrl: "https://api.anthropic.com",
      apiKey: "secret",
      fetchImpl,
    });

    expect(result.models).toEqual(["claude-sonnet-4"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/models");
    expect(calls[0]?.headers.get("x-api-key")).toBe("secret");
    expect(calls[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });

  test("native Gemini uses v1beta, x-goog-api-key, and models[].name", async () => {
    const { calls, fetchImpl } = recordingFetch({
      models: [{ name: "models/gemini-2.5-pro" }],
    });

    const result = await fetchRemoteModels({
      api: "google-generative-ai",
      authHeader: false,
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "secret",
      fetchImpl,
    });

    expect(result.models).toEqual(["gemini-2.5-pro"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(calls[0]?.headers.get("x-goog-api-key")).toBe("secret");
    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });

  test("Gemini-compatible gateway keeps OpenAI model discovery", async () => {
    const { calls, fetchImpl } = recordingFetch({ data: [{ id: "gemini-2.5-pro" }] });

    const result = await fetchRemoteModels({
      api: "google-generative-ai",
      authHeader: true,
      baseUrl: "https://gateway.example.com",
      apiKey: "secret",
      fetchImpl,
    });

    expect(result.models).toEqual(["gemini-2.5-pro"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://gateway.example.com/v1/models");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer secret");
    expect(calls[0]?.headers.get("x-goog-api-key")).toBeNull();
  });
});
