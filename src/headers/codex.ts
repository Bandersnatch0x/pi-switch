function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

/** Add the per-window signal required by relays that restrict accounts to Codex clients. */
export function applyCodexWindowId(
  headers: Record<string, string>,
  windowId: string | undefined,
): Record<string, string> {
  const id = windowId?.trim();
  if (!id) return headers;

  const userAgent = getHeader(headers, "user-agent")?.trim() ?? "";
  const originator = getHeader(headers, "originator")?.trim() ?? "";
  if (!/^codex_cli_rs\//i.test(userAgent) || originator.toLowerCase() !== "codex_cli_rs") {
    return headers;
  }
  if (getHeader(headers, "x-codex-window-id")?.trim()) return headers;

  return { ...headers, "X-Codex-Window-ID": id };
}
