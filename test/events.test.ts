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
import type { AgentSpawn } from "../src/types.js";
import { AgentSpawnStore } from "../src/agents/agent-spawn-store.js";
import { createConfigIO } from "../src/config/config-io.js";
import type { RawConfig } from "../src/config/config-io.js";
import { TEST_ORCHESTRATION } from "./helpers/orchestration.js";
import {
  recordOverlayMount,
  type OverlayCallOptions,
  type OverlayMount,
} from "./helpers/overlay-mounts.js";

const shell = vi.hoisted(() => ({
  store: null as unknown,
  manager: {
    listAgents: () => [],
    dispose: vi.fn(),
    // The eager attach after wiring; this file asserts the wiring, not the attach.
    attachLiveSpawns: vi.fn(),
  } as unknown,
  active: [] as string[],
  registeredTools: [] as string[],
  /** The store each test starts from; a reload's "memory" is exactly this. */
  spawnStore: null as unknown,
  /** What the session journal appended, in order. */
  journalEntries: [] as Array<{ kind: string; record?: { id: string } }>,
  /** The branch the session manager replays. */
  branch: [] as unknown[],
}));

vi.mock("../src/shell.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/shell.js")>()),
  getStore: () => shell.store,
  // A live manager skips the construction of the fleet controller.
  getManager: () => shell.manager,
  getManagerOrNull: () => shell.manager,
  setManager: vi.fn(),
  setCoordinator: vi.fn(),
  getAgentSpawns: () => shell.spawnStore,
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
    appendEntry: (_customType: string, entry: { kind: string }) => {
      shell.journalEntries.push(entry);
    },
  }),
}));

// The session runtime is stubbed: this file is about the switch and the active
// set, and the real one would walk PATH and the package manager (and import the
// developer's installed plugins) for every case. Its own wiring is covered by
// test/session-runtime.test.ts. Each boot's plugin handle is recorded, so a test
// can see which one a shutdown disposed.
const booted = vi.hoisted(() => ({
  plugins: [] as Array<{
    loaded: readonly string[];
    dispose: ReturnType<typeof vi.fn>;
  }>,
  /** Whether the stubbed boot found a multiplexer to host the session. */
  kind: "hosted" as "hosted" | "unhosted",
  reason: "no multiplexer hosts this process",
  /** The multiplexer the session's journal verifies restored records against. */
  runtime: {
    host: {},
    view: {},
    pane: {},
    placements: {},
    multiplexer: "test",
  } as unknown,
}));

vi.mock("../src/session-runtime.js", async () => {
  // The real journal composition, so this file pins the session wiring rather
  // than a stand-in for it; only the runtime boot itself is stubbed.
  const { bindSessionSpawnJournal } =
    await import("../src/spawn-journal-session.js");
  return {
    startSessionRuntime: async (pi: never, ctx: never) => {
      const plugins = { loaded: [], dispose: vi.fn(async () => {}) };
      booted.plugins.push(plugins);
      if (booted.kind === "unhosted") {
        return { kind: "unhosted", plugins, reason: booted.reason };
      }
      // The real boot binds the journal once a multiplexer hosts the session; the
      // runtime it verifies against is this file's stand-in.
      return {
        kind: "hosted",
        plugins,
        runtime: {},
        journal: await bindSessionSpawnJournal(
          pi,
          ctx,
          booted.runtime as never,
        ),
      };
    },
  };
});

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
const { COWBOY_TOOLS, COWBOY_TOOL_NAMES, REGISTERED_TOOL_NAMES } =
  await import("../src/registration.js");

/**
 * Points the agent dir at a fresh config file and installs the session's store
 * over it, unloaded like the shell's. The session reload swaps the IO for the
 * real one, so the file — not a fake IO — is what carries the flag.
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
  const handlers = sessionHandlers();
  return event === "session_start" ? handlers.start : handlers.shutdown;
}

/**
 * Both lifecycle handlers from ONE registration. What a start binds and a shutdown
 * releases lives in that registration's closure, so a test reading it across both
 * events must not register twice.
 */
