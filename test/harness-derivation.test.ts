/**
 * harness-derivation.test.ts — a derived harness is an ordinary registry entry:
 * the base's implementation, this variant's defaults, and its own hooks. The
 * registry is per session and the base is resolved at use time, so a variant may
 * be registered before the harness it derives from.
 */

import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PaneControl } from "../src/agents/agent-host.js";
import {
  canReadHandoverRecords,
  type HarnessConfigCodec,
  type HarnessLaunch,
  type HarnessPrepareRequest,
  type HarnessTeardownRequest,
  type PluginHarness,
} from "../src/agents/harness.js";
import {
  createHarnessRegistry,
  type HarnessRegistry,
} from "../src/agents/harness/harness-registry.js";

/** The shared launch inputs every request in this file carries. */
const SHARED = {
  subagentId: "sub-1",
  systemPromptFile: "/staged/system.md",
  taskFile: "/staged/task.md",
  resultFile: "/staged/result.md",
  modelKey: null,
  thinking: null,
  toolSelection: { kind: "default" as const },
  envFile: null,
};

/** The launch a plugin harness is handed; a built-in base narrows its own. */
const PLUGIN_LAUNCH: HarnessLaunch = { ...SHARED, family: "plugin" };

/** What a derived harness's hooks receive at one pane. */
function prepareRequest(
  launch: HarnessLaunch = PLUGIN_LAUNCH,
): HarnessPrepareRequest<HarnessLaunch, unknown> {
  return {
    pi: {} as ExtensionAPI,
    config: undefined,
    pane: {} as PaneControl,
    paneId: "pane-1",
    cwd: "/tmp/work",
    launch,
  };
}

/** A base harness a derivation can wrap; every member is a stub a test replaces. */
function baseHarness(
  overrides: Partial<PluginHarness> & { id: string },
): PluginHarness {
  const id = overrides.id;
  return {
    displayName: `Plugin ${id}`,
    agentMultiplexerKind: "pi",
    availability: () => ({ status: "available" }),
    prepare: async () => {},
    buildArgs: () => [`run-${id}`],
    teardown: async () => {},
    listModels: async () => ({ kind: "listed", entries: [] }),
    stop: async () => {},
    steer: async () => ({ kind: "submitted" }),
    ...overrides,
  } as PluginHarness;
}

