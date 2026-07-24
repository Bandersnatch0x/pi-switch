import { test, expect, describe } from "bun:test";
import { mapKnownApi, resolveApi, apiFromOpencodeNpm } from "../src/parse/api-format.ts";

describe("mapKnownApi", () => {
  test("maps common aliases", () => {
    expect(mapKnownApi("anthropic_messages")).toBe("anthropic-messages");
    expect(mapKnownApi("responses")).toBe("openai-responses");
    expect(mapKnownApi("chat/completions")).toBe("openai-completions");
    expect(mapKnownApi("google-generative-ai")).toBe("google-generative-ai");
  });
});

describe("resolveApi", () => {
  test("explicit unknown apiFormat does not fall back", () => {
    const r = resolveApi({
      apiFormat: "weird-protocol-v9",
      typeHint: "responses",
      appTypeDefault: "openai-responses",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("unsupported apiFormat");
  });

  test("explicit known apiFormat wins", () => {
    const r = resolveApi({
      apiFormat: "anthropic",
      typeHint: "responses",
      appTypeDefault: "openai-responses",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.api).toBe("anthropic-messages");
      expect(r.source).toBe("apiFormat");
    }
  });

  test("type hint used when no apiFormat", () => {
    const r = resolveApi({
      typeHint: "chat",
      appTypeDefault: "openai-responses",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.api).toBe("openai-completions");
  });

  test("appType default when nothing else", () => {
    const r = resolveApi({ appTypeDefault: "google-generative-ai" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.api).toBe("google-generative-ai");
      expect(r.source).toBe("appTypeDefault");
    }
  });
});

describe("apiFromOpencodeNpm", () => {
  test("anthropic package", () => {
    expect(apiFromOpencodeNpm("@ai-sdk/anthropic")).toBe("anthropic-messages");
  });
  test("openai-compatible package", () => {
    expect(apiFromOpencodeNpm("@ai-sdk/openai-compatible")).toBe("openai-completions");
  });
});
