import { test, expect, describe, afterAll } from "bun:test";
import {
  detectLocale,
  setLocale,
  getLocale,
  t,
  STRINGS,
} from "../src/ui/tui-locale.ts";

function withLocale(
  overrides: Record<string, string | undefined>,
  fn: () => void,
) {
  const keys = ["LANG", "LC_ALL", "LANGUAGE", "PI_SWITCH_LOCALE"] as const;
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  try {
    for (const k of keys) {
      if (overrides[k] === undefined) delete process.env[k];
      else process.env[k] = overrides[k] as string;
    }
    fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k] as string;
    }
  }
}

describe("detectLocale", () => {
  test("zh_CN LANG -> zh", () => {
    withLocale({ LANG: "zh_CN.UTF-8" }, () => expect(detectLocale()).toBe("zh"));
  });
  test("zh_TW LC_ALL -> zh", () => {
    withLocale({ LC_ALL: "zh_TW" }, () => expect(detectLocale()).toBe("zh"));
  });
  test("en_US LANG -> en", () => {
    withLocale({ LANG: "en_US.UTF-8" }, () => expect(detectLocale()).toBe("en"));
  });
  test("no locale env -> en (default)", () => {
    withLocale({}, () => expect(detectLocale()).toBe("en"));
  });
  test("PI_SWITCH_LOCALE overrides LANG", () => {
    withLocale({ LANG: "zh_CN.UTF-8", PI_SWITCH_LOCALE: "en" }, () =>
      expect(detectLocale()).toBe("en"),
    );
    withLocale({ LANG: "en_US.UTF-8", PI_SWITCH_LOCALE: "zh" }, () =>
      expect(detectLocale()).toBe("zh"),
    );
  });
});

describe("translation table", () => {
  test("zh and en share the same key set", () => {
    expect(Object.keys(STRINGS.zh).sort()).toEqual(
      Object.keys(STRINGS.en).sort(),
    );
  });

  test("t() reflects the active locale", () => {
    setLocale("zh");
    expect(t("pin")).toBe("固定");
    expect(t("pass")).toBe("通过");
    setLocale("en");
    expect(t("pin")).toBe("pin");
    expect(t("pass")).toBe("PASS");
  });

  test("status words stay English in en, Chinese in zh", () => {
    setLocale("en");
    expect(t("warn")).toBe("WARN");
    expect(t("fail")).toBe("FAIL");
    setLocale("zh");
    expect(t("warn")).toBe("警告");
    expect(t("fail")).toBe("失败");
  });

  afterAll(() => setLocale("en"));
});

describe("getLocale", () => {
  test("returns the active locale", () => {
    setLocale("zh");
    expect(getLocale()).toBe("zh");
    setLocale("en");
    expect(getLocale()).toBe("en");
  });
  afterAll(() => setLocale("en"));
});
