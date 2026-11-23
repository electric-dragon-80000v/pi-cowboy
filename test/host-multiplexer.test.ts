/**
 * host-multiplexer.test.ts — which multiplexer this process is detected to be running
 * inside. Detection is environment-only, so each case sets the variable and
 * restores it; "not hosted at all" must stay distinct from "hosted by herdr".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getHostMultiplexer,
  hcTerminalId,
  multiplexerHosts,
  type HostMultiplexer,
} from "../src/host-multiplexer.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getHostMultiplexer", () => {
  it("answers herdr for a process herdr started", () => {
    vi.stubEnv("HERDR_ENV", "1");
    vi.stubEnv("HC_TERMINAL_ID", "");

    const multiplexer: HostMultiplexer | undefined = getHostMultiplexer();

    expect(multiplexer).toBe("herdr");
  });

  it("answers undefined outside every multiplexer", () => {
    vi.stubEnv("HERDR_ENV", "");
    vi.stubEnv("HC_TERMINAL_ID", "");

    expect(getHostMultiplexer()).toBeUndefined();
  });

  it("answers undefined for a marker that is not the value herdr sets", () => {
    // Only the exact value herdr writes counts; another process setting the
    // variable for its own reasons must not make the extension activate.
    vi.stubEnv("HERDR_ENV", "0");
    vi.stubEnv("HC_TERMINAL_ID", "");

    expect(getHostMultiplexer()).toBeUndefined();
  });
});

describe("multiplexerHosts", () => {
  it("answers for one multiplexer, which is what the built-in registration wires", () => {
    vi.stubEnv("HERDR_ENV", "1");
    vi.stubEnv("HC_TERMINAL_ID", "");
    expect(multiplexerHosts("herdr")).toBe(true);

    vi.stubEnv("HERDR_ENV", "");
    vi.stubEnv("HC_TERMINAL_ID", "");
    expect(multiplexerHosts("herdr")).toBe(false);
  });
});

describe("herdr-core detection", () => {
  it("answers herdr-core for a process in a herdr-core terminal", () => {
    vi.stubEnv("HERDR_ENV", "");
    vi.stubEnv("HC_TERMINAL_ID", "t7");

    expect(getHostMultiplexer()).toBe("herdr-core");
    expect(multiplexerHosts("herdr-core")).toBe(true);
    expect(multiplexerHosts("herdr")).toBe(false);
    expect(hcTerminalId()).toBe("t7");
  });

  it("answers herdr for a herdr pane opened inside a herdr-core terminal", () => {
    // The pane is the nearer host: its panes, not the outer terminal, are
    // where the session's agents can be placed.
    vi.stubEnv("HERDR_ENV", "1");
    vi.stubEnv("HC_TERMINAL_ID", "t7");

    expect(getHostMultiplexer()).toBe("herdr");
    expect(multiplexerHosts("herdr-core")).toBe(false);
  });

  it("treats an empty terminal id as no terminal", () => {
    vi.stubEnv("HERDR_ENV", "");
    vi.stubEnv("HC_TERMINAL_ID", "");

    expect(hcTerminalId()).toBeUndefined();
    expect(multiplexerHosts("herdr-core")).toBe(false);
  });
});
