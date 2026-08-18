import { expect, test } from "bun:test";
import { threeLevelPick } from "../src/ui/three-level-pick.ts";
import { PAGE_SIZE } from "../src/ui/pagination.ts";
import type { PiSwitchCtx } from "../src/pi-context.ts";
import type { CcProvider } from "../src/types.ts";

const provider: CcProvider = {
  id: "provider-1",
  piName: "provider-1",
  displayName: "A Relay",
  appType: "claude",
  api: "anthropic-messages",
  baseUrl: "https://relay.example.test",
  apiKey: "test-key",
  authHeader: false,
  configModels: ["model-1"],
  meta: {},
  isCurrentInCc: false,
};

const activeProvider: CcProvider = {
  ...provider,
  id: "provider-2",
  piName: "provider-2",
  displayName: "B Active Relay",
};

/** Keep the host UI boundary in one place; each test only describes its flow. */
function pickerContext(
  custom: (...args: any[]) => Promise<unknown>,
  select: (...args: any[]) => Promise<unknown> = async () => undefined,
): PiSwitchCtx {
  return {
    mode: "tui",
    ui: {
      custom,
      select,
      notify() {},
      setStatus() {},
    } as any,
  } as unknown as PiSwitchCtx;
}

test("custom three-level picker tolerates newer theme tokens", async () => {
  const selectCalls: string[] = [];
  const themeCalls: Array<{ key: string; text: string }> = [];
  const rendered: string[][] = [];
  let customResult: unknown;

  const theme = {
    fg(key: string, text: string): string {
      themeCalls.push({ key, text });
      // Simulate an older Pi whose theme rejects tokens added later.
      if (key === "borderMuted" || key === "success") {
        throw new Error(`unknown theme token: ${key}`);
      }
      return `<${key}>${text}</${key}>`;
    },
    bold(text: string): string {
      return `<bold>${text}</bold>`;
    },
  };

  const tui = {
    requestRender() {},
  };

  const ctx = pickerContext(
    async (factory: any) => {
      const done = (result: unknown) => {
        customResult = result;
      };
      const component = factory(tui, theme, undefined, done);
      rendered.push(component.render(100));
      component.handleInput("\r");
      component.handleInput("\r");
      // Render the name level so both unsupported semantics are exercised:
      // borderMuted for the frame and success for the active provider.
      rendered.push(component.render(100));
      component.handleInput("\r");
      return customResult;
    },
    async (title: string) => {
      selectCalls.push(title);
      throw new Error("custom picker unexpectedly fell back");
    },
  );

  const result = await threeLevelPick(
    ctx,
    { providers: [provider, activeProvider], activePiName: activeProvider.piName },
  );

  expect(result).toEqual({ kind: "ok", provider, modelId: "model-1" });
  expect(selectCalls).toEqual([]);
  expect(themeCalls.some(({ key }) => key === "borderMuted")).toBe(true);
  expect(themeCalls.some(({ key }) => key === "success")).toBe(true);
  // borderMuted falls back to dim and success falls back to accent; supported
  // semantic colors retain their meaning instead of making custom() fail.
  expect(
    themeCalls.some(({ key, text }) => key === "dim" && /^─+$/.test(text)),
  ).toBe(true);
  expect(
    themeCalls.some(({ key, text }) => key === "accent" && text.includes("B Active Relay")),
  ).toBe(true);
  expect(
    rendered.some((frame) => frame.some((line) => line.includes("<dim>"))),
  ).toBe(true);
  expect(
    rendered.some((frame) => frame.some((line) => line.includes("<accent>"))),
  ).toBe(true);
});

test("custom picker falls back when a supported theme token fails unexpectedly", async () => {
  let customCalls = 0;
  let selectCalls = 0;

  const theme = {
    fg(key: string, text: string): string {
      if (key === "accent") throw new Error("theme renderer failed");
      return text;
    },
    bold(text: string): string {
      return text;
    },
  };

  const ctx = pickerContext(
    async (factory: any) => {
      customCalls += 1;
      const component = factory({ requestRender() {} }, theme, undefined, () => {});
      component.render(100);
      return undefined;
    },
    async () => {
      selectCalls += 1;
      return undefined;
    },
  );

  const result = await threeLevelPick(
    ctx,
    { providers: [provider] },
  );

  expect(result).toEqual({ kind: "cancel" });
  expect(customCalls).toBe(1);
  expect(selectCalls).toBe(1);
});

