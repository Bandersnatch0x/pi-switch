import { afterAll, describe, expect, test } from "bun:test";
import {
  overridePickerFooter,
  pickOverrideProvider,
} from "../src/ui/provider-override-pick.ts";
import { setLocale } from "../src/ui/tui-locale.ts";
import type { PiSwitchCtx } from "../src/pi-context.ts";

describe("overridePickerFooter locale", () => {
  test("renders English chrome without CJK", () => {
    setLocale("en");
    const footer = overridePickerFooter(undefined, 25, 10);

    expect(footer).toContain("page");
    expect(footer).toContain("select");
    expect(footer).toContain("cancel");
    expect(footer).toContain("2/3");
    expect(footer).not.toMatch(/[\u3400-\u9fff]/);
  });

  test("renders Chinese chrome", () => {
    setLocale("zh");
    const footer = overridePickerFooter(undefined, 25, 10);

    expect(footer).toContain("翻页");
    expect(footer).toContain("选择");
    expect(footer).toContain("取消");
    expect(footer).toContain("2/3");
  });

  afterAll(() => setLocale("en"));
});

test("PgDn is wired to the provider picker and selects the next page", async () => {
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: any) => {
        let resolve!: (value: number | undefined) => void;
        const result = new Promise<number | undefined>((done) => (resolve = done));
        const component = factory(
          { requestRender() {} },
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
          {},
          resolve,
        );
        component.handleInput("\x1b[6~");
        component.handleInput("\r");
        return result;
      },
      select: async () => undefined,
    },
  } as unknown as PiSwitchCtx;

  const picked = await pickOverrideProvider(
    ctx,
    "override",
    Array.from({ length: 25 }, (_, index) => `provider-${index}`),
  );
  expect(picked).toBe(10);
});

test("surfaces custom picker failures without falling back to native select", async () => {
  let selectCalls = 0;
  const ctx = {
    mode: "tui",
    ui: {
      custom: async () => {
        throw new Error("custom picker failed");
      },
      select: async () => {
        selectCalls += 1;
        return "provider-0";
      },
    },
  } as unknown as PiSwitchCtx;

  await expect(pickOverrideProvider(ctx, "override", ["provider-0"])).rejects.toThrow(
    "custom picker failed",
  );
  expect(selectCalls).toBe(0);
});
