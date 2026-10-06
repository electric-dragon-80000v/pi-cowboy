/**
 * events.test.ts — what session_start does under the switch.
 * Pins that the config and both template registries load whatever the switch
 * says (the /cowboy menus read them), and that the active set is put in line
 * with the flag: a session that replaced an enabled one still holds the
 * registered tools until they are dropped again.
 *
 * The tools themselves are registered at extension initialization; what the
 * session does to them is fresh registries plus the active-set rewrite.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import { ConfigStore } from "../src/config/config-store.js";
import { createConfigIO } from "../src/config/config-io.js";
import type { RawConfig } from "../src/config/config-io.js";
import {
  recordOverlayMount,
  type OverlayCallOptions,
  type OverlayMount,
} from "./helpers/overlay-mounts.js";

const shell = vi.hoisted(() => ({
  store: null as unknown,
  manager: { listAgents: () => [], dispose: vi.fn() } as unknown,
  active: [] as string[],
  registeredTools: [] as string[],
}));

vi.mock("../src/shell.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/shell.js")>()),
  getStore: () => shell.store,
  // A live manager skips the construction of the fleet controller.
  getManager: () => shell.manager,
  getManagerOrNull: () => shell.manager,
  setManager: vi.fn(),
  setCoordinator: vi.fn(),
  getPiInstance: () => ({
    getActiveTools: () => [...shell.active],
    setActiveTools: (names: string[]) => {
      shell.active = names;
    },
    registerTool: (tool: { name: string }) => {
      shell.registeredTools.push(tool.name);
    },
    registerMessageRenderer: () => {},
    registerCommand: () => {},
  }),
}));

const scanned = vi.hoisted(() => ({
  agents: vi.fn(async () => ({})),
  orchestrators: vi.fn(async () => ({})),
}));

vi.mock("../src/agents/agent-types.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agents/agent-types.js")>()),
  setAgentScanDirs: vi.fn(),
  scanAndMerge: scanned.agents,
  registerAgents: vi.fn(),
}));
vi.mock("../src/orchestrators/orchestrator-types.js", () => ({
  setOrchestratorScanDirs: vi.fn(),
  scanAndMergeOrchestrators: scanned.orchestrators,
  registerOrchestrators: vi.fn(),
}));
const { setupEventListeners } = await import("../src/events.js");
const { COWBOY_TOOLS, COWBOY_TOOL_NAMES } =
  await import("../src/registration.js");

/**
 * Points the agent dir at a fresh config file and loads a store from it. The
 * session reload swaps the IO for the real one, so the file — not a fake IO —
 * is what carries the flag.
 */
function installStore(global: RawConfig): void {
  const root = mkdtempSync(join(tmpdir(), "pi-cowboy-events-"));
  const agentRoot = join(root, "agent");
  mkdirSync(join(agentRoot, "pi-cowboy"), { recursive: true });
  writeFileSync(
    join(agentRoot, "pi-cowboy", "config.json"),
    JSON.stringify(global),
  );
  vi.stubEnv("PI_CODING_AGENT_DIR", agentRoot);
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  shell.store = new ConfigStore(createConfigIO(undefined));
}

/** The handler the extension registered for one lifecycle event. */
function sessionHandler(
  event: "session_start" | "session_shutdown",
): (event: unknown, ctx: unknown) => Promise<void> {
  type Handler = (event: unknown, ctx: unknown) => Promise<void>;
  const handlers = new Map<string, Handler>();
  setupEventListeners({
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as never);
  const handler = handlers.get(event);
  if (!handler) throw new Error(`${event} was not registered`);
  return handler;
}

/** The session's ui, plus every presence-marker overlay it mounts. */
function sessionContext(notify: ReturnType<typeof vi.fn>) {
  const markers: OverlayMount[] = [];
  return {
    cwd: "/repo",
    hasUI: true,
    isProjectTrusted: () => false,
    markers,
    ui: {
      notify,
      custom: (factory: () => Component, options?: OverlayCallOptions) => {
        markers.push(recordOverlayMount(factory, options));
        return Promise.resolve(undefined);
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  shell.active = [];
  shell.registeredTools = [];
});

describe("session_start while the extension is disabled", () => {
  it("still loads both template registries and registers no tool", async () => {
    installStore({ agent: { extensionEnabled: false } });

    await sessionHandler("session_start")({}, sessionContext(vi.fn()));

    expect(scanned.agents).toHaveBeenCalledTimes(1);
    expect(scanned.orchestrators).toHaveBeenCalledTimes(1);
    expect(shell.registeredTools).toEqual([]);
  });

  it("drops the tools a session that replaced an enabled one left in the active set", async () => {
    installStore({ agent: { extensionEnabled: false } });
    shell.active = ["read", ...COWBOY_TOOL_NAMES];

    await sessionHandler("session_start")({}, sessionContext(vi.fn()));

    expect(shell.active).toEqual(["read"]);
  });

  it("says the tools are not loaded", async () => {
    installStore({ agent: { extensionEnabled: false } });
    const notify = vi.fn();
    const ctx = sessionContext(notify);

    await sessionHandler("session_start")({}, ctx);

    expect(notify).toHaveBeenCalledWith(
      "Cowboy extension is disabled — its tools are not loaded. Run /cowboy enable to turn it back on.",
      "info",
    );
    expect(ctx.markers).toEqual([]);
  });
});

describe("session_start while the extension is enabled", () => {
  it("re-registers the agent tool and puts every name in the active set", async () => {
    installStore({});
    const notify = vi.fn();
    const ctx = sessionContext(notify);

    await sessionHandler("session_start")({}, ctx);

    expect(shell.registeredTools).toEqual([COWBOY_TOOLS.agent]);
    expect(shell.active).toEqual([...COWBOY_TOOL_NAMES]);
    expect(notify).not.toHaveBeenCalled();
    expect(ctx.markers).toHaveLength(2);
    expect(ctx.markers[0]!.options?.overlay).toBe(true);
    expect(ctx.markers[0]!.hidden()).toBe(false);
  });
});

describe("session_shutdown", () => {
  it("takes the presence marker down with the runtime it belongs to", async () => {
    installStore({});
    const ctx = sessionContext(vi.fn());
    await sessionHandler("session_start")({}, ctx);
    expect(ctx.markers[0]!.hidden()).toBe(false);

    await sessionHandler("session_shutdown")({}, ctx);

    expect(ctx.markers[0]!.hidden()).toBe(true);
  });
});
