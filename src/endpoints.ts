/**
 * Official-vendor endpoint detection.
 *
 * Shared by exact-model tuple compat and Provider wire compat so the two
 * modules stay decoupled while agreeing on what counts as an official
 * OpenAI / Anthropic endpoint URL.
 */

export function isOfficialOpenAiChatEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

export function isOfficialAnthropicEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.anthropic.com" || host.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}
