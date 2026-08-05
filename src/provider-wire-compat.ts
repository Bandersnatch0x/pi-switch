import type { CcProvider } from "./types.ts";

const CHAT_COMPLETIONS_API = "openai-completions" as const;
const PROVIDER_WIRE_COMPAT_KEYS = new Set(["api", "supportsStore"]);

export interface ChatProviderWireCompat {
  api: typeof CHAT_COMPLETIONS_API;
  supportsStore?: boolean;
}

export type ProviderWireCompat = ChatProviderWireCompat;

export type ProviderWireCompatSource =
  | "user-provider"
  | "official-adapter"
  | "conservative-default";

export interface ProviderWireCompatConflict {
  field: "supportsStore";
  effective: boolean;
  effectiveSource: "user-provider";
  overridden: boolean;
  overriddenSource: "official-adapter";
}

export interface ResolvedProviderWireCompat {
  api: typeof CHAT_COMPLETIONS_API;
  value: boolean;
  source: ProviderWireCompatSource;
  scope: "provider";
  conflicts: ProviderWireCompatConflict[];
}

export interface RegistrationProviderWireCompat {
  supportsStore: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Parse the Provider-only Chat wire compatibility contract. */
export function parseProviderWireCompat(
  raw: unknown,
  path = "provider compat",
): ProviderWireCompat | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new Error(`invalid ${path}: expected an object`);
  }

  const unknownKeys = Object.keys(raw).filter(
    (key) => !PROVIDER_WIRE_COMPAT_KEYS.has(key),
  );
  if (unknownKeys.length) {
    throw new Error(
      `invalid ${path}: unknown key${unknownKeys.length === 1 ? "" : "s"} ${unknownKeys.join(", ")}`,
    );
  }
  if (raw.api !== CHAT_COMPLETIONS_API) {
    throw new Error(
      `invalid ${path}.api: expected ${CHAT_COMPLETIONS_API}`,
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(raw, "supportsStore") &&
    typeof raw.supportsStore !== "boolean"
  ) {
    throw new Error(`invalid ${path}.supportsStore: expected boolean`);
  }

  return {
    api: CHAT_COMPLETIONS_API,
    ...(typeof raw.supportsStore === "boolean"
      ? { supportsStore: raw.supportsStore }
      : {}),
  };
}

function isOfficialOpenAiEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * Resolve Provider wire authority without consulting model ids, models.dev, or
 * CC Switch metadata.
 *
 * Soft-fails on stale/mismatched overrides: non-Chat providers and Chat
 * overrides whose api discriminator no longer matches the live provider return
 * `undefined` (or ignore the override) instead of throwing, so doctor / info /
 * switch paths stay operational.
 */
export function resolveProviderWireCompat(input: {
  provider: Pick<CcProvider, "api" | "baseUrl">;
  override?: ProviderWireCompat;
}): ResolvedProviderWireCompat | undefined {
  const { provider, override } = input;
  // Non-Chat first: leftover Chat compat must not crash doctor/info/switch.
  if (provider.api !== CHAT_COMPLETIONS_API) return undefined;

  // Ignore stale overrides whose discriminator no longer matches the live API.
  const effectiveOverride =
    override && override.api === provider.api ? override : undefined;

  const officialValue = isOfficialOpenAiEndpoint(provider.baseUrl)
    ? true
    : undefined;
  if (typeof effectiveOverride?.supportsStore === "boolean") {
    const value = effectiveOverride.supportsStore;
    const conflicts: ProviderWireCompatConflict[] =
      typeof officialValue === "boolean" && value !== officialValue
        ? [
            {
              field: "supportsStore",
              effective: value,
              effectiveSource: "user-provider",
              overridden: officialValue,
              overriddenSource: "official-adapter",
            },
          ]
        : [];
    return {
      api: CHAT_COMPLETIONS_API,
      value,
      source: "user-provider",
      scope: "provider",
      conflicts,
    };
  }

  if (officialValue === true) {
    return {
      api: CHAT_COMPLETIONS_API,
      value: true,
      source: "official-adapter",
      scope: "provider",
      conflicts: [],
    };
  }
  return {
    api: CHAT_COMPLETIONS_API,
    value: false,
    source: "conservative-default",
    scope: "provider",
    conflicts: [],
  };
}

/** Official adapter facts remain native; other resolved values are explicit. */
export function providerWireCompatForRegistration(
  resolved: ResolvedProviderWireCompat | undefined,
): RegistrationProviderWireCompat | undefined {
  if (!resolved || resolved.source === "official-adapter") return undefined;
  return { supportsStore: resolved.value };
}
