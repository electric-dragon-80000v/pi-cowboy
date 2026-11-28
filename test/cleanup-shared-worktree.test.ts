/**
 * cleanup-shared-worktree.test.ts — regression: several agents in one
 * extension-owned worktree.
 *
 * Reconstructed from pi session 01a1fac4-ebeb-71f2-ba72-080969246a09: agent
 * ee9mce6s owned the checkout, and c3dz7paj, vkq4rec0 and b7q4n9rt were spawned
 * into that same checkout. All four settled in one herdr workspace (w176), each
 * in its own tab and pane. Cleanup of ee9mce6s was refused with `space-in-use`
 * for the three sibling panes, and the checkout could only be removed by hand
 * with `git worktree remove --force`.
 *
 * The session also recorded two other shapes of the same failure. 1ygvp8dk, a
 * picked co-tenant, was reported "Cleaned up … pane left open … worktree none"
 * while its pane was gone, and its settled spawn stayed in the store, leaving
 * the indicator's 💩. Several owned cleanups reported "NOT removed — herdr did
 * not confirm the worktree removal" after ~30 s, because herdr's `worktree
 * remove --force` was waiting on the agent still in the pane; the extension
 * never closed the settled run's own adopted pane first.
 *
 * The subject is the production cleanup path: AgentManager → the assets seam →
 * the real herdr host and placement catalog. Only the external planes are
 * faked, at the herdr-client boundary, against one in-memory world:
 *
 *  - `worktree list` reports the checkout open in w176;
 *  - `agent list` reports one record per pane (herdr 0.8.x drops the custom
 *    agent name, which is why the session's refusal named panes, not agents);
 *  - a settled run keeps its process and pane until cleanup, so its record
 *    stays listed;
 *  - `agent list` can outlive the pane: a stale record stays listed while
 *    `agent get` reports the pane gone, which is the divergence cleanup must
 *    reconcile;
 *  - `pane close` removes the pane and its agent record, and the tab and
 *    workspace when they become empty;
 *  - `worktree remove --workspace … --force` removes the checkout, closes the
 *    workspace's panes, and deletes the directory — but refuses while a live
 *    agent is still in the workspace, the 30 s timeout the session recorded.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSpawn } from "../src/types.js";
import type { CleanupReport } from "../src/agents/cleanup-policy.js";
import type { AgentHostRef } from "../src/agents/agent-host.js";
import { AgentSpawnStore } from "../src/agents/agent-spawn-store.js";
import { AgentManager } from "../src/agents/agent-manager.js";
import { createHerdrRuntime } from "../src/infrastructure/herdr-host.js";
import { ConcurrencyPools } from "../src/concurrency-pools.js";
import { TEST_ORCHESTRATION } from "./helpers/orchestration.js";
import { builtinTransport } from "./helpers/transport.js";

/* ── The in-memory herdr world ─────────────────────────────────────────── */

type HerdrState = "idle" | "working" | "blocked" | "done" | "unknown";

interface WorldAgent {
  /** Herdr 0.8.x usually drops the custom `agent start` name. */
  name?: string;
  state: HerdrState;
  workspaceId: string;
  tabId: string;
  cwd: string;
  paneId: string;
}

interface WorldTab {
  tabId: string;
  workspaceId: string;
  cwd: string;
  paneIds: string[];
}

interface WorldWorkspace {
  workspaceId: string;
  tabIds: string[];
  checkoutPath?: string;
}

interface WorldWorktree {
  path: string;
  branch: string;
  label: string;
  openWorkspaceId?: string;
}

/**
 * The herdr state one test owns. Only the surface the cleanup path reads and
 * acts on is modeled; every operation mirrors the real CLI semantics the
 * extension relies on (see the file header).
 */
class FakeHerdrWorld {
  readonly worktrees: WorldWorktree[] = [];
  readonly workspaces = new Map<string, WorldWorkspace>();
  readonly tabs = new Map<string, WorldTab>();
  readonly agents = new Map<string, WorldAgent>();
  /**
   * Records herdr's registry still lists after the pane is gone. `agent list`
   * reads them; `agent get` does not, which is the divergence cleanup must
   * reconcile instead of trusting either plane alone.
   */
  readonly staleRecords: WorldAgent[] = [];
  private nextTab = 1;
  private nextPane = 1;

