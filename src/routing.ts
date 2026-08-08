/**
 * W3 routing probe (issue #19): CC Switch Local Routing proxy reachability.
 *
 * CC Switch's application-level routing service (direct path unaffected) binds
 * `127.0.0.1:<port>` with a configurable listen port. pi-switch never routes
 * through it (#10), but doctor surfaces reachability as a W3 fact.
 */

/** CC Switch Local Routing default listen address (docs: 4-proxy/4.1-service.md). */
export const DEFAULT_ROUTING_PROBE_URL = "http://127.0.0.1:15721";

/** Default short timeout for the local reachability probe (ms). */
export const ROUTING_PROBE_TIMEOUT_MS = 1500;

export interface RoutingProbeResult {
  url: string;
  reachable: boolean;
}

/**
 * Resolve the routing probe URL from config.
 * - explicit non-empty value: custom listen address/port
 * - empty string: explicitly disabled (no probe)
 * - unset: default CC Switch Local Routing address
 */
export function resolveRoutingProbeUrl(
  config: { routingProbeUrl?: string } | undefined,
): string | undefined {
  const v = config?.routingProbeUrl?.trim();
  if (v === "") return undefined;
  return v || DEFAULT_ROUTING_PROBE_URL;
}

/**
 * On-demand routing reachability probe (fresh each call).
 * Undefined when probing is explicitly disabled via routingProbeUrl: "".
 */
export async function probeRouting(
  config: { routingProbeUrl?: string } | undefined,
  probeHttp: (url: string, timeoutMs: number) => Promise<boolean>,
  timeoutMs = ROUTING_PROBE_TIMEOUT_MS,
): Promise<RoutingProbeResult | undefined> {
  const url = resolveRoutingProbeUrl(config);
  if (!url) return undefined;
  const reachable = await probeHttp(url, timeoutMs);
  return { url, reachable };
}