describe("deriving a harness", () => {
  it("registers the variant beside its base and reads the base's family", () => {
    const registry = createHarnessRegistry();

    expect(
      registry.derive({
        id: "claude-work",
        displayName: "Claude (work)",
        base: "claude",
      }),
    ).toBe(true);

    expect(registry.ids()).toContain("claude-work");
    expect(registry.displayName("claude-work")).toBe("Claude (work)");
    expect(registry.family("claude-work")).toBe("claude");
    // The launch a variant of claude receives is claude's, so the base's own
    // guarded dispatch accepts it.
    const claudeLaunch: HarnessLaunch = { ...SHARED, family: "claude" };
    expect(registry.require("claude-work").buildArgs(claudeLaunch)).toEqual(
      registry.require("claude").buildArgs(claudeLaunch),
    );
  });

  it("refuses a built-in id, a taken id, and a self-derived base", () => {
    const registry = createHarnessRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        registry.derive({ id: "claude", displayName: "X", base: "codex" }),
      ).toBe(false);
      expect(
        registry.derive({
          id: "twice",
          displayName: "X",
          base: "claude",
        }),
      ).toBe(true);
      expect(
        registry.derive({ id: "twice", displayName: "Y", base: "claude" }),
      ).toBe(false);
      expect(
        registry.derive({ id: "self", displayName: "X", base: "self" }),
      ).toBe(false);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it("resolves a base registered after the variant", () => {
    const registry = createHarnessRegistry();
    registry.derive({ id: "later-work", displayName: "Later", base: "later" });

    expect(registry.require("later-work").availability()).toEqual({
      status: "unavailable",
      notice: 'its base harness "later" is not registered',
    });

    registry.register(baseHarness({ id: "later" }));

    expect(registry.require("later-work").availability()).toEqual({
      status: "available",
    });
    expect(registry.require("later-work").buildArgs(PLUGIN_LAUNCH)).toEqual([
      "run-later",
    ]);
  });

  it("reports a cycle instead of following it", () => {
    const registry = createHarnessRegistry();
    registry.derive({ id: "a", displayName: "A", base: "b" });
    registry.derive({ id: "b", displayName: "B", base: "a" });

    expect(registry.family("a")).toBeUndefined();
    expect(registry.require("a").availability()).toEqual({
      status: "unavailable",
      notice: 'its base chain cycles through "a"',
    });
  });

  it("inherits a base's family through a chain of derivations", () => {
    const registry = createHarnessRegistry();
    registry.derive({ id: "claude-work", displayName: "Work", base: "claude" });
    registry.derive({
      id: "claude-work-proxy",
      displayName: "Work proxy",
      base: "claude-work",
    });

    expect(registry.family("claude-work-proxy")).toBe("claude");
  });

  it("composes availability: the base's verdict first, then the variant's own", () => {
    const registry = createHarnessRegistry();
    registry.register(
      baseHarness({
        id: "missing-binary",
        availability: () => ({
          status: "unavailable",
          notice: "the binary speaks another major",
        }),
      }),
    );
    registry.derive({
      id: "missing-binary-work",
      displayName: "Work",
      base: "missing-binary",
    });
    registry.derive({
      id: "claude-own-verdict",
      displayName: "Own",
      base: "claude",
      availability: () => ({ status: "unavailable" }),
    });

    expect(registry.require("missing-binary-work").availability()).toEqual({
      status: "unavailable",
      notice: "the binary speaks another major",
    });
    expect(registry.require("claude-own-verdict").availability()).toEqual({
      status: "unavailable",
    });
    expect(registry.require("missing-binary-work").availability()).not.toEqual({
      status: "available",
    });
  });

  it("unions the base's reserved env names with the variant's own", () => {
    const registry = createHarnessRegistry();
    registry.register(
      baseHarness({
        id: "reserving",
        reservedEnvVars: () => ["BASE_STORE"],
      }),
    );
    registry.derive({
      id: "reserving-work",
      displayName: "Work",
      base: "reserving",
      reservedEnvVars: () => ["VARIANT_STORE"],
    });

    expect(registry.require("reserving-work").reservedEnvVars?.()).toEqual([
      "BASE_STORE",
      "VARIANT_STORE",
    ]);
  });

  it("delegates the base's config codec to the variant's own section", () => {
    const codec: HarnessConfigCodec<{ model: string | null }> = {
      parse: (layers) => {
        const model = layers.global?.["model"];
        return { model: typeof model === "string" ? model : null };
      },
    };
    const registry = createHarnessRegistry();
    registry.register(baseHarness({ id: "coded", config: codec }));
    registry.derive({ id: "coded-work", displayName: "Work", base: "coded" });

    registry.validateConfigs(
      {
        global: {
          coded: { model: "base/model" },
          "coded-work": { model: "variant/model" },
        },
        project: {},
      },
      () => {},
    );

    expect(registry.config("coded")).toEqual({ model: "base/model" });
    expect(registry.config("coded-work")).toEqual({ model: "variant/model" });
  });

  it("claims its base's export capability only when the base has one", () => {
    const registry = createHarnessRegistry();
    registry.register(
      baseHarness({
        id: "exporting",
        readHandoverRecords: async () => ({
          sessionId: "session-1",
          records: [],
        }),
      }),
    );
    registry.register(baseHarness({ id: "closed" }));
    registry.derive({
      id: "exporting-work",
      displayName: "Work",
      base: "exporting",
    });
    registry.derive({ id: "closed-work", displayName: "Work", base: "closed" });

    expect(canReadHandoverRecords(registry.require("exporting-work"))).toBe(
      true,
    );
    expect(canReadHandoverRecords(registry.require("closed-work"))).toBe(false);
  });

  it("runs the variant's prepare before the base's and its teardown after", async () => {
    const order: string[] = [];
    const registry = createHarnessRegistry();
    registry.register(
      baseHarness({
        id: "ordered",
        prepare: async () => {
          order.push("base-prepare");
        },
        postStart: async () => {
          order.push("base-postStart");
        },
        teardown: async () => {
          order.push("base-teardown");
        },
      }),
    );
    registry.derive({
      id: "ordered-work",
      displayName: "Work",
      base: "ordered",
      prepare: async () => {
        order.push("variant-prepare");
      },
      postStart: async () => {
        order.push("variant-postStart");
      },
      teardown: async () => {
        order.push("variant-teardown");
      },
    });
    const entry = registry.require("ordered-work");

    await entry.prepare(prepareRequest());
    await entry.postStart?.({
      ...prepareRequest(),
      signal: new AbortController().signal,
    });
    await entry.teardown({
      pi: {} as ExtensionAPI,
      paneId: "pane-1",
      cwd: "/tmp/work",
      subagentId: "sub-1",
    } satisfies HarnessTeardownRequest);

    expect(order).toEqual([
      "variant-prepare",
      "base-prepare",
      "base-postStart",
      "variant-postStart",
      "variant-teardown",
      "base-teardown",
    ]);
  });

  it("fails the launch on a throwing variant hook, still unwinding in order", async () => {
    const order: string[] = [];
    const registry = createHarnessRegistry();
    registry.register(
      baseHarness({
        id: "unwound",
        prepare: async () => {
          order.push("base-prepare");
        },
        teardown: async () => {
          order.push("base-teardown");
        },
      }),
    );
    registry.derive({
      id: "unwound-work",
      displayName: "Work",
      base: "unwound",
      prepare: async () => {
        throw new Error("mount failed");
      },
      teardown: async () => {
        order.push("variant-teardown");
      },
    });
    const entry = registry.require("unwound-work");

    await expect(entry.prepare(prepareRequest())).rejects.toThrow(
      "mount failed",
    );
    await entry.teardown({
      pi: {} as ExtensionAPI,
      paneId: null,
      cwd: null,
      subagentId: "sub-1",
    });

    expect(order).toEqual(["variant-teardown", "base-teardown"]);
  });

  it("forgets a derivation with the registration that made it", () => {
    const registry: HarnessRegistry = createHarnessRegistry();
    registry.derive({ id: "gone", displayName: "Gone", base: "claude" });

    registry.unregister("gone");

    expect(registry.get("gone")).toBeUndefined();
    expect(registry.family("gone")).toBeUndefined();
  });
});