  constructor(
    private readonly checkoutPath: string,
    private readonly branch: string,
    private readonly firstWorkspaceId = "w176",
  ) {
    // The checkout exists on disk but is not open yet: the owner's first
    // `worktree open` creates the workspace and hands back its root pane, which
    // is why that pane is adopted rather than extension-created.
    this.worktrees.push({
      path: checkoutPath,
      branch,
      label: branch,
    });
  }

  listWorktrees(): readonly WorldWorktree[] {
    return this.worktrees;
  }

  listAgentRecords(): readonly WorldAgent[] {
    // herdr 0.8.x drops the custom `agent start` name from `agent list`; the
    // name is still addressable through `agent get`, which is what spot
    // numbering probes. The session's refusal named panes for this reason.
    return [...this.agents.values(), ...this.staleRecords].map(
      ({ name: _name, ...record }) => record,
    );
  }

  getAgentInfo(target: string): WorldAgent | undefined {
    const byPane = this.agents.get(target);
    if (byPane !== undefined) return byPane;
    return [...this.agents.values()].find((agent) => agent.name === target);
  }

  /**
   * `herdr worktree remove --workspace <id> --force`: the checkout and the
   * workspace's panes go together. A workspace that is not a worktree's is not
   * this call's to remove, so it fails.
   */
  removeHerdrWorktree(workspaceId: string): boolean {
    const worktree = this.worktrees.find(
      (entry) => entry.openWorkspaceId === workspaceId,
    );
    if (worktree === undefined) return false;
    this.removeWorkspace(workspaceId);
    worktree.openWorkspaceId = undefined;
    fs.rmSync(worktree.path, { recursive: true, force: true });
    return true;
  }

  closePane(paneId: string): void {
    const agent = this.agents.get(paneId);
    if (agent === undefined) return; // Already gone: the client treats this as success.
    this.agents.delete(paneId);
    const tab = this.tabs.get(agent.tabId);
    if (tab === undefined) return;
    tab.paneIds = tab.paneIds.filter((id) => id !== paneId);
    if (tab.paneIds.length > 0) return;
    this.tabs.delete(tab.tabId);
    const workspace = this.workspaces.get(agent.workspaceId);
    if (workspace === undefined) return;
    workspace.tabIds = workspace.tabIds.filter((id) => id !== tab.tabId);
    if (workspace.tabIds.length === 0)
      this.workspaces.delete(workspace.workspaceId);
  }

  createAgentTab(options: {
    workspaceId: string;
    cwd: string;
    label: string;
  }): { tabId: string; paneId: string } {
    const workspace = this.workspaces.get(options.workspaceId);
    if (workspace === undefined) throw new Error("no such workspace");
    const tabId = `${options.workspaceId}:t${this.nextTab++}`;
    const paneId = `${options.workspaceId}:p${this.nextPane++}`;
    this.tabs.set(tabId, {
      tabId,
      workspaceId: options.workspaceId,
      cwd: options.cwd,
      paneIds: [paneId],
    });
    workspace.tabIds.push(tabId);
    return { tabId, paneId };
  }

