/**
 * pi-switch file locations under `~/.pi/agent/`.
 * Pure string construction — no IO.
 */

function trimmedHome(home: string): string {
  return home.replace(/[\\/]+$/, "");
}

/**
 * Agent config directory Pi itself uses.
 * Pi honors `<APP>_CODING_AGENT_DIR` (PI_CODING_AGENT_DIR) and falls back to
 * `~/.pi/agent`; files Pi reads must follow the same override or pi-switch
 * would write next to a directory the host never loads.
 */
export function agentDirPath(home: string, agentDirOverride?: string): string {
  const override = agentDirOverride?.trim();
  if (override) {
    const expanded = override.replace(/^~(?=[\\/]|$)/, trimmedHome(home));
    return expanded.replace(/[\\/]+$/, "");
  }
  return `${trimmedHome(home)}/.pi/agent`;
}

export function piSettingsPath(home: string): string {
  return `${trimmedHome(home)}/.pi/agent/settings.json`;
}

/** Pi's cross-process provider file (`models.json`). */
export function piModelsPath(home: string, agentDirOverride?: string): string {
  return `${agentDirPath(home, agentDirOverride)}/models.json`;
}

/** pi-switch's record of which models.json entries it owns. */
export function piPersistedProvidersPath(home: string, agentDirOverride?: string): string {
  return `${agentDirPath(home, agentDirOverride)}/pi-switch-persisted-providers.json`;
}

export function piSwitchConfigPath(home: string): string {
  return `${home.replace(/[\\/]+$/, "")}/.pi/agent/pi-switch.json`;
}

/** W4 capability-facts cache (provenance + fetchedAt; drop to roll back). */
export function piSwitchCachePath(home: string): string {
  return `${home.replace(/[\\/]+$/, "")}/.pi/agent/pi-switch-cache.json`;
}

export function providerHeadersPath(home: string): string {
  return `${home.replace(/[\\/]+$/, "")}/.pi/agent/provider-headers.json`;
}
