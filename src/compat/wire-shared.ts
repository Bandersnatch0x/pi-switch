/**
 * Shared wire-compat parse primitives.
 *
 * Provider wire (#62/#65/#66) and exact-model tuple (#64/#67) share the same
 * api discriminator strings and object-parse helpers, but keep separate
 * resolve/authority strategies — do not force a single parameterized core.
 */

export const CHAT_COMPLETIONS_API = "openai-completions" as const;
export const ANTHROPIC_MESSAGES_API = "anthropic-messages" as const;

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasOwn(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Read an optional boolean field; throw when present but not boolean. */
export function requireBoolean(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  if (!hasOwn(raw, key)) return undefined;
  if (typeof raw[key] !== "boolean") {
    throw new Error(`invalid ${path}.${key}: expected boolean`);
  }
  return raw[key] as boolean;
}
