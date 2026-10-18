/**
 * host-multiplexer.test.ts — which multiplexer this process is detected to be running
 * inside. Detection is environment-only, so each case sets the variable and
 * restores it; "not hosted at all" must stay distinct from "hosted by herdr".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getHostMultiplexer,
  multiplexerHosts,
  type HostMultiplexer,
} from "../src/host-multiplexer.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getHostMultiplexer", () => {
  it("answers herdr for a process herdr started", () => {
    vi.stubEnv("HERDR_ENV", "1");

    const multiplexer: HostMultiplexer | undefined = getHostMultiplexer();

    expect(multiplexer).toBe("herdr");
  });

  it("answers undefined outside every multiplexer", () => {
    vi.stubEnv("HERDR_ENV", "");

    expect(getHostMultiplexer()).toBeUndefined();
  });

  it("answers undefined for a marker that is not the value herdr sets", () => {
    // Only the exact value herdr writes counts; another process setting the
    // variable for its own reasons must not make the extension activate.
    vi.stubEnv("HERDR_ENV", "0");

    expect(getHostMultiplexer()).toBeUndefined();
  });
});

describe("multiplexerHosts", () => {
  it("answers for one multiplexer, which is what the built-in registration wires", () => {
    vi.stubEnv("HERDR_ENV", "1");
    expect(multiplexerHosts("herdr")).toBe(true);

    vi.stubEnv("HERDR_ENV", "");
    expect(multiplexerHosts("herdr")).toBe(false);
  });
});
