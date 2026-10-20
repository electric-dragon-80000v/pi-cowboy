/**
 * plugin-registry.test.ts — the open harness registry: a plugin harness is a
 * first-class entry beside the built-ins, and the availability probe decides
 * whether it stays on offer exactly as it does for a built-in. The registry is a
 * session's own object, so one case's registrations cannot answer in the next.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneControl } from "../src/agents/agent-host.js";
import type {
  HarnessConfigCodec,
  PluginHarness,
} from "../src/agents/harness.js";
import {
  createHarnessRegistry,
  harnessFamilyOf,
  type HarnessRegistry,
} from "../src/agents/harness/harness-registry.js";
import { opencodeConfigCodec } from "../src/agents/harness/opencode/config.js";
import { probed, unprobed } from "../src/availability.js";
import {
  BUILTIN_MULTIPLEXER,
  createMultiplexerRegistry,
  type MultiplexerRegistry,
} from "../src/agents/multiplexer-registry.js";

/**
 * A plugin harness whose verdict is fixed, so a test can prove a plugin is
 * probed like a built-in rather than assumed launchable.
 */
function pluginHarness(
  id: string,
  verdict: { status: "available" } | { status: "unavailable" },
): PluginHarness {
  return {
    id,
    displayName: `Plugin ${id}`,
    agentMultiplexerKind: id,
    availability: () => verdict,
    prepare: async () => {},
    buildArgs: () => [`run-${id}`],
    teardown: async () => {},
    listModels: async () => ({ kind: "listed", entries: [] }),
    prefetchModels: () => {},
  };
}

const PROVABLE_ID = "reg-provable";
const UNPROVABLE_ID = "reg-unprovable";

let harnesses: HarnessRegistry;
let multiplexers: MultiplexerRegistry;

