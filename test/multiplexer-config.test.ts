/**
 * multiplexer-config.test.ts — the multiplexer registry's contract with config: which id a
 * session runs, what it falls back to, and that a plugin can register an multiplexer
 * but never the built-in's id. The fallback is asserted against `BUILTIN_MULTIPLEXER`
 * rather than the literal, so the file holds whether or not the suite happens to
 * run inside herdr.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_MULTIPLEXER,
  createMultiplexerRegistry,
  defaultMultiplexer,
} from "../src/agents/multiplexer-registry.js";
import { mergeDefaults } from "../src/config/config-io.js";
import { validateRawLayer } from "../src/config/config-validation.js";

describe("the multiplexer registry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A plugin multiplexer whose host answer is fixed. */
  function pluginMultiplexer(id: string, hosts: boolean) {
    return {
      id,
      hosts: () => hosts,
      create: () => ({ multiplexer: id }) as never,
    };
  }

  it("resolves a registered id, and falls back to the built-in for one nothing registered", () => {
    const registry = createMultiplexerRegistry();

    expect(registry.resolveId(BUILTIN_MULTIPLEXER)).toBe(BUILTIN_MULTIPLEXER);
    expect(registry.has("nothing-registered")).toBe(false);
    expect(registry.resolveId("nothing-registered")).toBe(BUILTIN_MULTIPLEXER);
  });

  it("collects the hosts in registration order, the built-in first", () => {
    vi.stubEnv("HERDR_ENV", "1");
    const registry = createMultiplexerRegistry();
    registry.register(pluginMultiplexer("tmux", true));
    registry.register(pluginMultiplexer("zellij", false));

    expect(registry.hosting()).toEqual([BUILTIN_MULTIPLEXER, "tmux"]);
    // The configured host wins over the earlier one; a configured multiplexer that
    // does not host this process is not preferred at all.
    expect(registry.resolveId("tmux")).toBe("tmux");
    expect(registry.resolveId("zellij")).toBe(BUILTIN_MULTIPLEXER);
  });

  it("runs a plugin multiplexer that hosts where no built-in does", () => {
    vi.stubEnv("HERDR_ENV", "");
    const registry = createMultiplexerRegistry();
    registry.register(pluginMultiplexer("tmux", true));

    expect(registry.hosting()).toEqual(["tmux"]);
    expect(registry.resolveId(BUILTIN_MULTIPLEXER)).toBe("tmux");
    expect(registry.resolveId("tmux")).toBe("tmux");
  });

  it("hosts without a multiplexer whose own detection throws", () => {
    vi.stubEnv("HERDR_ENV", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = createMultiplexerRegistry();
    registry.register({
      id: "broken",
      hosts: () => {
        throw new Error("cannot tell");
      },
      create: () => ({ multiplexer: "broken" }) as never,
    });
    registry.register(pluginMultiplexer("tmux", true));

    expect(registry.hosting()).toEqual(["tmux"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('multiplexer "broken" could not answer'),
    );
    warn.mockRestore();
  });

  it("names the built-in as the fallback when nothing hosts this process", () => {
    vi.stubEnv("HERDR_ENV", "");

    expect(defaultMultiplexer()).toBe(BUILTIN_MULTIPLEXER);
  });

  it("refuses a plugin that claims the built-in multiplexer's id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = createMultiplexerRegistry();

    registry.register({
      id: BUILTIN_MULTIPLEXER,
      hosts: () => true,
      create: () => {
        throw new Error("the built-in's factory must not be replaced");
      },
    });

    // The built-in still answers, and the attempt was named.
    expect(registry.runtime({} as never, BUILTIN_MULTIPLEXER).multiplexer).toBe(
      BUILTIN_MULTIPLEXER,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("the built-in multiplexer owns that id"),
    );
    warn.mockRestore();
  });
});

describe("the multiplexer setting", () => {
  it("bakes the default multiplexer into a raw config without the key", () => {
    expect(mergeDefaults({}).multiplexer).toBe(BUILTIN_MULTIPLEXER);
  });

  it("keeps a multiplexer id the built-in vocabulary does not know, for a plugin to claim", () => {
    const cleaned = validateRawLayer(
      { multiplexer: "plugin-multiplexer" },
      "config.json",
    );

    expect(cleaned.multiplexer).toBe("plugin-multiplexer");
  });

  it("drops an empty multiplexer id, so the default applies", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer({ multiplexer: "" }, "config.json");

    expect(cleaned.multiplexer).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