function sessionHandlers(): {
  start: (event: unknown, ctx: unknown) => Promise<void>;
  shutdown: (event: unknown, ctx: unknown) => Promise<void>;
} {
  type Handler = (event: unknown, ctx: unknown) => Promise<void>;
  const handlers = new Map<string, Handler>();
  setupEventListeners({
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
    appendEntry: (_customType: string, entry: { kind: string }) => {
      shell.journalEntries.push(entry);
    },
  } as never);
  const start = handlers.get("session_start");
  const shutdown = handlers.get("session_shutdown");
  if (!start) throw new Error("session_start was not registered");
  if (!shutdown) throw new Error("session_shutdown was not registered");
  return { start, shutdown };
}

/** The session's ui, plus every presence-marker overlay it mounts. */
function sessionContext(notify: ReturnType<typeof vi.fn>) {
  const markers: OverlayMount[] = [];
  return {
    cwd: "/repo",
    hasUI: true,
    isProjectTrusted: () => false,
    markers,
    sessionManager: { getBranch: () => [...shell.branch] },
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
  shell.journalEntries.length = 0;
  shell.branch.length = 0;
  shell.spawnStore = new AgentSpawnStore();
  booted.plugins.length = 0;
  booted.kind = "hosted";
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
    expect(shell.active).toEqual([...REGISTERED_TOOL_NAMES]);
    expect(notify).not.toHaveBeenCalled();
    expect(ctx.markers).toHaveLength(2);
    expect(ctx.markers[0]!.options?.overlay).toBe(true);
    expect(ctx.markers[0]!.hidden()).toBe(false);
  });
});

