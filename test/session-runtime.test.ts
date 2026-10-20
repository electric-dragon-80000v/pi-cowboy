/**
 * session-runtime.test.ts — the one step a session takes to bring its runtime
 * up: load plugins, build the configured multiplexer, answer whether anything
 * hosts this process, probe the harness vocabulary, and report the configured
 * ids nothing registered. PATH is pinned to an empty directory so the probe's
 * verdict never depends on the machine running the suite, and the plugin loader
 * is stubbed so no installed plugin is imported.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { NO_HOST_REASON } from "../src/host-multiplexer.js";

const shellState = vi.hoisted(() => ({
  store: undefined as unknown,
  runtime: undefined as unknown,
}));

/** A multiplexer the stubbed loader registers, for the cases that need one. */
const plugin = vi.hoisted(() => ({
  multiplexerId: undefined as string | undefined,
  /** Whether the stubbed plugin's multiplexer detects this process. */
  multiplexerHosts: true,
}));

vi.mock("../src/plugin/loader.js", () => ({
  createPluginLoader: (registries: {
    multiplexers: {
      register: (registration: {
        id: string;
        hosts: () => boolean;
        create: () => unknown;
      }) => boolean;
    };
  }) => ({
    load: vi.fn(async () => {
      const id = plugin.multiplexerId;
      if (id !== undefined) {
        registries.multiplexers.register({
          id,
          hosts: () => plugin.multiplexerHosts,
          create: () => ({ multiplexer: id }),
        });
      }
      return { loaded: [], dispose: async () => {} };
    }),
  }),
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
    harnessConfigLayers: () => ({ global: {}, project: {} }),
    reportHarnessConfigIssue: vi.fn(),
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
  // A hosted session by default: the cases about the host answer override this.
  vi.stubEnv("HERDR_ENV", "1");
  shellState.runtime = undefined;
  plugin.multiplexerId = undefined;
  plugin.multiplexerHosts = true;
});

afterEach(() => {
  vi.unstubAllEnvs();
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

    expect(boot.kind).toBe("hosted");
    if (boot.kind !== "hosted") return;
    expect(boot.runtime.multiplexer).toBe("herdr");
    expect(shellState.runtime).toBe(boot.runtime);
  });

  it("reports a session nothing hosts instead of recording a runtime", async () => {
    vi.stubEnv("HERDR_ENV", "");
    shellState.store = fakeStore();

    const boot = await startSessionRuntime(
      {} as ExtensionAPI,
      context(vi.fn()),
    );

    expect(boot.kind).toBe("unhosted");
    if (boot.kind !== "unhosted") return;
    expect(boot.reason).toBe(NO_HOST_REASON);
    expect(shellState.runtime).toBeUndefined();
  });

  it("runs a plugin multiplexer that detects this process where the built-in cannot host", async () => {
    vi.stubEnv("HERDR_ENV", "");
    plugin.multiplexerId = "tmux";
    shellState.store = fakeStore({ multiplexer: "tmux" });

    const boot = await startSessionRuntime(
      {} as ExtensionAPI,
      context(vi.fn()),
    );

    expect(boot.kind).toBe("hosted");
    if (boot.kind !== "hosted") return;
    expect(boot.runtime.multiplexer).toBe("tmux");
    expect(shellState.runtime).toBe(boot.runtime);
  });

  it("prefers a detected host over the configured id when the two disagree", async () => {
    vi.stubEnv("HERDR_ENV", "");
    plugin.multiplexerId = "tmux";
    // The config names the built-in, which does not host this process.
    shellState.store = fakeStore({ multiplexer: "herdr" });

    const boot = await startSessionRuntime(
      {} as ExtensionAPI,
      context(vi.fn()),
    );

    expect(boot.kind).toBe("hosted");
    if (boot.kind !== "hosted") return;
    expect(boot.runtime.multiplexer).toBe("tmux");
  });

  it("stays unhosted when the only registered multiplexer does not detect this process", async () => {
    vi.stubEnv("HERDR_ENV", "");
    plugin.multiplexerId = "tmux";
    plugin.multiplexerHosts = false;
    shellState.store = fakeStore({ multiplexer: "tmux" });

    const boot = await startSessionRuntime(
      {} as ExtensionAPI,
      context(vi.fn()),
    );

    expect(boot.kind).toBe("unhosted");
    expect(shellState.runtime).toBeUndefined();
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
