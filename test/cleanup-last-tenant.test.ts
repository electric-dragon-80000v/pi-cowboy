/**
 * cleanup-last-tenant.test.ts — regression: the last agent out of a worktree
 * must take the checkout with it.
 *
 * Cleanup used to remove a checkout through the herdr workspace that hosts it.
 * It now closes a settled run's own pane before asking herdr to remove that
 * workspace, and herdr destroys a workspace the moment its last pane closes.
 * The removal therefore addresses a workspace that no longer exists:
 * `herdr worktree remove --workspace <id>` answers `workspace_not_found`, the
 * extension reports `removal-failed`, and the checkout stays on disk with its
 * spawn record still tracked — after every agent in it has been cleaned up.
 *
 * The subject is the production cleanup path: AgentManager → the assets seam →
 * the real herdr host and placement catalog. Only the herdr CLI boundary is
 * faked, against one in-memory world that mirrors the states herdr actually
 * reports:
 *
 *  - a pane exists whether or not an agent occupies it, and closing the last
 *    pane of a workspace closes that workspace;
 *  - `worktree list` names a checkout's `open_workspace_id` only while that
 *    workspace is open;
 *  - `worktree remove --workspace <id>` resolves the checkout through the
 *    workspace, so it fails once the workspace is gone, and it refuses while a
 *    live agent still occupies the workspace;
 *  - `pane close` removes the pane and its agent record and closes its tab and
 *    workspace when they become empty.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSpawn } from "../src/types.js";
import type { AgentHostRef } from "../src/agents/agent-host.js";
import { AgentSpawnStore } from "../src/agents/agent-spawn-store.js";
import { AgentManager } from "../src/agents/agent-manager.js";
import { createHerdrRuntime } from "../src/infrastructure/herdr-host.js";
import { ConcurrencyPools } from "../src/concurrency-pools.js";
import { TEST_ORCHESTRATION } from "./helpers/orchestration.js";
import { builtinTransport } from "./helpers/transport.js";

/* ── The in-memory herdr world ─────────────────────────────────────────── */

type HerdrState = "idle" | "working" | "blocked" | "done" | "unknown";

interface WorldPane {
  paneId: string;
  tabId: string;
  workspaceId: string;
  cwd: string;
}

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
}

interface WorldWorktree {
  path: string;
  branch: string;
  openWorkspaceId?: string;
}

/**
 * The value following `flag` on a command line, or undefined when the flag is
 * absent or the last word — which a plain index read hides behind a `string`.
 */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at === -1 || at + 1 >= args.length) return undefined;
  return args[at + 1];
}

class FakeHerdrWorld {
  readonly worktrees: WorldWorktree[] = [];
  readonly workspaces = new Map<string, WorldWorkspace>();
  readonly tabs = new Map<string, WorldTab>();
  /** Every pane herdr still hosts; a pane outlives the agent that ran in it. */
  readonly panes = new Map<string, WorldPane>();
  /** The agents herdr currently recognizes, one per occupied pane. */
  readonly agents = new Map<string, WorldAgent>();
  private nextTab = 1;
  private nextPane = 1;

  constructor(
    private readonly checkoutPath: string,
    private readonly branch: string,
    private readonly firstWorkspaceId = "w176",
  ) {
    this.worktrees.push({ path: checkoutPath, branch });
  }

  listWorktrees(): readonly WorldWorktree[] {
    // Herdr reports the workspace a checkout is open in, and nothing once that
    // workspace is closed.
    return this.worktrees.map((worktree) => ({
      path: worktree.path,
      branch: worktree.branch,
      ...(worktree.openWorkspaceId !== undefined &&
      this.workspaces.has(worktree.openWorkspaceId)
        ? { openWorkspaceId: worktree.openWorkspaceId }
        : {}),
    }));
  }

  listAgentRecords(): readonly Omit<WorldAgent, "name">[] {
    return [...this.agents.values()].map(
      ({ name: _name, ...record }) => record,
    );
  }

  getAgentInfo(target: string): WorldAgent | undefined {
    const byPane = this.agents.get(target);
    if (byPane !== undefined) return byPane;
    return [...this.agents.values()].find((agent) => agent.name === target);
  }