  /** `herdr worktree open` / `pane close`: only what the host actually calls. */
  runHerdr(args: readonly string[]): unknown {
    if (args[0] === "worktree" && args[1] === "open") {
      const requested = args[args.indexOf("--path") + 1];
      const worktree = this.worktrees.find((entry) => entry.path === requested);
      if (worktree === undefined) throw new Error("no such worktree");
      if (worktree.openWorkspaceId !== undefined) {
        const workspace = this.workspaces.get(worktree.openWorkspaceId);
        const tabId = workspace?.tabIds[0];
        const paneId =
          tabId === undefined ? undefined : this.tabs.get(tabId)?.paneIds[0];
        return {
          already_open: true,
          worktree: { path: worktree.path, branch: worktree.branch },
          workspace: { workspace_id: worktree.openWorkspaceId },
          ...(tabId === undefined ? {} : { tab: { tab_id: tabId } }),
          ...(paneId === undefined ? {} : { root_pane: { pane_id: paneId } }),
        };
      }
      // The first workspace keeps the session's id so the reconstructed
      // placement addresses match the recorded state.
      const workspaceId =
        this.workspaces.size === 0
          ? this.firstWorkspaceId
          : `w${this.workspaces.size + 1}`;
      const tabId = `${workspaceId}:t1`;
      const paneId = `${workspaceId}:p1`;
      this.workspaces.set(workspaceId, {
        workspaceId,
        tabIds: [tabId],
        checkoutPath: worktree.path,
      });
      this.tabs.set(tabId, {
        tabId,
        workspaceId,
        cwd: worktree.path,
        paneIds: [paneId],
      });
      worktree.openWorkspaceId = workspaceId;
      this.nextTab = 2;
      this.nextPane = 2;
      return {
        worktree: { path: worktree.path, branch: worktree.branch },
        workspace: { workspace_id: workspaceId },
        tab: { tab_id: tabId },
        root_pane: { pane_id: paneId },
      };
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      const workspaceId = args[args.indexOf("--workspace") + 1];
      if (!this.removeHerdrWorktree(workspaceId)) {
        throw new Error("worktree remove failed");
      }
      return {};
    }
    if (args[0] === "pane" && args[1] === "close") {
      this.closePane(args[2]!);
      return {};
    }
    return {};
  }

  startAgent(options: { name: string; paneId: string }): void {
    const existing = this.agents.get(options.paneId);
    if (existing !== undefined) {
      existing.name = options.name;
      existing.state = "working";
      return;
    }
    const location = this.paneLocation(options.paneId);
    if (location === undefined) throw new Error("no such pane");
    this.agents.set(options.paneId, {
      name: options.name,
      state: "working",
      workspaceId: location.workspaceId,
      tabId: location.tabId,
      cwd: location.cwd,
      paneId: options.paneId,
    });
  }

  private paneLocation(
    paneId: string,
  ): { tabId: string; workspaceId: string; cwd: string } | undefined {
    for (const tab of this.tabs.values()) {
      if (tab.paneIds.includes(paneId)) {
        return {
          tabId: tab.tabId,
          workspaceId: tab.workspaceId,
          cwd: tab.cwd,
        };
      }
    }
    return undefined;
  }

  currentWorkspaceId(): string {
    return this.firstWorkspaceId;
  }

  setAgentState(paneId: string, state: HerdrState): void {
    const agent = this.agents.get(paneId);
    if (agent === undefined) throw new Error(`no agent in ${paneId}`);
    agent.state = state;
  }

  /**
   * Model herdr's registry lag: the pane is gone, but its record remains listed
   * until cleanup reconciles it. `agent get` no longer answers for the pane.
   */
  detachAgentRecord(paneId: string): void {
    const agent = this.agents.get(paneId);
    if (agent === undefined) return;
    this.agents.delete(paneId);
    this.staleRecords.push({ ...agent });
  }

  staleRecordPaneIds(): readonly string[] {
    return this.staleRecords.map((record) => record.paneId);
  }

  workspaceIds(): readonly string[] {
    return [...this.workspaces.keys()];
  }

  agentPaneIds(): readonly string[] {
    return [...this.agents.keys()];
  }

  removeWorkspace(workspaceId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined) return;
    for (const tabId of workspace.tabIds) {
      const tab = this.tabs.get(tabId);
      if (tab === undefined) continue;
      for (const paneId of tab.paneIds) {
        this.agents.delete(paneId);
        const stale = this.staleRecords.findIndex(
          (record) => record.paneId === paneId,
        );
        if (stale !== -1) this.staleRecords.splice(stale, 1);
      }
      this.tabs.delete(tabId);
    }
    this.workspaces.delete(workspaceId);
  }
}

/* ── Module seams ──────────────────────────────────────────────────────── */

const herdr = vi.hoisted(() => ({ world: undefined as unknown }));
const shell = vi.hoisted(() => ({ store: undefined as unknown }));

const world = (): FakeHerdrWorld => herdr.world as FakeHerdrWorld;
const store = (): AgentSpawnStore => shell.store as AgentSpawnStore;

