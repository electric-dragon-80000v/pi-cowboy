/**
 * multiplexer-config.test.ts — the multiplexer registry's contract with config: which id a
 * session runs, what it falls back to, and that a plugin can register an multiplexer
 * but never the built-in's id. The fallback is asserted against `BUILTIN_MULTIPLEXER`
 * rather than the literal, so the file holds whether or not the suite happens to
 * run inside herdr.
 */

import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_MULTIPLEXER,
  defaultMultiplexer,
  multiplexerRuntime,
  hasMultiplexer,
  registerMultiplexer,
  resolveMultiplexerId,
} from "../src/agents/multiplexer-registry.js";
import { mergeDefaults } from "../src/config/config-io.js";
import { validateRawLayer } from "../src/config/config-validation.js";

describe("the multiplexer registry", () => {
  it("resolves a registered id, and falls back to the built-in for one nothing registered", () => {
    expect(resolveMultiplexerId(BUILTIN_MULTIPLEXER)).toBe(BUILTIN_MULTIPLEXER);
    expect(hasMultiplexer("nothing-registered")).toBe(false);
    expect(resolveMultiplexerId("nothing-registered")).toBe(
      BUILTIN_MULTIPLEXER,
    );
  });

  it("names the built-in as the fallback when nothing hosts this process", () => {
    // The suite runs outside an multiplexer (or inside herdr, whose id is the
    // built-in's) — either way the answer is the built-in.
    expect(defaultMultiplexer()).toBe(BUILTIN_MULTIPLEXER);
  });

  it("refuses a plugin that claims the built-in multiplexer's id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    registerMultiplexer({
      id: BUILTIN_MULTIPLEXER,
      create: () => {
        throw new Error("the built-in's factory must not be replaced");
      },
    });

    // The built-in still answers, and the attempt was named.
    expect(
      multiplexerRuntime({} as never, BUILTIN_MULTIPLEXER).multiplexer,
    ).toBe(BUILTIN_MULTIPLEXER);
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
