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
