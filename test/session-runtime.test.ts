/**
 * session-runtime.test.ts — the one step a session takes to bring its runtime
 * up: load plugins, build the configured multiplexer, probe the harness vocabulary,
 * and report the configured ids nothing registered. PATH is pinned to an empty
 * directory so the probe's verdict never depends on the machine running the
 * suite, and the plugin loader is stubbed so no installed plugin is imported.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const shellState = vi.hoisted(() => ({
  store: undefined as unknown,
  runtime: undefined as unknown,
}));

vi.mock("../src/plugin/loader.js", () => ({
  loadPlugins: vi.fn(async () => ({ loaded: [], dispose: async () => {} })),
}));

vi.mock("../src/shell.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/shell.js")>()),
  getStore: () => shellState.store,
  setRuntime: (runtime: unknown) => {
    shellState.runtime = runtime;
  },
}));

const { startSessionRuntime } = await import("../src/session-runtime.js");

/** A store stand-in carrying only the surface the runtime reads. */
function fakeStore(
  over: {
    harnessType?: string;
    multiplexer?: string;
    extraHarnessKeys?: readonly string[];
  } = {},
) {
  const harnessType = over.harnessType ?? "pi";
  return {
    agent: { harnessType },
    multiplexer: over.multiplexer ?? "herdr",
    configuredHarnessIds: () => [harnessType, ...(over.extraHarnessKeys ?? [])],
  };
}

function context(notify: ReturnType<typeof vi.fn>): ExtensionContext {
  return {
    cwd: process.cwd(),
    hasUI: true,
    ui: { notify },
  } as unknown as ExtensionContext;
}

const realPath = process.env.PATH;
const made: string[] = [];

beforeEach(() => {
  // Only what this fresh directory holds is on PATH, so the probe's answer is
  // fixed and emits no notices.
  const dir = mkdtempSync(join(tmpdir(), "cowboy-runtime-"));
  made.push(dir);
  process.env.PATH = dir;
});

afterEach(() => {
  process.env.PATH = realPath;
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("startSessionRuntime", () => {
  it("records the configured multiplexer as the session's runtime", async () => {
    shellState.store = fakeStore();

    const boot = await startSessionRuntime(
      {} as ExtensionAPI,
      context(vi.fn()),
    );

    expect(boot.runtime.multiplexer).toBe("herdr");
    expect(shellState.runtime).toBe(boot.runtime);
  });

  it("names every configured harness and multiplexer id that nothing registered", async () => {
    shellState.store = fakeStore({
      harnessType: "ghost-harness",
      multiplexer: "ghost-multiplexer",
      extraHarnessKeys: ["ghost-limit"],
    });
    const notify = vi.fn();

    await startSessionRuntime({} as ExtensionAPI, context(notify));

    const message = notify.mock.calls
      .map(([text]) => String(text))
      .find((text) => text.includes("nothing registered"));
    expect(message).toContain('harness "ghost-harness"');
    expect(message).toContain('harness "ghost-limit"');
    expect(message).toContain('multiplexer "ghost-multiplexer"');
    expect(notify).toHaveBeenCalledWith(message, "warning");
  });

  it("says nothing when everything the config names is registered", async () => {
    shellState.store = fakeStore();
    const notify = vi.fn();

    await startSessionRuntime({} as ExtensionAPI, context(notify));

    expect(notify).not.toHaveBeenCalled();
  });
});
