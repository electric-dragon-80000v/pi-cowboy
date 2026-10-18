/**
 * plugin-loader.test.ts — importing installed plugins and running their
 * factories. Discovery is mocked here (it reads pi's own settings on disk); what
 * is real is the import, the factory call, the registrations it makes, the
 * skip-with-a-warning on a broken plugin, and the once-per-process load that a
 * dispose undoes.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerHarness,
  registeredHarness,
} from "../src/agents/harness/registry.js";
import {
  multiplexerRuntime,
  hasMultiplexer,
} from "../src/agents/multiplexer-registry.js";
import { loadPlugins, type LoadedPlugins } from "../src/plugin/loader.js";
import type { PluginHarness } from "../src/agents/harness.js";
import type { DiscoveredPlugin } from "../src/plugin/discovery.js";

const { discoverMock } = vi.hoisted(() => ({ discoverMock: vi.fn() }));

vi.mock("../src/plugin/discovery.js", () => ({
  discoverPluginPackages: discoverMock,
}));

const PI = {} as unknown as ExtensionAPI;

/** A minimal plugin harness, for asserting an id is free or taken. */
function pluginHarnessFor(id: string): PluginHarness {
  return {
    id,
    displayName: id,
    agentMultiplexerKind: id,
    availability: () => ({ status: "available" }),
    prepare: async () => {},
    buildArgs: () => [],
    teardown: async () => {},
    listModels: async () => [],
    prefetchModels: () => {},
  };
}
const made: string[] = [];
let loaded: LoadedPlugins | undefined;

afterEach(async () => {
  await loaded?.dispose();
  loaded = undefined;
  discoverMock.mockReset();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
  const globals = globalThis as Record<string, unknown>;
  delete globals.__fixtureRuns;
  delete globals.__fixtureDisposed;
  delete globals.__disposeGate;
});

/** An installed plugin package whose entry is the given ESM source. */
function pluginPackage(name: string, entrySource: string): DiscoveredPlugin {
  const root = mkdtempSync(join(tmpdir(), "cowboy-plugin-"));
  made.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name, "pi-cowboy": { plugin: "./index.mjs" } }),
  );
  const entry = join(root, "index.mjs");
  writeFileSync(entry, entrySource);
  return { name, source: name, root, entry };
}

/** A plugin that registers a harness and an multiplexer, and returns a disposer. */
const GOOD_PLUGIN = `
export default function (api) {
  api.registerHarness({
    id: "fixture-harness",
    displayName: "Fixture",
    agentMultiplexerKind: "fixture",
    availability: () => ({ status: "available" }),
    prepare: async () => {},
    buildArgs: () => ["fixture-run"],
    teardown: async () => {},
    listModels: async () => [{ key: "fixture/model", label: "Fixture" }],
    prefetchModels: () => {},
  });
  api.registerMultiplexer({ id: "fixture-multiplexer", create: () => ({ multiplexer: "fixture-multiplexer" }) });
  globalThis.__fixtureRuns = (globalThis.__fixtureRuns ?? 0) + 1;
  return () => {
    globalThis.__fixtureDisposed = (globalThis.__fixtureDisposed ?? 0) + 1;
  };
}
`;

function runCount(): number {
  const value = (globalThis as Record<string, unknown>).__fixtureRuns;
  return typeof value === "number" ? value : 0;
}

describe("loadPlugins", () => {
  it("imports each plugin and lets it register its harness and multiplexer", async () => {
    discoverMock.mockResolvedValue([pluginPackage("fixture-pkg", GOOD_PLUGIN)]);
    const notify = vi.fn();

    loaded = await loadPlugins(PI, process.cwd(), notify);

    expect(loaded.loaded).toEqual(["fixture-pkg"]);
    expect(notify).not.toHaveBeenCalled();

    const harness = registeredHarness("fixture-harness");
    expect(harness?.displayName).toBe("Fixture");
    // The registered harness is a real registry entry: its argv comes from the
    // plugin's own buildArgs.
    expect(harness?.buildArgs({ family: "plugin" } as never)).toEqual([
      "fixture-run",
    ]);

    expect(hasMultiplexer("fixture-multiplexer")).toBe(true);
    expect(multiplexerRuntime(PI, "fixture-multiplexer").multiplexer).toBe(
      "fixture-multiplexer",
    );
  });

  it("skips a plugin that throws while loading, and still loads the good one", async () => {
    discoverMock.mockResolvedValue([
      pluginPackage("broken-pkg", "export default 42;\n"),
      pluginPackage("good-pkg", GOOD_PLUGIN),
    ]);
    const notify = vi.fn();

    loaded = await loadPlugins(PI, process.cwd(), notify);

    expect(loaded.loaded).toEqual(["good-pkg"]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain('plugin "broken-pkg"');
    expect(notify.mock.calls[0]![0]).toContain(
      "could not load and was skipped",
    );
  });

  it("refuses a plugin harness that would shadow a built-in id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    discoverMock.mockResolvedValue([
      pluginPackage(
        "shadow-pkg",
        `export default (api) => {
          api.registerHarness({
            id: "pi",
            displayName: "Not Pi",
            family: "pi",
            agentMultiplexerKind: "pi",
            availability: () => ({ status: "available" }),
            prepare: async () => {},
            buildArgs: () => [],
            teardown: async () => {},
            listModels: async () => [],
            prefetchModels: () => {},
          });
        };
        `,
      ),
    ]);

    loaded = await loadPlugins(PI, process.cwd(), vi.fn());

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("a built-in harness owns that id");
    expect(registeredHarness("pi")?.displayName).toBe("Pi");
    warn.mockRestore();
  });

  it("loads once per process, and a dispose lets the next session reload cleanly", async () => {
    discoverMock.mockResolvedValue([pluginPackage("fixture-pkg", GOOD_PLUGIN)]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    loaded = await loadPlugins(PI, process.cwd(), vi.fn());
    expect(runCount()).toBe(1);
    expect(registeredHarness("fixture-harness")).toBeDefined();
    expect(hasMultiplexer("fixture-multiplexer")).toBe(true);

    // A second call in the same session returns the live load: the registries
    // are process-level, so re-registering would only repeat the work.
    const again = await loadPlugins(PI, process.cwd(), vi.fn());
    expect(again).toBe(loaded);
    expect(runCount()).toBe(1);

    await loaded.dispose();
    expect((globalThis as Record<string, unknown>).__fixtureDisposed).toBe(1);
    // Disposal drops the load's registrations, so the next load starts clean.
    expect(registeredHarness("fixture-harness")).toBeUndefined();
    expect(hasMultiplexer("fixture-multiplexer")).toBe(false);

    loaded = await loadPlugins(PI, process.cwd(), vi.fn());
    expect(runCount()).toBe(2);
    expect(registeredHarness("fixture-harness")).toBeDefined();
    // A clean registry means the reload is a first registration, not a duplicate.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("disposes idempotently, so a convergent reload cannot run a disposer twice", async () => {
    discoverMock.mockResolvedValue([pluginPackage("fixture-pkg", GOOD_PLUGIN)]);

    loaded = await loadPlugins(PI, process.cwd(), vi.fn());

    // Concurrent teardowns (pi's reload can produce them) run the disposer once.
    await Promise.all([loaded.dispose(), loaded.dispose()]);
    expect((globalThis as Record<string, unknown>).__fixtureDisposed).toBe(1);

    // A later one is a no-op too.
    await loaded.dispose();
    expect((globalThis as Record<string, unknown>).__fixtureDisposed).toBe(1);
  });
});