  /**
   * `herdr worktree remove --workspace <id> --force`: the checkout is resolved
   * through the workspace, so a closed workspace has no checkout left to
   * remove. Herdr also waits on a live agent in that workspace.
   */
  removeHerdrWorktree(workspaceId: string): boolean {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined) return false;
    if (
      [...this.agents.values()].some(
        (agent) => agent.workspaceId === workspaceId,
      )
    ) {
      return false;
    }
    this.closeWorkspace(workspaceId);
    const worktree = this.worktrees.find(
      (entry) => entry.path === this.checkoutPath,
    );
    if (worktree === undefined) return false;
    worktree.openWorkspaceId = undefined;
    fs.rmSync(worktree.path, { recursive: true, force: true });
    return true;
  }

  closePane(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (pane === undefined) return; // Already gone: the client treats this as success.
    this.panes.delete(paneId);
    this.agents.delete(paneId);
    const tab = this.tabs.get(pane.tabId);
    if (tab === undefined) return;
    tab.paneIds = tab.paneIds.filter((id) => id !== paneId);
    if (tab.paneIds.length > 0) return;
    this.tabs.delete(tab.tabId);
    const workspace = this.workspaces.get(pane.workspaceId);
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
    this.panes.set(paneId, {
      paneId,
      tabId,
      workspaceId: options.workspaceId,
      cwd: options.cwd,
    });
    workspace.tabIds.push(tabId);
    return { tabId, paneId };
  }

  /** `herdr worktree open` / `worktree remove` / `pane close`. */
  runHerdr(args: readonly string[]): unknown {
    if (args[0] === "worktree" && args[1] === "open") {
      const requested = args[args.indexOf("--path") + 1];
      const worktree = this.worktrees.find((entry) => entry.path === requested);
      if (worktree === undefined) throw new Error("no such worktree");
      if (
        worktree.openWorkspaceId !== undefined &&
        this.workspaces.has(worktree.openWorkspaceId)
      ) {
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
      const workspaceId =
        this.workspaces.size === 0
          ? this.firstWorkspaceId
          : `w${this.workspaces.size + 1}`;
      const tabId = `${workspaceId}:t1`;
      const paneId = `${workspaceId}:p1`;
      this.workspaces.set(workspaceId, {
        workspaceId,
        tabIds: [tabId],
      });
      this.tabs.set(tabId, {
        tabId,
        workspaceId,
        cwd: worktree.path,
        paneIds: [paneId],
      });
      this.panes.set(paneId, {
        paneId,
        tabId,
        workspaceId,
        cwd: worktree.path,
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
      const workspaceId = flagValue(args, "--workspace");
      if (workspaceId === undefined || !this.removeHerdrWorktree(workspaceId)) {
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
    const pane = this.panes.get(options.paneId);
    if (pane === undefined) throw new Error("no such pane");
    this.agents.set(options.paneId, {
      name: options.name,
      state: "working",
      workspaceId: pane.workspaceId,
      tabId: pane.tabId,
      cwd: pane.cwd,
      paneId: options.paneId,
    });
  }

  /** The agent's process ended; its pane is still there until cleanup closes it. */
  agentExited(paneId: string): void {
    this.agents.delete(paneId);
  }

  setAgentState(paneId: string, state: HerdrState): void {
    const agent = this.agents.get(paneId);
    if (agent === undefined) throw new Error(`no agent in ${paneId}`);
    agent.state = state;
  }

  /** Herdr stops listing a checkout once git no longer has it. */
  forgetWorktree(worktreePath: string): void {
    const index = this.worktrees.findIndex(
      (entry) => entry.path === worktreePath,
    );
    if (index !== -1) this.worktrees.splice(index, 1);
  }

  paneIds(): readonly string[] {
    return [...this.panes.keys()];
  }

  workspaceIds(): readonly string[] {
    return [...this.workspaces.keys()];
  }

  private closeWorkspace(workspaceId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined) return;
    for (const tabId of workspace.tabIds) {
      const tab = this.tabs.get(tabId);
      if (tab === undefined) continue;
      for (const paneId of tab.paneIds) {
        this.panes.delete(paneId);
        this.agents.delete(paneId);
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
    getCurrentWorkspaceId: async () => "w176",
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
    // The cleanup plane needs a repo cwd, a clean tree, and a branch it may
    // delete; the fake checkout itself is a real directory.
    resolveMainCheckout: async () => "/repo",
    isWorktreeDirty: async () => false,
    deleteWorktreeBranch: async () => ({ kind: "deleted" as const }),
    removeGitWorktree: async (worktreePath: string) => {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      world().forgetWorktree(worktreePath);
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
    getStore: () => ({ agent: {} }),
    getCoordinatorOrNull: () => null,
    getHarnessRegistry: () => harnesses,
  };
});

/* ── Fixtures ──────────────────────────────────────────────────────────── */

const STARTED_AT = 1_700_000_000_000;

function settledSpawn(options: {
  id: string;
  taskSlug: string;
  worktree: { kind: "owned" | "picked"; path: string; branch: string };
  host: AgentHostRef;
}): AgentSpawn {
  return {
    id: options.id,
    lifecycle: {
      phase: "settled",
      startedAt: STARTED_AT,
      status: "completed",
      result: "done",
      completedAt: STARTED_AT + 1_000,
    },
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
      harness: "pi",
      promise: Promise.resolve("done"),
      abortController: new AbortController(),
      spawnCtx: { cwd: "/repo" } as never,
    },
  };
}

/* ── The scenarios ─────────────────────────────────────────────────────── */

describe("cleanup of the last agent in a worktree", () => {
  let root: string;
  let checkout: string;
  let manager: AgentManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cowboy-last-tenant-"));
    checkout = path.join(root, "cow-last-tenant-abcd1234");
    fs.mkdirSync(checkout, { recursive: true });
    fs.writeFileSync(path.join(checkout, "README.md"), "checkout\n");
    resultRoot.dir = path.join(root, "results");
    fs.mkdirSync(resultRoot.dir, { recursive: true });
    herdr.world = new FakeHerdrWorld(checkout, "cow-last-tenant-abcd1234");
    shell.store = new AgentSpawnStore();
    manager = new AgentManager(new ConcurrencyPools(), builtinTransport());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * Place one agent in the checkout through the real host, then let its process
   * end the way a settled run does: the agent is gone from herdr's registry but
   * its pane is still there until cleanup closes it.
   */
  async function placedAgent(
    label: string,
    branch: string,
  ): Promise<AgentHostRef> {
    const runtime = createHerdrRuntime({} as never);
    const ref = await runtime.host.hostAt({
      unit: "pane",
      cwd: checkout,
      label,
      name: branch,
      checkout: { path: checkout, repoCwd: "/repo", branch },
    });
    await runtime.host.start(ref, {
      name: ref.name,
      piArgs: [],
      agentMultiplexerKind: "pi",
    });
    world().setAgentState(ref.paneId, "done");
    return ref;
  }

  it("removes the checkout of a sole agent whose pane outlived its process", async () => {
    const branch = "cow-last-tenant-abcd1234";
    const ref = await placedAgent("last-tenant", branch);
    world().agentExited(ref.paneId);
    const id = "abcd1234";
    store().add(
      settledSpawn({
        id,
        taskSlug: "last-tenant",
        worktree: { kind: "owned", path: checkout, branch },
        host: ref,
      }),
    );

    const report = await manager.cleanup(id);

    expect(report.outcome).toEqual({ kind: "torn-down" });
    expect(report.worktree).toEqual({ kind: "removed", path: checkout });
    expect(report.panes).toEqual([{ kind: "closed", paneId: ref.paneId }]);
    expect(fs.existsSync(checkout)).toBe(false);
    expect(world().paneIds()).toEqual([]);
    expect(world().workspaceIds()).toEqual([]);
    expect(store().get(id)).toBeUndefined();
  });

  it("removes the shared checkout when the last agent in it is cleaned up", async () => {
    const branch = "cow-last-tenant-abcd1234";
    const ownerRef = await placedAgent("last-tenant", branch);
    const secondRef = await placedAgent("co-tenant-2", branch);
    const thirdRef = await placedAgent("co-tenant-3", branch);
    expect(world().paneIds()).toEqual([
      ownerRef.paneId,
      secondRef.paneId,
      thirdRef.paneId,
    ]);

    const ownerId = "abcd1234";
    const secondId = "efgh5678";
    const thirdId = "ijkl9012";
    store().add(
      settledSpawn({
        id: ownerId,
        taskSlug: "last-tenant",
        worktree: { kind: "owned", path: checkout, branch },
        host: ownerRef,
      }),
    );
    store().add(
      settledSpawn({
        id: secondId,
        taskSlug: "co-tenant-2",
        worktree: { kind: "picked", path: checkout, branch },
        host: secondRef,
      }),
    );
    store().add(
      settledSpawn({
        id: thirdId,
        taskSlug: "co-tenant-3",
        worktree: { kind: "picked", path: checkout, branch },
        host: thirdRef,
      }),
    );
    // Every agent has reported and its process ended; only the panes remain.
    for (const ref of [ownerRef, secondRef, thirdRef]) {
      world().agentExited(ref.paneId);
    }

    // The batch cleans the co-tenants first: each closes its own pane and drops
    // its record, and the checkout stays because the owner is still using it.
    const coTenantReports = [
      await manager.cleanup(secondId),
      await manager.cleanup(thirdId),
    ];
    expect(
      coTenantReports.map((report) => ({
        outcome: report.outcome,
        worktree: report.worktree,
      })),
    ).toEqual([
      { outcome: { kind: "torn-down" }, worktree: { kind: "none" } },
      { outcome: { kind: "torn-down" }, worktree: { kind: "none" } },
    ]);
    expect(fs.existsSync(checkout)).toBe(true);

    // The owner is the last agent in the checkout: cleaning it up leaves no
    // agent, no pane, and no worktree behind.
    const report = await manager.cleanup(ownerId);

    expect(report.outcome).toEqual({ kind: "torn-down" });
    expect(report.worktree).toEqual({ kind: "removed", path: checkout });
    expect(fs.existsSync(checkout)).toBe(false);
    expect(world().paneIds()).toEqual([]);
    expect(world().workspaceIds()).toEqual([]);
    expect(store().list()).toEqual([]);
  });
});