beforeEach(() => {
  harnesses = createHarnessRegistry();
  multiplexers = createMultiplexerRegistry();
  harnesses.register(pluginHarness(PROVABLE_ID, { status: "available" }));
  harnesses.register(pluginHarness(UNPROVABLE_ID, { status: "unavailable" }));
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("the open harness registry", () => {
  it("lists a plugin harness beside the built-ins and answers for it", () => {
    expect(harnesses.ids()).toContain(PROVABLE_ID);
    expect(harnesses.get(PROVABLE_ID)?.displayName).toBe(
      `Plugin ${PROVABLE_ID}`,
    );
    expect(harnessFamilyOf(PROVABLE_ID)).toBeUndefined();
    expect(harnesses.displayName(PROVABLE_ID)).toBe(`Plugin ${PROVABLE_ID}`);
    expect(harnesses.require(PROVABLE_ID).agentMultiplexerKind).toBe(
      PROVABLE_ID,
    );
  });

  it("validates each harness's config with its own codec, built-in or plugin", () => {
    const codec: HarnessConfigCodec = {
      scope: "global",
      parse: () => ({ enabled: true }),
    };
    harnesses.register({
      ...pluginHarness("reg-config", { status: "available" }),
      config: codec,
    });

    harnesses.validateConfigs(
      {
        global: {
          opencode: { configInclude: ["tools"] },
          "reg-config": { enabled: false },
        },
        project: {},
      },
      () => {},
    );

    expect(harnesses.get("opencode")?.config).toBe(opencodeConfigCodec);
    expect(harnesses.config("opencode")).toEqual({
      configInclude: ["tools"],
    });
    expect(harnesses.get("reg-config")?.config).toBe(codec);
    expect(harnesses.config("reg-config")).toEqual({ enabled: true });
  });

  it("dispatches a plugin launch to the plugin's own buildArgs and prepare", async () => {
    const prepare = vi.fn(
      async (_request: Parameters<PluginHarness["prepare"]>[0]) => {},
    );
    harnesses.register({
      ...pluginHarness("reg-dispatch", { status: "available" }),
      prepare,
    });
    const pane: PaneControl = {
      kind: "test",
      run: async () => {},
      waitForOutput: async () => {},
    };
    const launch = {
      family: "plugin" as const,
      subagentId: "s1",
      systemPromptFile: "/p/system.md",
      taskFile: "/p/task.md",
      resultFile: "/p/result.md",
      modelKey: null,
      toolSelection: { kind: "default" as const },
    };

    const harness = harnesses.require("reg-dispatch");
    expect(harness.buildArgs(launch)).toEqual(["run-reg-dispatch"]);
    await harness.prepare({
      pi: {} as never,
      pane,
      paneId: "w1:p1",
      cwd: "/repo",
      launch,
      config: undefined,
    });

    // The plugin reads the shared inputs; nothing built-in-family-specific
    // (opencode's `variant`, codex's `projectTrusted`) rides along. The request
    // is the same object the caller built, as on the built-in path.
    expect(prepare).toHaveBeenCalledTimes(1);
    const received = prepare.mock.calls[0]![0];
    expect(received.paneId).toBe("w1:p1");
    expect(received.launch.subagentId).toBe("s1");
    expect(received.launch.resultFile).toBe("/p/result.md");
    expect(received.launch).not.toHaveProperty("variant");
    expect(received.launch).not.toHaveProperty("projectTrusted");
  });

  it("offers a plugin harness only once the probe has confirmed it, like any other", () => {
    // pi runs the pane it launches in, so the family answers with nothing known.
    expect(harnesses.runnable(unprobed())).toContain("pi");
    expect(harnesses.runnable(unprobed())).not.toContain(PROVABLE_ID);
    expect(harnesses.runnable(unprobed())).not.toContain(UNPROVABLE_ID);

    const availability = probed([PROVABLE_ID]);
    expect(harnesses.runnable(availability)).toContain(PROVABLE_ID);
    // A plugin that answered "unavailable" stays off the offer even when the
    // probe ran.
    expect(harnesses.runnable(availability)).not.toContain(UNPROVABLE_ID);
  });

  it("names an unregistered id rather than inventing a harness for it", () => {
    expect(harnesses.get("reg-ghost")).toBeUndefined();
    expect(harnessFamilyOf("reg-ghost")).toBeUndefined();
    expect(harnesses.displayName("reg-ghost")).toBe("reg-ghost");
    expect(() => harnesses.require("reg-ghost")).toThrow(
      /no harness registered/,
    );
  });

  it("never lets a plugin displace a built-in id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    harnesses.register(pluginHarness("claude", { status: "available" }));

    expect(harnesses.displayName("claude")).toBe("Claude");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("a built-in harness owns that id"),
    );
    warn.mockRestore();
  });

  it("keeps the first registration for an id, so two plugins cannot race", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    harnesses.register({
      ...pluginHarness("reg-contested", { status: "available" }),
      displayName: "First",
    });

    // A second plugin claiming the same id is refused, not silently installed:
    // the first registration is what the registry answers with.
    harnesses.register({
      ...pluginHarness("reg-contested", { status: "available" }),
      displayName: "Second",
    });

    expect(harnesses.displayName("reg-contested")).toBe("First");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "another plugin already registered that id in this load",
      ),
    );
    warn.mockRestore();
  });

  it("forgets one plugin's registration, so a failed factory leaves the id free", () => {
    harnesses.register(
      pluginHarness("reg-reloadable", { status: "available" }),
    );

    harnesses.unregister("reg-reloadable");

    expect(harnesses.get("reg-reloadable")).toBeUndefined();
    harnesses.register(
      pluginHarness("reg-reloadable", { status: "available" }),
    );
    expect(harnesses.get("reg-reloadable")).toBeDefined();
  });

  it("never forgets a built-in, whatever is asked of it", () => {
    harnesses.unregister("pi");

    expect(harnesses.displayName("pi")).toBe("Pi");
  });

  it("answers each session from its own vocabulary", () => {
    const nextSession = createHarnessRegistry();

    // The plugin belongs to the session that registered it, and a registry built
    // for a later session starts at the built-ins.
    expect(harnesses.get(PROVABLE_ID)).toBeDefined();
    expect(nextSession.get(PROVABLE_ID)).toBeUndefined();
    expect(nextSession.ids()).not.toContain(PROVABLE_ID);
    expect(nextSession.ids()).toContain("pi");
  });

  it("degrades to the built-in when a plugin multiplexer's factory throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    multiplexers.register({
      id: "reg-throwing-multiplexer",
      hosts: () => true,
      create: () => {
        throw new Error("connection refused");
      },
    });

    const runtime = multiplexers.runtime(
      {} as never,
      "reg-throwing-multiplexer",
    );

    // The session still has a multiplexer: the built-in.
    expect(runtime.multiplexer).toBe(BUILTIN_MULTIPLEXER);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'multiplexer "reg-throwing-multiplexer" failed to start',
      ),
    );
    warn.mockRestore();
  });
});

describe("the open multiplexer registry", () => {
  it("resolves a registered id, and falls back to the built-in for one nothing registered", () => {
    expect(multiplexers.resolveId(BUILTIN_MULTIPLEXER)).toBe(
      BUILTIN_MULTIPLEXER,
    );
    expect(multiplexers.has("nothing-registered")).toBe(false);
    expect(multiplexers.resolveId("nothing-registered")).toBe(
      BUILTIN_MULTIPLEXER,
    );
  });

  it("refuses a plugin that claims the built-in multiplexer's id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    multiplexers.register({
      id: BUILTIN_MULTIPLEXER,
      hosts: () => true,
      create: () => {
        throw new Error("the built-in's factory must not be replaced");
      },
    });

    // The built-in still answers, and the attempt was named.
    expect(
      multiplexers.runtime({} as never, BUILTIN_MULTIPLEXER).multiplexer,
    ).toBe(BUILTIN_MULTIPLEXER);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("the built-in multiplexer owns that id"),
    );
    warn.mockRestore();
  });

  it("answers each session from its own multiplexers", () => {
    multiplexers.register({
      id: "session-only-multiplexer",
      hosts: () => true,
      create: () => ({ multiplexer: "session-only-multiplexer" }) as never,
    });

    expect(multiplexers.has("session-only-multiplexer")).toBe(true);
    expect(createMultiplexerRegistry().has("session-only-multiplexer")).toBe(
      false,
    );
  });
});