type ThemeFailureScenario = {
  name: string;
  target: "borderMuted" | "success";
  targetError: string;
  fallback?: "dim" | "accent";
};

const themeFailureScenarios: ThemeFailureScenario[] = [
  {
    name: "borderMuted throws an unrelated error that mentions the requested token",
    target: "borderMuted",
    targetError: "unknown theme token: accent while rendering borderMuted",
  },
  {
    name: "success throws an unrelated error that mentions the requested token",
    target: "success",
    targetError: "unknown theme token: dim while rendering the success state",
  },
  {
    name: "the dim compatibility token fails",
    target: "borderMuted",
    targetError: "unknown theme token: borderMuted",
    fallback: "dim",
  },
  {
    name: "the accent compatibility token fails",
    target: "success",
    targetError: "unknown theme token: success",
    fallback: "accent",
  },
];

for (const scenario of themeFailureScenarios) {
  test(`custom picker reaches native select when ${scenario.name}`, async () => {
    let customCalls = 0;
    let selectCalls = 0;

    let compatibilityFallbackPending = false;
    const theme = {
      fg(key: string, text: string): string {
        if (key === scenario.target) {
          compatibilityFallbackPending = Boolean(scenario.fallback);
          throw new Error(scenario.targetError);
        }
        if (compatibilityFallbackPending && key === scenario.fallback) {
          throw new Error(`theme renderer failed for ${key}`);
        }
        return text;
      },
      bold(text: string): string {
        return text;
      },
    };

    const ctx = pickerContext(
      async (factory: any) => {
        customCalls += 1;
        const component = factory({ requestRender() {} }, theme, undefined, () => {});
        component.render(100);
        if (scenario.target === "success") {
          component.handleInput("\r");
          component.render(100);
        }
        // If the theme error is incorrectly swallowed, make that observable:
        // the custom picker wins instead of reaching the native fallback.
        return { kind: "ok", provider, modelId: "model-1" };
      },
      async () => {
        selectCalls += 1;
        return undefined;
      },
    );

    const result = await threeLevelPick(
      ctx,
      { providers: [provider], activePiName: provider.piName },
    );

    expect(result).toEqual({ kind: "cancel" });
    expect(customCalls).toBe(1);
    expect(selectCalls).toBe(1);
  });
}

test("old-Pi theme keeps the custom picker active across PgDn and selects the next page", async () => {
  const providers = Array.from({ length: PAGE_SIZE + 5 }, (_, index): CcProvider => ({
    ...provider,
    id: `provider-${String(index).padStart(2, "0")}`,
    piName: `provider-${String(index).padStart(2, "0")}`,
    displayName: `Relay ${String(index).padStart(2, "0")}`,
    configModels: [`model-${String(index).padStart(2, "0")}`],
  }));
  const nextPageProvider = providers[PAGE_SIZE];
  const selectCalls: string[] = [];
  const rendered: string[][] = [];

  const oldPiTheme = {
    fg(key: string, text: string): string {
      if (key === "borderMuted" || key === "success") {
        throw new Error(`unknown theme color: ${key}`);
      }
      return `<${key}>${text}</${key}>`;
    },
    bold(text: string): string {
      return `<bold>${text}</bold>`;
    },
  };

  const ctx = pickerContext(
    async (factory: any) => {
      let result: unknown;
      const component = factory(
        { requestRender() {} },
        oldPiTheme,
        undefined,
        (value: unknown) => {
          result = value;
        },
      );

      rendered.push(component.render(100));
      component.handleInput("\r"); // reveal provider names
      component.handleInput("\x1b[6~"); // PgDn to the next provider page
      rendered.push(component.render(100));
      component.handleInput("\r"); // reveal models for provider 10
      component.handleInput("\r"); // select its first model
      return result;
    },
    async (title: string) => {
      selectCalls.push(title);
      throw new Error("custom picker unexpectedly fell back");
    },
  );

  const result = await threeLevelPick(
    ctx,
    { providers, activePiName: nextPageProvider.piName },
  );

  expect(result).toEqual({
    kind: "ok",
    provider: nextPageProvider,
    modelId: `model-${String(PAGE_SIZE).padStart(2, "0")}`,
  });
  expect(selectCalls).toEqual([]);
  expect(
    rendered.some((frame) => frame.some((line) => line.includes(nextPageProvider.displayName))),
  ).toBe(true);
});