vi.mock("../src/infrastructure/herdr-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/infrastructure/herdr-client.js")
    >();
  return {
    ...actual,
    listWorktrees: async () => world().listWorktrees(),
    listAgentRecords: async () => world().listAgentRecords(),
    getAgentInfo: async (_pi: unknown, target: string) =>
      world().getAgentInfo(target),
    removeHerdrWorktree: async (_pi: unknown, workspaceId: string) =>
      world().removeHerdrWorktree(workspaceId),
    closePane: async (_pi: unknown, paneId: string) =>
      world().closePane(paneId),
    createAgentTab: async (
      _pi: unknown,
      options: { workspaceId: string; cwd: string; label: string },
    ) => world().createAgentTab(options),
    runHerdr: async (_pi: unknown, args: readonly string[]) =>
      world().runHerdr(args),
    startAgent: async (
      _pi: unknown,
      options: { name: string; paneId: string },
    ) => world().startAgent(options),
    getCurrentWorkspaceId: async () => world().currentWorkspaceId(),
    findTaskAttempts: async () => [],
    waitForAgentGone: async () => true,
    renamePane: async () => {},
    renameTab: async () => {},
    focusTab: async () => {},
    sendAgentKeys: async () => {},
    runInPane: async () => {},
    waitForPaneOutput: async () => {},
    submitAgentPrompt: async () => {},
  };
});

vi.mock("../src/infrastructure/git-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/infrastructure/git-client.js")
    >();
  return {
    ...actual,
    // The cleanup plane only needs a repo cwd, a clean tree, and a branch it
    // may delete; the fake checkout itself is a real directory the herdr fake
    // removes.
    resolveMainCheckout: async () => "/repo",
    isWorktreeDirty: async () => false,
    deleteWorktreeBranch: async () => ({ kind: "deleted" as const }),
    removeGitWorktree: async (worktreePath: string) => {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    },
    listGitWorktrees: async () => [],
  };
});

const resultRoot = vi.hoisted(() => ({ dir: "" }));

vi.mock("../src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/paths.js")>();
  return {
    ...actual,
    subagentResultFileFor: (id: string) => `${resultRoot.dir}/${id}/result.md`,
    subagentResultDirFor: (id: string) => `${resultRoot.dir}/${id}`,
  };
});

vi.mock("../src/shell.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shell.js")>();
  const { createHarnessRegistry } =
    await import("../src/agents/harness/harness-registry.js");
  const harnesses = createHarnessRegistry();
  return {
    ...actual,
    getAgentSpawns: () => store(),
    getPiInstance: () => ({}),
    getSessionCtx: () => ({ cwd: "/repo" }),
    getStore: () => ({ agent: { worktreePrefix: "cow-" } }),
    getCoordinatorOrNull: () => null,
    getHarnessRegistry: () => harnesses,
  };
});

/* ── The recorded scenario ─────────────────────────────────────────────── */

const BRANCH = "cow-event-debug-impl-ee9mce6s";
const OWNER_ID = "ee9mce6s";
const P3_ID = "c3dz7paj";
const P4_ID = "vkq4rec0";
const P5_ID = "b7q4n9rt";
const STARTED_AT = 1_700_000_000_000;

function settledSpawn(options: {
  id: string;
  taskSlug: string;
  worktree: AgentSpawn["display"]["worktree"];
  host: AgentHostRef;
  phase?: "settled" | "spawned";
  harness?: string;
}): AgentSpawn {
  const lifecycle =
    options.phase === "spawned"
      ? ({ phase: "spawned", startedAt: STARTED_AT } as const)
      : ({
          phase: "settled",
          startedAt: STARTED_AT,
          status: "completed",
          result: "done",
          completedAt: STARTED_AT + 1_000,
        } as const);
  return {
    id: options.id,
    lifecycle,
    display: {
      type: "general-purpose",
      description: options.taskSlug,
      taskSlug: options.taskSlug,
      orchestration: TEST_ORCHESTRATION,
      worktree: options.worktree,
    },
    execution: {
      history: [],
      host: options.host,
      harness: options.harness ?? "pi",
      promise: Promise.resolve("done"),
      abortController: new AbortController(),
      spawnCtx: { cwd: "/repo" } as never,
    },
  };
}

