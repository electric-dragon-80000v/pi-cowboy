/**
 * plugin-registry.test.ts — the open harness registry: a plugin harness is a
 * first-class entry beside the built-ins, and the availability probe decides
 * whether it stays on offer exactly as it does for a built-in.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import type { PaneControl } from "../src/agents/agent-host.js";
import type { PluginHarness } from "../src/agents/harness.js";
import {
  harnessDisplayName,
  harnessFamilyOf,
  harnessFor,
  harnessIds,
  registeredHarness,
  registerHarness,
  resetPluginHarnesses,
  runnableHarnessIds,
} from "../src/agents/harness/registry.js";
import { probed, unprobed } from "../src/availability.js";
import {
  BUILTIN_MULTIPLEXER,
  multiplexerRuntime,
  registerMultiplexer,
  resetPluginMultiplexers,
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
    listModels: async () => [],
    prefetchModels: () => {},
  };
}

const PROVABLE_ID = "reg-provable";
const UNPROVABLE_ID = "reg-unprovable";
registerHarness(pluginHarness(PROVABLE_ID, { status: "available" }));
registerHarness(pluginHarness(UNPROVABLE_ID, { status: "unavailable" }));

afterAll(() => {
  vi.restoreAllMocks();
});

describe("the open harness registry", () => {
  it("lists a plugin harness beside the built-ins and answers for it", () => {
    expect(harnessIds()).toContain(PROVABLE_ID);
    expect(registeredHarness(PROVABLE_ID)?.displayName).toBe(
      `Plugin ${PROVABLE_ID}`,
    );
    expect(harnessFamilyOf(PROVABLE_ID)).toBeUndefined();
    expect(harnessDisplayName(PROVABLE_ID)).toBe(`Plugin ${PROVABLE_ID}`);
    expect(harnessFor(PROVABLE_ID).agentMultiplexerKind).toBe(PROVABLE_ID);
  });

  it("dispatches a plugin launch to the plugin's own buildArgs and prepare", async () => {
    const prepare = vi.fn(
      async (_request: Parameters<PluginHarness["prepare"]>[0]) => {},
    );
    registerHarness({
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

    const harness = harnessFor("reg-dispatch");
    expect(harness.buildArgs(launch)).toEqual(["run-reg-dispatch"]);
    await harness.prepare({
      pi: {} as never,
      pane,
      paneId: "w1:p1",
      cwd: "/repo",
      launch,
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
    expect(runnableHarnessIds(unprobed())).toContain("pi");
    expect(runnableHarnessIds(unprobed())).not.toContain(PROVABLE_ID);
    expect(runnableHarnessIds(unprobed())).not.toContain(UNPROVABLE_ID);

    const availability = probed([PROVABLE_ID]);
    expect(runnableHarnessIds(availability)).toContain(PROVABLE_ID);
    // A plugin that answered "unavailable" stays off the offer even when the
    // probe ran.
    expect(runnableHarnessIds(availability)).not.toContain(UNPROVABLE_ID);
  });

  it("names an unregistered id rather than inventing a harness for it", () => {
    expect(registeredHarness("reg-ghost")).toBeUndefined();
    expect(harnessFamilyOf("reg-ghost")).toBeUndefined();
    expect(harnessDisplayName("reg-ghost")).toBe("reg-ghost");
    expect(() => harnessFor("reg-ghost")).toThrow(/no harness registered/);
  });

  it("never lets a plugin displace a built-in id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    registerHarness(pluginHarness("claude", { status: "available" }));

    expect(harnessDisplayName("claude")).toBe("Claude");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("a built-in harness owns that id"),
    );
    warn.mockRestore();
  });

  it("keeps the first registration for an id, so two plugins cannot race", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = "reg-contested";
    registerHarness({
      ...pluginHarness(id, { status: "available" }),
      displayName: "First",
    });

    // A second plugin claiming the same id is refused, not silently installed:
    // the first registration is what the registry answers with.
    registerHarness({
      ...pluginHarness(id, { status: "available" }),
      displayName: "Second",
    });

    expect(harnessDisplayName(id)).toBe("First");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "another plugin already registered that id in this load",
      ),
    );
    warn.mockRestore();
  });

  it("forgets a load's registrations, so the next load registers them again", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerHarness(pluginHarness("reg-reloadable", { status: "available" }));

    resetPluginHarnesses();

    expect(registeredHarness("reg-reloadable")).toBeUndefined();
    // A clean registry means the reload is a first registration, not a duplicate.
    registerHarness(pluginHarness("reg-reloadable", { status: "available" }));
    expect(registeredHarness("reg-reloadable")).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("degrades to the built-in when a plugin multiplexer's factory throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerMultiplexer({
      id: "reg-throwing-multiplexer",
      create: () => {
        throw new Error("connection refused");
      },
    });

    const runtime = multiplexerRuntime({} as never, "reg-throwing-multiplexer");

    // The session still has a multiplexer: the built-in.
    expect(runtime.multiplexer).toBe(BUILTIN_MULTIPLEXER);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'multiplexer "reg-throwing-multiplexer" failed to start',
      ),
    );
    warn.mockRestore();
    resetPluginMultiplexers();
  });
});
