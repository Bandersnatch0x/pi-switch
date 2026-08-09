/**
 * pi-switch file locations under `~/.pi/agent/`.
 * Pure string construction — no IO.
 */

export function piSettingsPath(home: string): string {
  return `${home.replace(/[\\/]+$/, "")}/.pi/agent/settings.json`;
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