/* ── The scenario ──────────────────────────────────────────────────────── */

describe("cleanup of several agents in one extension-owned worktree", () => {
  let root: string;
  let checkout: string;
  let manager: AgentManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cowboy-shared-worktree-"));
    checkout = path.join(root, BRANCH);
    fs.mkdirSync(checkout, { recursive: true });
    fs.writeFileSync(path.join(checkout, "README.md"), "checkout\n");
    resultRoot.dir = path.join(root, "results");
    fs.mkdirSync(resultRoot.dir, { recursive: true });
    herdr.world = new FakeHerdrWorld(checkout, BRANCH);
    shell.store = new AgentSpawnStore();
    manager = new AgentManager(new ConcurrencyPools(), builtinTransport());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * The four records the session wrote: one owner, three picked co-tenants.
   * Their placements are made through the real host over the fake herdr, so the
   * workspace, tabs, panes and `paneCreated` flags are production decisions:
   * the owner's first `worktree open` adopts the root pane (not created), and
   * each later agent gets a tab of its own (created).
   */
  async function registerRecordedAgents(
    options: { liveId?: string; staleIds?: readonly string[] } = {},
  ): Promise<void> {
    const { liveId, staleIds = [] } = options;
    const runtime = createHerdrRuntime({} as never);
    const checkoutBinding = {
      path: checkout,
      repoCwd: "/repo",
      branch: BRANCH,
    };
    async function place(label: string): Promise<AgentHostRef> {
      const ref = await runtime.host.hostAt({
        unit: "pane",
        cwd: checkout,
        label,
        name: BRANCH,
        checkout: checkoutBinding,
      });
      await runtime.host.start(ref, {
        name: ref.name,
        piArgs: [],
        agentMultiplexerKind: "pi",
      });
      // A settled run keeps its process and pane until cleanup.
      world().setAgentState(ref.paneId, "idle");
      return ref;
    }

    const ownerHost = await place("event-debug-impl");
    const p3Host = await place("event-debug-p3");
    const p4Host = await place("event-debug-p4");
    const p5Host = await place("event-debug-p5");
    const owner = settledSpawn({
      id: OWNER_ID,
      taskSlug: "event-debug-impl",
      worktree: { kind: "owned", path: checkout, branch: BRANCH },
      host: ownerHost,
    });
    const siblings = [
      settledSpawn({
        id: P3_ID,
        taskSlug: "event-debug-p3",
        worktree: { kind: "picked", path: checkout, branch: BRANCH },
        host: p3Host,
        phase: liveId === P3_ID ? "spawned" : "settled",
      }),
      settledSpawn({
        id: P4_ID,
        taskSlug: "event-debug-p4",
        worktree: { kind: "picked", path: checkout, branch: BRANCH },
        host: p4Host,
        phase: liveId === P4_ID ? "spawned" : "settled",
      }),
      settledSpawn({
        id: P5_ID,
        taskSlug: "event-debug-p5",
        worktree: { kind: "picked", path: checkout, branch: BRANCH },
        host: p5Host,
        phase: liveId === P5_ID ? "spawned" : "settled",
      }),
    ];
    for (const spawn of [owner, ...siblings]) store().add(spawn);
    for (const id of staleIds) {
      const spawn = [owner, ...siblings].find(
        (candidate) => candidate.id === id,
      );
      if (spawn?.execution.host !== undefined) {
        world().detachAgentRecord(spawn.execution.host.paneId);
      }
    }
    if (liveId !== undefined) {
      const live = [owner, ...siblings].find((spawn) => spawn.id === liveId);
      if (live?.execution.host !== undefined) {
        world().setAgentState(live.execution.host.paneId, "working");
      }
    }
  }

  // Pinned with `it.fails`: the recorded refusal is gone (the owner's run tears
  // down and drops), but the checkout is kept because a gone pane's record still
  // counts as a tenant. Reconciling a record against its pane is a separate
  // change; an unexpected pass here is the signal to promote it.
  it.fails(
    "removes the shared checkout once every agent in it has settled",
    async () => {
      await registerRecordedAgents({ staleIds: [P3_ID, P4_ID, P5_ID] });

      // The recorded failure: cleanup of the owner was refused with
      // `space-in-use` for w176:p2, w176:p3 and w176:p4. The panes were gone;
      // herdr's registry still listed their records, and cleanup counted records
      // instead of asking each pane. Reconciliation must treat a gone record as
      // an absent run, not an eternal blocker.
      expect(world().agentPaneIds()).toEqual(["w176:p1"]);
      expect(world().staleRecordPaneIds()).toEqual([
        "w176:p2",
        "w176:p3",
        "w176:p4",
      ]);
      const report = await manager.cleanup(OWNER_ID);

      expect(report.outcome).toEqual({ kind: "torn-down" });
      expect(report.worktree).toEqual({ kind: "removed", path: checkout });
      expect(fs.existsSync(checkout)).toBe(false);
      expect(world().workspaceIds()).toEqual([]);
      expect(world().agentPaneIds()).toEqual([]);

      // No record is left pointing at a resource that is already gone: each
      // co-tenant either dropped with the group or cleans up as an absent pane.
      const remaining = [P3_ID, P4_ID, P5_ID].filter(
        (id) => store().get(id) !== undefined,
      );
      const remainingReports: CleanupReport[] = [];
      for (const id of remaining) {
        remainingReports.push(await manager.cleanup(id));
      }
      expect(remainingReports.map((report) => report.outcome)).toEqual(
        remaining.map(() => ({ kind: "torn-down" })),
      );
      expect(
        remainingReports.flatMap((report) =>
          report.panes.filter((pane) => pane.kind === "open"),
        ),
      ).toEqual([]);
      expect(store().list()).toEqual([]);
    },
  );

  it("drops a picked run's record instead of reporting it cleaned up with its pane still open", async () => {
    // The user-visible failure: 1ygvp8dk picked the extension-owned
    // cow-cache-parity-pegx0zyd checkout and was the only agent placed in its
    // workspace (w171), so its placement was the adopted root pane
    // (paneCreated false). Its pane is gone, but the spawn record and herdr's
    // registry record remain. Cleanup reported "Cleaned up … pane left open …
    // worktree none", yet the spawn stayed tracked and the indicator kept its
    // 💩.
    const pickedBranch = "cow-cache-parity-pegx0zyd";
    const pickedCheckout = path.join(root, pickedBranch);
    fs.mkdirSync(pickedCheckout, { recursive: true });
    herdr.world = new FakeHerdrWorld(pickedCheckout, pickedBranch, "w171");
    const runtime = createHerdrRuntime({} as never);
    const ref = await runtime.host.hostAt({
      unit: "pane",
      cwd: pickedCheckout,
      label: "cache-retry",
      name: pickedBranch,
      checkout: {
        path: pickedCheckout,
        repoCwd: "/repo",
        branch: pickedBranch,
      },
    });
    await runtime.host.start(ref, {
      name: ref.name,
      piArgs: [],
      agentMultiplexerKind: "pi",
    });
    world().setAgentState(ref.paneId, "idle");
    expect(ref).toMatchObject({
      paneId: "w171:p1",
      tabId: "w171:t1",
      paneCreated: false,
    });
    const id = "1ygvp8dk";
    store().add(
      settledSpawn({
        id,
        taskSlug: "cache-retry",
        worktree: {
          kind: "picked",
          path: pickedCheckout,
          branch: pickedBranch,
        },
        host: ref,
        harness: "freebuff-relay-2",
      }),
    );
    world().detachAgentRecord(ref.paneId);
    expect(world().agentPaneIds()).toEqual([]);
    expect(world().staleRecordPaneIds()).toEqual([ref.paneId]);

    const report = await manager.cleanup(id);

    // The report already claims success; the state behind it does not follow.
    expect(report.outcome).toEqual({ kind: "torn-down" });

    // A teardown is only a cleanup when the record is gone. The run's recorded
    // address is cleanup's to close even though herdr had already dropped the
    // pane, so the close succeeds and the spawn drops; neither `paneCreated` nor
    // a stale record keeps it tracked.
    expect(report.panes).toEqual([{ kind: "closed", paneId: ref.paneId }]);
    expect(store().get(id)).toBeUndefined();
    expect(world().agentPaneIds()).toEqual([]);
  });

  it("removes an exclusive checkout through its workspace, taking the pane with it", async () => {
    const branch = "cow-thin-tauri-host-06tc7e04";
    const singleCheckout = path.join(root, branch);
    fs.mkdirSync(singleCheckout, { recursive: true });
    herdr.world = new FakeHerdrWorld(singleCheckout, branch, "wZN");
    const runtime = createHerdrRuntime({} as never);
    const ref = await runtime.host.hostAt({
      unit: "pane",
      cwd: singleCheckout,
      label: "thin-tauri-host",
      name: branch,
      checkout: { path: singleCheckout, repoCwd: "/repo", branch },
    });
    await runtime.host.start(ref, {
      name: ref.name,
      piArgs: [],
      agentMultiplexerKind: "pi",
    });
    world().setAgentState(ref.paneId, "idle");
    const id = "06tc7e04";
    store().add(
      settledSpawn({
        id,
        taskSlug: "thin-tauri-host",
        worktree: { kind: "owned", path: singleCheckout, branch },
        host: ref,
      }),
    );

    const report = await manager.cleanup(id);

    // The removal releases the workspace, and the workspace's only pane goes with
    // it: the run's pane is closed by the removal, not by a close before it.
    expect(report.outcome).toEqual({ kind: "torn-down" });
    expect(report.worktree).toEqual({ kind: "removed", path: singleCheckout });
    expect(report.panes).toEqual([{ kind: "closed", paneId: ref.paneId }]);
    expect(store().get(id)).toBeUndefined();
    expect(fs.existsSync(singleCheckout)).toBe(false);
  });

  it("drains the same state when the co-tenants are cleaned before the owner (control)", async () => {
    await registerRecordedAgents({});

    // The workaround the session ended with, done through the tool instead of
    // `git worktree remove --force`: each picked co-tenant closes its own pane
    // and drops, leaving the owner alone in the workspace. This path passes
    // today, which is what makes the owner-first refusal the regression rather
    // than a broken removal plane.
    const siblingIds = [P3_ID, P4_ID, P5_ID];
    const siblingReports: CleanupReport[] = [];
    for (const id of siblingIds) {
      siblingReports.push(await manager.cleanup(id));
    }
    const expectedSibling = {
      outcome: { kind: "torn-down" },
      worktree: { kind: "none" },
      panes: [{ kind: "closed", paneId: expect.any(String) }],
    };
    expect(
      siblingReports.map((report) => ({
        outcome: report.outcome,
        worktree: report.worktree,
        panes: report.panes,
      })),
    ).toEqual(siblingIds.map(() => expectedSibling));
    expect(siblingIds.filter((id) => store().get(id) !== undefined)).toEqual(
      [],
    );

    const report = await manager.cleanup(OWNER_ID);

    expect(report.outcome).toEqual({ kind: "torn-down" });
    expect(report.worktree).toEqual({ kind: "removed", path: checkout });
    expect(fs.existsSync(checkout)).toBe(false);
    expect(store().list()).toEqual([]);
  });

  it("cleans the owner's own pane while keeping the shared checkout for a live sibling", async () => {
    await registerRecordedAgents({ liveId: P4_ID });

    const report = await manager.cleanup(OWNER_ID);

    // The checkout is shared, so it stays for the live sibling; that is the
    // space's fate, not the owner's. The owner's run is still over, so its own
    // tab and pane close and its record drops. A shared checkout must not turn
    // one run's cleanup into a refusal that leaves its record behind.
    expect(report.outcome).toEqual({ kind: "torn-down" });
    expect(report.panes).toEqual([{ kind: "closed", paneId: "w176:p1" }]);
    expect(report.worktree.kind).toBe("kept");
    expect(store().get(OWNER_ID)).toBeUndefined();
    expect(fs.existsSync(checkout)).toBe(true);
    expect(world().workspaceIds()).toEqual(["w176"]);
    expect(world().agentPaneIds()).toEqual(["w176:p2", "w176:p3", "w176:p4"]);
    expect(store().get(P4_ID)?.lifecycle.phase).toBe("spawned");
  });
});
