import { test, expect, describe } from "bun:test";
import {
  DEFAULT_ROUTING_PROBE_URL,
  resolveRoutingProbeUrl,
} from "../src/routing.ts";

describe("resolveRoutingProbeUrl (W3)", () => {
  test("defaults to CC Switch Local Routing address when unset", () => {
    expect(resolveRoutingProbeUrl(undefined)).toBe(DEFAULT_ROUTING_PROBE_URL);
    expect(resolveRoutingProbeUrl({})).toBe(DEFAULT_ROUTING_PROBE_URL);
  });

  test("uses custom address when configured", () => {
    expect(resolveRoutingProbeUrl({ routingProbeUrl: "http://127.0.0.1:15999" })).toBe(
      "http://127.0.0.1:15999",
    );
    expect(resolveRoutingProbeUrl({ routingProbeUrl: "  http://127.0.0.1:1  " })).toBe(
      "http://127.0.0.1:1",
    );
  });

  test("empty string disables probing", () => {
    expect(resolveRoutingProbeUrl({ routingProbeUrl: "" })).toBeUndefined();
    expect(resolveRoutingProbeUrl({ routingProbeUrl: "   " })).toBeUndefined();
  });
});