describe("session_start with no multiplexer hosting the process", () => {
  it("leaves the tools inactive, says why, and reads no template", async () => {
    installStore({});
    booted.kind = "unhosted";
    shell.active = ["read", ...COWBOY_TOOL_NAMES];
    const notify = vi.fn();

    await sessionHandler("session_start")({}, sessionContext(notify));

    expect(shell.active).toEqual(["read"]);
    expect(notify).toHaveBeenCalledWith(booted.reason, "warning");
    // A session that can launch no agent has no use for its templates.
    expect(scanned.agents).not.toHaveBeenCalled();
    expect(scanned.orchestrators).not.toHaveBeenCalled();
  });

  it("says nothing to a session whose switch is already off", async () => {
    installStore({ agent: { extensionEnabled: false } });
    booted.kind = "unhosted";
    const notify = vi.fn();

    await sessionHandler("session_start")({}, sessionContext(notify));

    expect(notify).not.toHaveBeenCalled();
  });

  it("still hands the plugin load to shutdown, so its disposers run", async () => {
    installStore({});
    booted.kind = "unhosted";
    const ctx = sessionContext(vi.fn());
    // One registration, both handlers: a second setup would start its own
    // closure with its own plugin handle.
    type Handler = (event: unknown, ctx: unknown) => Promise<void>;
    const registered = new Map<string, Handler>();
    setupEventListeners({
      on: (name: string, handler: Handler) => {
        registered.set(name, handler);
      },
    } as never);

    await registered.get("session_start")!({}, ctx);
    await registered.get("session_shutdown")!({}, ctx);

    expect(booted.plugins).toHaveLength(1);
    expect(booted.plugins[0]!.dispose).toHaveBeenCalledTimes(1);
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

/* ── The session's spawn journal ──────────────────────────────────────── */

/** A spawn the store would already hold across a session replacement. */
function trackedSpawn(id: string): AgentSpawn {
  return {
    id,
    lifecycle: { phase: "spawned", startedAt: 1_700_000_000_000 },
    display: {
      type: "general-purpose",
      description: "still running",
      taskSlug: `task-${id}`,
      orchestration: TEST_ORCHESTRATION,
    },
    execution: {
      promise: Promise.resolve(""),
      abortController: new AbortController(),
      history: [],
    },
  };
}

/** One of our own custom entries, as a previous start would have left it. */
function branchRecord(record: unknown): unknown {
  return {
    type: "custom",
    customType: "pi-cowboy.spawn-journal",
    data: record,
    id: "e1",
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

describe("session_start and the spawn journal", () => {
  it("restores the branch's spawns into the store a reload left empty", async () => {
    installStore({});
    const store = shell.spawnStore as AgentSpawnStore;
    store.add(trackedSpawn("aaaaaaaa"));
    // What the previous session wrote: capture it, then reload (memory is gone).
    await sessionHandler("session_start")({}, sessionContext(vi.fn()));
    shell.branch.push(...shell.journalEntries.map(branchRecord));
    shell.journalEntries.length = 0;
    shell.spawnStore = new AgentSpawnStore();

    await sessionHandler("session_start")({}, sessionContext(vi.fn()));

    const restored = (shell.spawnStore as AgentSpawnStore).list();
    expect(restored.map((spawn) => spawn.id)).toEqual(["aaaaaaaa"]);
    // The branch already held it, so the restore wrote nothing back.
    expect(shell.journalEntries).toEqual([]);
  });

  it("seeds a replacement session with the spawns it still tracks", async () => {
    installStore({});
    (shell.spawnStore as AgentSpawnStore).add(trackedSpawn("aaaaaaaa"));
    // A fresh branch: this session has never heard of that spawn.

    await sessionHandler("session_start")({}, sessionContext(vi.fn()));

    expect(shell.journalEntries).toHaveLength(1);
    expect(shell.journalEntries[0]).toMatchObject({
      kind: "spawn",
      record: { id: "aaaaaaaa" },
    });
  });

  it("records a spawn registered while the session runs", async () => {
    installStore({});
    await sessionHandler("session_start")({}, sessionContext(vi.fn()));
    shell.journalEntries.length = 0;

    (shell.spawnStore as AgentSpawnStore).add(trackedSpawn("aaaaaaaa"));

    expect(shell.journalEntries).toHaveLength(1);
    expect(shell.journalEntries[0]).toMatchObject({
      record: { id: "aaaaaaaa" },
    });
  });

  it("records a drop as a tombstone, so a reload cannot resurrect it", async () => {
    installStore({});
    const store = shell.spawnStore as AgentSpawnStore;
    await sessionHandler("session_start")({}, sessionContext(vi.fn()));
    store.add(trackedSpawn("aaaaaaaa"));
    shell.journalEntries.length = 0;

    store.drop("aaaaaaaa");

    expect(shell.journalEntries).toHaveLength(1);
    expect(shell.journalEntries[0]).toMatchObject({ kind: "forgotten" });
  });

  it("stops writing once the session shuts down", async () => {
    installStore({});
    const ctx = sessionContext(vi.fn());
    const store = shell.spawnStore as AgentSpawnStore;
    // One registration: the handle the start binds is the one shutdown releases.
    const { start, shutdown } = sessionHandlers();
    await start({}, ctx);
    await shutdown({}, ctx);
    shell.journalEntries.length = 0;

    store.add(trackedSpawn("aaaaaaaa"));

    expect(shell.journalEntries).toEqual([]);
  });

  it("leaves the journal unbound in a session nothing hosts", async () => {
    installStore({});
    booted.kind = "unhosted";
    shell.branch.push(
      branchRecord({ v: 1, kind: "forgotten", spawnId: "a", at: 1 }),
    );

    // The branch is never read: a session that can launch no agent restores none.
    const before = shell.branch.length;
    await sessionHandler("session_start")({}, sessionContext(vi.fn()));

    expect(shell.branch).toHaveLength(before);
    expect(shell.journalEntries).toEqual([]);
  });
});