describe("loadPlugins — concurrent and reload-safe", () => {
  it("imports and runs each plugin once when two loads overlap", async () => {
    discoverMock.mockResolvedValue([pluginPackage("fixture-pkg", GOOD_PLUGIN)]);

    const [first, second] = await Promise.all([
      loadPlugins(PI, process.cwd(), vi.fn()),
      loadPlugins(PI, process.cwd(), vi.fn()),
    ]);

    expect(first).toBe(second);
    expect(runCount()).toBe(1);
    loaded = first;
  });

  it("does not let a stale handle's dispose clear a load that replaced it", async () => {
    discoverMock.mockResolvedValue([pluginPackage("fixture-pkg", GOOD_PLUGIN)]);
    const stale = await loadPlugins(PI, process.cwd(), vi.fn());
    await stale.dispose();

    const live = await loadPlugins(PI, process.cwd(), vi.fn());
    expect(registeredHarness("fixture-harness")).toBeDefined();

    // pi's reload can converge on the old handle; it must not wipe the session
    // that replaced it.
    await stale.dispose();
    expect(registeredHarness("fixture-harness")).toBeDefined();
    expect(hasMultiplexer("fixture-multiplexer")).toBe(true);
    loaded = live;
  });

  it("leaves no registration behind when a factory throws after registering", async () => {
    discoverMock.mockResolvedValue([
      pluginPackage(
        "half-pkg",
        `export default (api) => {
          api.registerHarness({
            id: "half-harness",
            displayName: "Half",
            agentMultiplexerKind: "half",
            availability: () => ({ status: "available" }),
            prepare: async () => {},
            buildArgs: () => [],
            teardown: async () => {},
            listModels: async () => [],
            prefetchModels: () => {},
          });
          throw new Error("half-built");
        };
        `,
      ),
    ]);
    const notify = vi.fn();

    loaded = await loadPlugins(PI, process.cwd(), notify);

    // The half-registered harness is gone, so its id is free for the plugin that
    // should own it (first-wins would otherwise have locked it out).
    expect(registeredHarness("half-harness")).toBeUndefined();
    expect(registerHarness(pluginHarnessFor("half-harness"))).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("could not load and was skipped"),
      "warning",
    );
  });
});

describe("loadPlugins — a session starting mid-teardown", () => {
  /** A plugin whose disposer waits on a gate the test releases. */
  const GATED_PLUGIN = `
export default (api) => {
  api.registerHarness({
    id: "gate-harness",
    displayName: "Gate",
    agentMultiplexerKind: "gate",
    availability: () => ({ status: "available" }),
    prepare: async () => {},
    buildArgs: () => [],
    teardown: async () => {},
    listModels: async () => [],
    prefetchModels: () => {},
  });
  return () => globalThis.__disposeGate ?? Promise.resolve();
};
`;

  it("loads fresh plugins, and the dying load's reset cannot wipe them", async () => {
    discoverMock.mockResolvedValue([pluginPackage("gate-pkg", GATED_PLUGIN)]);
    let release!: () => void;
    (globalThis as Record<string, unknown>).__disposeGate = new Promise<void>(
      (resolve) => {
        release = resolve;
      },
    );

    const dying = await loadPlugins(PI, process.cwd(), vi.fn());
    const teardown = dying.dispose();

    // A replacement session starts while the teardown is still awaiting its
    // disposer: it must load its own plugins, not adopt the dying handle.
    const replacementPromise = loadPlugins(PI, process.cwd(), vi.fn());
    release();
    await teardown;
    const replacement = await replacementPromise;

    expect(replacement).not.toBe(dying);
    // The dying load's reset ran *before* the replacement registered, so the
    // replacement's harness is still there.
    expect(registeredHarness("gate-harness")).toBeDefined();
    loaded = replacement;
  });
});
