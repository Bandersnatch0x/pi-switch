/**
 * Convert `role: "developer"` to `role: "system"` for pi-switch providers
 * whose OpenAI-compatible upstream does not declare developer-role support.
 */

export type DeveloperRoleCompatApi =
  | "openai-completions"
  | "openai-responses";

export interface DeveloperRoleCompatModel {
  readonly api: string;
  readonly provider: string;
  readonly compat?: unknown;
}

const ROLE_ITEMS_KEY_BY_API: Record<DeveloperRoleCompatApi, "messages" | "input"> = {
  "openai-completions": "messages",
  "openai-responses": "input",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve the OpenAI API that needs the compatibility rewrite.
 * Built-in and third-party providers not registered by pi-switch are untouched.
 */
export function resolveDeveloperRoleCompatApi(
  model: DeveloperRoleCompatModel | undefined,
  registeredProviderNames: readonly string[],
): DeveloperRoleCompatApi | undefined {
  if (!model || !registeredProviderNames.includes(model.provider)) return undefined;
  if (isRecord(model.compat) && model.compat.supportsDeveloperRole === true) return undefined;
  if (model.api === "openai-completions" || model.api === "openai-responses") {
    return model.api;
  }
  return undefined;
}

/**
 * Normalize role-bearing OpenAI request items without mutating the input.
 * The original array is returned when no item changes.
 */
export function normalizeDeveloperRoleItems(items: readonly unknown[]): readonly unknown[] {
  let normalized: unknown[] | undefined;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!isRecord(item) || item.role !== "developer") continue;

    normalized ??= items.slice();
    normalized[index] = { ...item, role: "system" };
  }

  return normalized ?? items;
}

/** Apply developer-to-system normalization to the role array for one API. */
export function applyDeveloperRoleCompatToPayload(
  payload: unknown,
  api: DeveloperRoleCompatApi,
): unknown {
  if (!isRecord(payload)) return payload;

  const key = ROLE_ITEMS_KEY_BY_API[api];
  const items = payload[key];
  if (!Array.isArray(items)) return payload;

  const normalized = normalizeDeveloperRoleItems(items);
  return normalized === items ? payload : { ...payload, [key]: normalized };
}
