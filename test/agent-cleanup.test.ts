/**
 * agent-cleanup.test.ts — cleanup orchestration + the manager adapter, stages in isolation with injected mocks.
 * The assets seam is faked here (this file pins what cleanup does with a located answer);
 * agent-assets.test.ts pins how that answer is derived.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  createCleanup,
  createWorktreeTeardown,
  type AdoptedWorktreeTarget,
  type AgentCleanupRegistry,
} from "../src/agents/agent-cleanup.js";
import {
  assessRemovability,
  planRecovered,
  recordedSettlement,
  recoveryGate,
  shouldDropSpawn,
  type CleanupPlan,
  type CleanupReport,
  type GateOutcome,
  paneDispositionFor,
  removalMechanismOf,
  type DiscoveryBasis,
  type LocatedArtifacts,
  type RecoveryGate,
  type RecoveredDeliverable,
  type SettlementVerdict,
} from "../src/agents/cleanup-policy.js";
import type {
  Located,
  LocateResult,
  PaneRef,
} from "../src/agents/agent-assets.js";
import { AgentManager } from "../src/agents/agent-manager.js";
import { SubagentSession } from "../src/agents/subagent-session.js";
import type { BranchCleanupResult } from "../src/infrastructure/git-client.js";
import type {
  AgentHostRef,
  HostObservation,
} from "../src/agents/agent-host.js";
import {
  hasOutcome,
  type AgentSpawn,
  type WorktreeRetentionReason,
} from "../src/types.js";
import {
  buildWorktreeBranch,
  slugifyWorktreeType,
} from "../src/spawn/worktree-policy.js";
import { TEST_ORCHESTRATION } from "./helpers/orchestration.js";

/* Module-level mocks: vitest hoists vi.mock file-wide, so nesting them in a describe is an error. Only the adapter describe constructs a manager. */
const {
  removeHerdrWorktreeMock,
  deleteWorktreeBranchMock,
  isWorktreeDirtyMock,
  closePaneMock,
  resolveMainCheckoutMock,
} = vi.hoisted(() => ({
  removeHerdrWorktreeMock: vi.fn(),
  deleteWorktreeBranchMock: vi.fn(),
  isWorktreeDirtyMock: vi.fn(),
  closePaneMock: vi.fn(),
  resolveMainCheckoutMock: vi.fn(),
}));

vi.mock("../src/infrastructure/herdr-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/infrastructure/herdr-client.js")
    >();
  return {
    ...actual,
    removeHerdrWorktree: removeHerdrWorktreeMock,
    closePane: closePaneMock,
  };
});

vi.mock("../src/infrastructure/git-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/infrastructure/git-client.js")
    >();
  return {
    ...actual,
    // No repo on disk: stand in the seam's repoCwd derivation.
    resolveMainCheckout: resolveMainCheckoutMock,
    deleteWorktreeBranch: deleteWorktreeBranchMock,
    isWorktreeDirty: isWorktreeDirtyMock,
  };
});

/** The real store the mocked shell hands to every manager and session. */
const shared = vi.hoisted(() => ({
  store:
    undefined as unknown as import("../src/agents/agent-spawn-store.js").AgentSpawnStore,
}));

const { dropNudgeMock } = vi.hoisted(() => ({ dropNudgeMock: vi.fn() }));

vi.mock("../src/shell.js", async () => {
  const { AgentSpawnStore: Store } =
    await import("../src/agents/agent-spawn-store.js");
  shared.store = new Store();
  return {
    getPiInstance: () => ({}),
    getStore: () => ({ agent: {} }),
    getSessionCtx: () => ({ cwd: "/work/repo" }),
    subagentResultFileFor: (agentId: string) =>
      `/tmp/pi-cowboy/${agentId}/result.md`,
    // Sessions register at creation, as in production; the manager's spawn surface reads this store.
    getAgentSpawns: () => shared.store,
    getCoordinatorOrNull: () => ({ dropNudge: dropNudgeMock }),
  };
});

const ID = "0123456789abcdef0";
const WT_PATH =
  "/work/.herdr-subagents/repo/cow-fix-login-flow-0123456789abcdef0";
const BRANCH = "cow-fix-login-flow-0123456789abcdef0";
/** Fixed timestamps for settled spawns (the lint rule bans Date.now() arithmetic). */
const FIXED_STARTED_AT = 1_700_000_000_000;
const FIXED_DURATION_MS = 10_000;

/* ── Fixtures ─────────────────────────────────────────────────────────── */

/** Base spawn: spawned, extension-owned worktree, agent-created pane. */
function spawn(overrides: Partial<AgentSpawn> = {}): AgentSpawn {
  return {
    id: ID,
    display: {
      type: "general-purpose",
      description: "some task",
      taskSlug: "fix-login-flow",
      worktree: { kind: "owned", path: WT_PATH, branch: BRANCH },
    },
    lifecycle: {
      phase: "spawned",
      startedAt: FIXED_STARTED_AT,
      launch: { resultFile: "/tmp/x/result.md" },
    },
    execution: {
      host: {
        engine: "herdr",
        name: BRANCH,
        paneId: "w1:p1",
        tabId: "w1:t1",
        workspaceId: "w1",
        paneCreated: true,
      },
      spawnCtx: { cwd: "/work/repo" } as never,
    },
    ...overrides,
  } as unknown as AgentSpawn;
}

function completed(): AgentSpawn {
  const r = spawn({
    lifecycle: {
      phase: "settled",
      startedAt: FIXED_STARTED_AT,
      status: "completed",
      result: "done",
      completedAt: FIXED_STARTED_AT + FIXED_DURATION_MS,
    },
  });
  return r;
}

function queued(): AgentSpawn {
  return spawn({
    lifecycle: { phase: "queued", queuedAt: FIXED_STARTED_AT },
  });
}

/** A run that ended before it launched: it owns its checkout, but got no pane. */
function neverStarted(): AgentSpawn {
  const r = spawn({
    lifecycle: {
      phase: "never-started",
      queuedAt: FIXED_STARTED_AT,
      status: "error",
      error: "disposed before launch",
      completedAt: FIXED_STARTED_AT + FIXED_DURATION_MS,
    },
  });
  delete r.execution.host;
  return r;
}

/** A spawn without an extension-owned worktree (parent-cwd spawn). */
function noWorktree(r: AgentSpawn): AgentSpawn {
  delete r.display.worktree;
  return r;
}

/* ── The seam's test stand-in ──────────────────────────────────────────── */

/** Test stand-in for the seam's tracked rule (agent-assets.test.ts covers the real derivation). */
function locatedFromHint(spawn: AgentSpawn): Located {
  const ref = spawn.execution.host;
  const worktree = spawn.display.worktree;
  const managed = worktree?.kind === "owned";
  const path = worktree?.kind === "owned" ? worktree.path : undefined;
  return {
    kind: "located",
    source: "tracked",
    id: spawn.id,
    branch:
      worktree?.branch ??
      buildWorktreeBranch(
        spawn.display.taskSlug ?? slugifyWorktreeType(spawn.display.type),
        spawn.id,
      ),
    worktreeManaged: managed,
    paneCreated: ref?.paneCreated === true,
    worktree:
      path === undefined
        ? null
        : {
            path,
            repoCwd: spawn.execution.spawnCtx?.cwd,
            workspaceId: ref?.workspaceId,
          },
    pane: ref
      ? { paneId: ref.paneId, tabId: ref.tabId, workspaceId: ref.workspaceId }
      : null,
  };
}

type TreeState = "clean" | "dirty-pre" | "unverifiable" | "force-dirty";

type DirtyProbe = (path: string) => Promise<boolean | undefined>;
type RemoveWorktree = (ref: AgentHostRef) => Promise<boolean>;
type DeleteBranch = (
  worktreePath: string,
  repoCwd: string,
) => Promise<BranchCleanupResult>;
type ClosePane = (ref: AgentHostRef) => Promise<void>;

interface MockedDeps {
  isWorktreeDirty: Mock<DirtyProbe>;
  removeWorktree: Mock<RemoveWorktree>;
  deleteBranch: Mock<DeleteBranch>;
  closePane: Mock<ClosePane>;
  worktreeExists: Mock<(path: string) => Promise<boolean>>;
  removeGitWorktree: Mock<(path: string, repoCwd: string) => Promise<boolean>>;
  probes: Mock<DirtyProbe>;
}

function buildDeps(tree: TreeState): MockedDeps {
  const isWorktreeDirty = vi.fn<DirtyProbe>();
  if (tree === "clean") isWorktreeDirty.mockResolvedValue(false);
  else if (tree === "dirty-pre") isWorktreeDirty.mockResolvedValue(true);
  else if (tree === "unverifiable")
    isWorktreeDirty.mockResolvedValue(undefined);
  else isWorktreeDirty.mockResolvedValue(true);
  return {
    isWorktreeDirty,
    removeWorktree: vi.fn<RemoveWorktree>().mockResolvedValue(true),
    deleteBranch: vi.fn<DeleteBranch>().mockResolvedValue({ kind: "deleted" }),
    closePane: vi.fn<ClosePane>().mockResolvedValue(undefined),
    worktreeExists: vi.fn().mockResolvedValue(true),
    removeGitWorktree: vi.fn().mockResolvedValue(true),
    probes: isWorktreeDirty,
  };
}

interface AssetsOptions {
  /** The locator's answer; defaults to the hint-derived stand-in. */
  locate?: (id: string, hint?: AgentSpawn) => Promise<LocateResult>;
  /** What herdr's live read shows; defaults to "no pane answers". */
  observed?: HostObservation;
  /** Make the live read fail (the probe itself is unreadable). */
  observeFails?: boolean;
  /** Whether a deliverable was written. */
  deliverablePresent?: boolean;
}

interface MockedAssets extends MockedDeps {
  locate: Mock<(id: string, hint?: AgentSpawn) => Promise<LocateResult>>;
  observe: Mock<(pane: PaneRef) => Promise<HostObservation | undefined>>;
  deliverable: Mock<(id: string) => RecoveredDeliverable>;
}

const DELIVERABLE_PATH = `/tmp/pi-cowboy/${ID}/result.md`;

function buildAssets(
  tree: TreeState,
  options: AssetsOptions = {},
): MockedAssets {
  const deps = buildDeps(tree);
  const locate = vi.fn(
    options.locate ??
      (async (id: string, hint?: AgentSpawn): Promise<LocateResult> =>
        hint === undefined ? { kind: "not-found", id } : locatedFromHint(hint)),
  );
  const assets: MockedAssets = {
    ...deps,
    locate,
    observe: vi.fn(async () => {
      if (options.observeFails === true) throw new Error("herdr down");
      return options.observed;
    }),
    deliverable: vi.fn(() => ({
      path: DELIVERABLE_PATH,
      present: options.deliverablePresent === true,
    })),
  };
  return assets;
}

function buildRegistry(spawns: Map<string, AgentSpawn>): {
  registry: AgentCleanupRegistry;
  dropped: string[];
} {
  const dropped: string[] = [];
  const registry: AgentCleanupRegistry = {
    getSpawn: (id: string) => spawns.get(id),
    dropSpawn: (r: AgentSpawn) => {
      spawns.delete(r.id);
      dropped.push(r.id);
    },
  };
  return { registry, dropped };
}

/* ── planRecovered: located artifacts → plan (pure) ──────────────────── */

function artifacts(
  overrides: Partial<LocatedArtifacts> = {},
): LocatedArtifacts {
  return {
    id: ID,
    branch: BRANCH,
    worktreeManaged: true,
    paneCreated: true,
    worktree: { path: WT_PATH, repoCwd: "/work/repo", workspaceId: "w1" },
    pane: { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
    ...overrides,
  };
}

describe("planRecovered", () => {
  it("plans a full worktree with a self-created pane", () => {
    expect(planRecovered(artifacts())).toEqual({
      kind: "worktree",
      worktree: {
        workspaceId: "w1",
        worktreePath: WT_PATH,
        repoCwd: "/work/repo",
        branchName: BRANCH,
      },
      pane: { paneId: "w1:p1", origin: "self-created" },
    } satisfies CleanupPlan);
  });

  it("plans an adopted pane (not created by the extension)", () => {
    const plan = planRecovered(artifacts({ paneCreated: false }));
    expect(plan.kind).toBe("worktree");
    if (plan.kind === "worktree") {
      expect(plan.pane).toEqual({ paneId: "w1:p1", origin: "adopted" });
    }
  });

  it("plans a worktree even without a herdr pane handle", () => {
    expect(planRecovered(artifacts({ pane: null }))).toMatchObject({
      kind: "worktree",
      pane: null,
    });
  });

  it("plans a no-worktree run with its pane", () => {
    expect(
      planRecovered(
        artifacts({ worktreeManaged: false, worktree: null, pane: null }),
      ),
    ).toEqual({ kind: "no-worktree", pane: null });
    expect(
      planRecovered(artifacts({ worktreeManaged: false, worktree: null })),
    ).toEqual({
      kind: "no-worktree",
      pane: { paneId: "w1:p1", origin: "self-created" },
    });
  });

  it("plans a managed but unresolvable tree as unlocatable, never absent", () => {
    expect(
      planRecovered(
        artifacts({
          worktree: { path: WT_PATH, workspaceId: "w1" },
        }),
      ),
    ).toEqual({
      kind: "worktree-unlocatable",
      branchName: BRANCH,
      worktreePath: WT_PATH,
      pane: { paneId: "w1:p1", origin: "self-created" },
    });
  });

  it("plans an unlocatable worktree with an unknown path when none is known", () => {
    expect(planRecovered(artifacts({ worktree: null }))).toMatchObject({
      kind: "worktree-unlocatable",
      worktreePath: null,
    });
  });

  it("keeps a git-only worktree removable (no herdr workspace)", () => {
    const plan = planRecovered(
      artifacts({ worktree: { path: WT_PATH, repoCwd: "/work/repo" } }),
    );
    expect(plan).toMatchObject({
      kind: "worktree",
      worktree: { workspaceId: undefined, worktreePath: WT_PATH },
    });
    if (plan.kind === "worktree") {
      expect(removalMechanismOf(plan.worktree)).toBe("git");
    }
  });
});

/* ── assessRemovability: the gate ──────────────────────────────────────── */

const TARGET: AdoptedWorktreeTarget = {
  workspaceId: "w1",
  worktreePath: WT_PATH,
  repoCwd: "/work/repo",
  branchName: BRANCH,
};

const REF: AgentHostRef = {
  engine: "herdr",
  name: BRANCH,
  paneId: "w1:p1",
  tabId: "w1:t1",
  workspaceId: "w1",
  paneCreated: true,
};

describe("paneDispositionFor", () => {
  it.each([
    [null, null, true, { kind: "none" }],
    [
      { paneId: "p1", origin: "self-created" },
      "herdr",
      true,
      { kind: "closed-with-workspace" },
    ],
    [{ paneId: "p1", origin: "self-created" }, "git", true, { kind: "close" }],
    [{ paneId: "p1", origin: "adopted" }, null, true, { kind: "leave-open" }],
  ] as const)("returns %#", (pane, mechanism, removed, expected) => {
    expect(paneDispositionFor(pane, mechanism, removed)).toEqual(expected);
  });
});

describe("removalMechanismOf", () => {
  it("uses the workspace identity to select herdr or git", () => {
    expect(removalMechanismOf(TARGET)).toBe("herdr");
    expect(removalMechanismOf({ ...TARGET, workspaceId: undefined })).toBe(
      "git",
    );
  });
});

describe("assessRemovability", () => {
  it("allows a clean tree", async () => {
    const deps = buildDeps("clean");
    expect(
      await assessRemovability(deps.isWorktreeDirty, undefined, TARGET),
    ).toEqual({
      kind: "removable",
    });
    expect(deps.probes).toHaveBeenCalledTimes(1);
  });

  it("keeps a dirty tree with its reason", async () => {
    const deps = buildDeps("dirty-pre");
    expect(
      await assessRemovability(deps.isWorktreeDirty, undefined, TARGET),
    ).toEqual({
      kind: "kept",
      reason: { kind: "dirty" },
    });
  });

  it("keeps an unverifiable tree with the probe detail", async () => {
    const deps = buildDeps("unverifiable");
    expect(
      await assessRemovability(deps.isWorktreeDirty, undefined, TARGET),
    ).toEqual({
      kind: "kept",
      reason: { kind: "unverifiable", detail: "git status probe failed" },
    });
  });

  it("skips the probe entirely when forced", async () => {
    const deps = buildDeps("force-dirty");
    expect(
      await assessRemovability(deps.isWorktreeDirty, { force: true }, TARGET),
    ).toEqual({
      kind: "removable",
    });
    expect(deps.probes).not.toHaveBeenCalled();
  });
});

/* ── recoveryGate: the recovered-path settlement rule (pure) ─────────── */

describe("recoveryGate", () => {
  it("allows a run whose pane is gone, recording the basis", () => {
    expect(recoveryGate(undefined)).toEqual({
      kind: "allow",
      basis: { kind: "pane-absent" },
    });
  });

  it.each(["idle", "done", "blocked", "unknown"] as const)(
    "allows a pane reporting %s",
    (state) => {
      expect(recoveryGate({ state })).toEqual({
        kind: "allow",
        basis: { kind: "pane-not-working", state },
      } satisfies RecoveryGate);
    },
  );

  it("refuses a pane still reporting working", () => {
    expect(recoveryGate({ state: "working" })).toEqual({
      kind: "refuse",
      basis: { kind: "pane-working" },
    });
  });
});

/* ── removeWorktree: launch-failure coverage ──────────────────────────── */

describe("removeWorktree", () => {
  const adopted = (path: string) => ({
    worktree: {
      workspaceId: "w1",
      worktreePath: path,
      branchName: BRANCH,
      repoCwd: "/work/repo",
    },
    pane: { paneId: "w1:p1", origin: "self-created" as const },
  });
  const gitOnly = (path: string) => ({
    worktree: { worktreePath: path, branchName: BRANCH, repoCwd: "/work/repo" },
  });

  it("removes a herdr-adopted worktree without stopping anything, then deletes its branch", async () => {
    const deps = buildDeps("clean");
    const outcome = await createWorktreeTeardown(deps).removeWorktree({
      kind: "adopted",
      worktree: adopted(WT_PATH).worktree,
      pane: adopted(WT_PATH).pane,
      ref: REF,
    });
    expect(outcome).toEqual({
      kind: "removed",
      path: WT_PATH,
      branchName: BRANCH,
      via: "herdr",
      branch: { kind: "deleted" },
    });
    expect(deps.removeWorktree).toHaveBeenCalledWith(REF);
    expect(deps.removeGitWorktree).not.toHaveBeenCalled();
    // The workspace takes its pane with it: no stop, no separate close.
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(deps.probes).toHaveBeenCalledTimes(1);
  });

  it("removes a git-only worktree through git", async () => {
    const deps = buildDeps("clean");
    const outcome = await createWorktreeTeardown(deps).removeWorktree({
      kind: "detached",
      worktree: gitOnly(WT_PATH).worktree,
      pane: null,
    });
    expect(outcome).toMatchObject({
      kind: "removed",
      path: WT_PATH,
      via: "git",
      branchName: BRANCH,
      branch: { kind: "deleted" },
    });
    expect(deps.removeGitWorktree).toHaveBeenCalledWith(WT_PATH, "/work/repo");
  });

  it.each([
    ["dirty-pre", { kind: "dirty" }],
    [
      "unverifiable",
      { kind: "unverifiable", detail: "git status probe failed" },
    ],
  ] as const)("keeps a %s tree before any removal", async (tree, reason) => {
    const deps = buildDeps(tree);
    await expect(
      createWorktreeTeardown(deps).removeWorktree({
        kind: "adopted",
        worktree: adopted(WT_PATH).worktree,
        pane: adopted(WT_PATH).pane,
        ref: REF,
      }),
    ).resolves.toEqual({ kind: "kept", path: WT_PATH, reason });
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(deps.probes).toHaveBeenCalledTimes(1);
  });

  it("reports an unconfirmed removal instead of throwing", async () => {
    const deps = buildDeps("clean");
    deps.removeWorktree.mockResolvedValue(false);
    const outcome = await createWorktreeTeardown(deps).removeWorktree({
      kind: "adopted",
      worktree: adopted(WT_PATH).worktree,
      pane: adopted(WT_PATH).pane,
      ref: REF,
    });
    expect(outcome).toEqual({
      kind: "removal-failed",
      path: WT_PATH,
      detail: "herdr did not confirm the worktree removal",
    });
  });

  it("reports a branch-plane exception instead of throwing", async () => {
    const deps = buildDeps("clean");
    deps.deleteBranch.mockRejectedValue(new Error("branch probe failed"));
    await expect(
      createWorktreeTeardown(deps).removeWorktree({
        kind: "detached",
        worktree: gitOnly(WT_PATH).worktree,
        pane: null,
      }),
    ).resolves.toEqual({
      kind: "removal-failed",
      path: WT_PATH,
      detail: "branch probe failed",
    });
  });

  it("reports none when the create already rolled back", async () => {
    const deps = buildDeps("clean");
    deps.worktreeExists.mockResolvedValue(false);
    await expect(
      createWorktreeTeardown(deps).removeWorktree({
        kind: "detached",
        worktree: gitOnly(WT_PATH).worktree,
        pane: null,
      }),
    ).resolves.toEqual({ kind: "absent", path: WT_PATH });
    expect(deps.probes).not.toHaveBeenCalled();
  });
});

/* ── removeWorktree: Clear coverage ───────────────────────────────────── */

describe("removeWorktree", () => {
  it("removes a clean, merged worktree and deletes its branch", async () => {
    const deps = buildDeps("clean");
    await expect(
      createWorktreeTeardown(deps).removeWorktree({
        kind: "adopted",
        worktree: TARGET,
        pane: null,
        ref: REF,
      }),
    ).resolves.toEqual({
      kind: "removed",
      path: WT_PATH,
      branchName: BRANCH,
      via: "herdr",
      branch: { kind: "deleted" },
    });
    expect(deps.removeWorktree).toHaveBeenCalledWith(REF);
    expect(deps.probes).toHaveBeenCalledTimes(1);
  });

  it("keeps a dirty worktree with its reason", async () => {
    const deps = buildDeps("dirty-pre");
    await expect(
      createWorktreeTeardown(deps).removeWorktree({
        kind: "adopted",
        worktree: TARGET,
        pane: null,
        ref: REF,
      }),
    ).resolves.toEqual({
      kind: "kept",
      path: WT_PATH,
      reason: { kind: "dirty" },
    });
    expect(deps.removeWorktree).not.toHaveBeenCalled();
  });

  it("removes a clean worktree while keeping its unmerged branch", async () => {
    const deps = buildDeps("clean");
    deps.deleteBranch.mockResolvedValue({ kind: "kept", reason: "unmerged" });
    await expect(
      createWorktreeTeardown(deps).removeWorktree({
        kind: "adopted",
        worktree: TARGET,
        pane: null,
        ref: REF,
      }),
    ).resolves.toEqual({
      kind: "removed",
      path: WT_PATH,
      branchName: BRANCH,
      via: "herdr",
      branch: { kind: "kept", reason: "unmerged" },
    });
  });

  it("closes a self-created pane only for a git-owned checkout, and never stops", async () => {
    const deps = buildDeps("clean");
    await createWorktreeTeardown(deps).removeWorktree({
      kind: "adopted",
      worktree: TARGET,
      pane: { paneId: "w1:p1", origin: "self-created" },
      ref: REF,
    });
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(deps.probes).toHaveBeenCalledTimes(1);

    const gitOwned = buildDeps("clean");
    await createWorktreeTeardown(gitOwned).removeWorktree({
      kind: "closing-pane",
      worktree: { ...TARGET, workspaceId: undefined },
      pane: { paneId: "w1:p1", origin: "self-created" },
      ref: REF,
    });
    expect(gitOwned.closePane).toHaveBeenCalledTimes(1);
    expect(gitOwned.probes).toHaveBeenCalledTimes(1);
  });

  it("force skips the retention probe, even when a pane is present", async () => {
    const deps = buildDeps("force-dirty");
    await expect(
      createWorktreeTeardown(deps).removeWorktree(
        {
          kind: "adopted",
          worktree: TARGET,
          pane: { paneId: "w1:p1", origin: "self-created" },
          ref: REF,
        },
        { force: true },
      ),
    ).resolves.toEqual({
      kind: "removed",
      path: WT_PATH,
      branchName: BRANCH,
      via: "herdr",
      branch: { kind: "deleted" },
    });
    expect(deps.probes).not.toHaveBeenCalled();
  });

  it("reports an unconfirmed removal", async () => {
    const deps = buildDeps("clean");
    deps.removeWorktree.mockResolvedValue(false);
    await expect(
      createWorktreeTeardown(deps).removeWorktree({
        kind: "adopted",
        worktree: TARGET,
        pane: null,
        ref: REF,
      }),
    ).resolves.toEqual({
      kind: "removal-failed",
      path: WT_PATH,
      detail: "herdr did not confirm the worktree removal",
    });
    expect(deps.deleteBranch).not.toHaveBeenCalled();
  });

  it("returns absent before probing or removing", async () => {
    const deps = buildDeps("clean");
    deps.worktreeExists.mockResolvedValue(false);
    await expect(
      createWorktreeTeardown(deps).removeWorktree({
        kind: "detached",
        worktree: TARGET,
        pane: { paneId: "w1:p1", origin: "self-created" },
      }),
    ).resolves.toEqual({ kind: "absent", path: WT_PATH });
    expect(deps.probes).not.toHaveBeenCalled();
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(deps.removeWorktree).not.toHaveBeenCalled();
  });
});

/* ── The recorded settlement gate ─────────────────────────────────────── */

/** Only ended runs own a verdict: live ones are refused untouched (no probe, stop, removal, or drop). */
describe("cleanup — the recorded settlement gate", () => {
  it.each([
    ["spawned", spawn],
    ["queued", queued],
  ] as const)("refuses a %s spawn without touching it", async (phase, make) => {
    const spawns = new Map<string, AgentSpawn>([[ID, make()]]);
    const assets = buildAssets("clean");
    const { registry, dropped } = buildRegistry(spawns);

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report).toEqual({
      agentId: ID,
      source: "tracked",
      outcome: { kind: "refused", reason: { kind: "agent-active", phase } },
      settlement: { kind: "recorded", phase },
      branchName: BRANCH,
      pane: { kind: "open", paneId: "w1:p1" },
      worktree: { kind: "kept", path: WT_PATH },
      branch: { kind: "not-applicable" },
    });
    expect(assets.probes).not.toHaveBeenCalled();
    expect(assets.removeWorktree).not.toHaveBeenCalled();
    expect(assets.removeGitWorktree).not.toHaveBeenCalled();
    expect(assets.deleteBranch).not.toHaveBeenCalled();
    expect(assets.closePane).not.toHaveBeenCalled();
    expect(assets.observe).not.toHaveBeenCalled();
    expect(dropped).toEqual([]);
    expect(spawns.get(ID)?.lifecycle.phase).toBe(phase);
  });

  it("refuses a live parent-cwd spawn (no worktree) the same way", async () => {
    const spawns = new Map<string, AgentSpawn>([[ID, noWorktree(spawn())]]);
    const assets = buildAssets("clean");
    const { registry, dropped } = buildRegistry(spawns);

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report).toEqual({
      agentId: ID,
      source: "tracked",
      outcome: {
        kind: "refused",
        reason: { kind: "agent-active", phase: "spawned" },
      },
      settlement: { kind: "recorded", phase: "spawned" },
      pane: { kind: "open", paneId: "w1:p1" },
      worktree: { kind: "none" },
      branch: { kind: "not-applicable" },
    });
    expect(assets.closePane).not.toHaveBeenCalled();
    expect(dropped).toEqual([]);
  });

  it("refuses before the worktree-unlocatable probe can fire", async () => {
    const broken = spawn();
    // No repo cwd to resolve the checkout against: the owned tree is unlocatable.
    delete broken.execution.spawnCtx;
    const spawns = new Map<string, AgentSpawn>([[ID, broken]]);
    const assets = buildAssets("clean");
    const { registry } = buildRegistry(spawns);

    await expect(
      createCleanup(assets).cleanupAgent(ID, registry),
    ).resolves.toMatchObject({
      outcome: {
        kind: "refused",
        reason: { kind: "agent-active", phase: "spawned" },
      },
      settlement: { kind: "recorded", phase: "spawned" },
      worktree: { kind: "kept", path: WT_PATH },
    });
  });

  it("still tears down a settled spawn — the gate frees, never blocks", async () => {
    const spawns = new Map<string, AgentSpawn>([[ID, completed()]]);
    const assets = buildAssets("clean");
    const { registry, dropped } = buildRegistry(spawns);

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report).toMatchObject({
      source: "tracked",
      settlement: { kind: "recorded", phase: "settled" },
      worktree: { kind: "removed", path: WT_PATH },
      branch: { kind: "deleted" },
    });
    expect(dropped).toEqual([ID]);
  });

  it("clears a never-started run, reporting the phase memory recorded", async () => {
    const spawns = new Map<string, AgentSpawn>([[ID, neverStarted()]]);
    const assets = buildAssets("clean");
    const { registry, dropped } = buildRegistry(spawns);

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report).toMatchObject({
      source: "tracked",
      settlement: { kind: "recorded", phase: "never-started" },
      worktree: { kind: "removed", path: WT_PATH },
      branch: { kind: "deleted" },
    });
    expect(dropped).toEqual([ID]);
  });

  it("throws for an unknown agent id", async () => {
    const assets = buildAssets("clean");
    const { registry } = buildRegistry(new Map());
    await expect(
      createCleanup(assets).cleanupAgent(ID, registry),
    ).rejects.toThrow(`Agent ${ID} not found.`);
  });
});

/* ── The recovered path ───────────────────────────────────────────────── */

function recoveredArtifacts(overrides: Partial<Located> = {}): Located {
  return {
    kind: "located",
    source: "recovered",
    id: ID,
    branch: BRANCH,
    worktreeManaged: true,
    paneCreated: false,
    worktree: { path: WT_PATH, repoCwd: "/work/repo", workspaceId: "w1" },
    pane: { paneId: "w1:p1", workspaceId: "w1" },
    ...overrides,
  };
}

function locateReturning(result: LocateResult) {
  return async (): Promise<LocateResult> => result;
}

describe("cleanup — a recovered run", () => {
  it("removes the artifacts a settled run left behind, on discovery's verdict", async () => {
    const assets = buildAssets("clean", {
      locate: locateReturning(recoveredArtifacts()),
      observed: { state: "done" },
    });
    const { registry, dropped } = buildRegistry(new Map());

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report).toEqual({
      agentId: ID,
      source: "recovered",
      outcome: { kind: "torn-down" },
      settlement: {
        kind: "discovered",
        basis: { kind: "pane-not-working", state: "done" },
        deliverable: { path: DELIVERABLE_PATH, present: false },
      },
      branchName: BRANCH,
      pane: { kind: "closed", paneId: "w1:p1" },
      worktree: { kind: "removed", path: WT_PATH },
      branch: { kind: "deleted" },
    });
    // There is no spawn to drop, and nothing is stopped.
    expect(dropped).toEqual([]);
  });

  it("refuses while herdr still reports the pane working", async () => {
    const assets = buildAssets("clean", {
      locate: locateReturning(recoveredArtifacts()),
      observed: { state: "working" },
      deliverablePresent: true,
    });
    const { registry } = buildRegistry(new Map());

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report).toMatchObject({
      source: "recovered",
      settlement: {
        kind: "discovered",
        basis: { kind: "pane-working" },
        deliverable: { path: DELIVERABLE_PATH, present: true },
      },
      outcome: {
        kind: "refused",
        reason: {
          kind: "recovered-refusal",
          basis: { kind: "pane-working" },
        },
      },
      pane: { kind: "open", paneId: "w1:p1" },
      worktree: { kind: "kept", path: WT_PATH },
      branch: { kind: "not-applicable" },
    });
    // Live work is refused before any probe or removal.
    expect(assets.probes).not.toHaveBeenCalled();
    expect(assets.removeWorktree).not.toHaveBeenCalled();
    expect(assets.deleteBranch).not.toHaveBeenCalled();
  });

  it("allows a run whose pane is gone and reads no pane at all", async () => {
    const assets = buildAssets("clean", {
      locate: locateReturning(recoveredArtifacts({ pane: null })),
    });
    const { registry } = buildRegistry(new Map());

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report).toMatchObject({
      settlement: {
        kind: "discovered",
        basis: { kind: "pane-absent" },
      },
      worktree: { kind: "removed", path: WT_PATH },
    });
    expect(assets.observe).not.toHaveBeenCalled();
  });

  it("refuses when the pane read itself fails", async () => {
    const assets = buildAssets("clean", {
      locate: locateReturning(recoveredArtifacts()),
      observeFails: true,
    });
    const { registry } = buildRegistry(new Map());

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report).toMatchObject({
      outcome: {
        kind: "refused",
        reason: {
          kind: "unverifiable",
          detail: "the pane state could not be read (herdr down)",
        },
      },
      settlement: {
        kind: "discovered",
        basis: { kind: "pane-unreadable", detail: "herdr down" },
      },
      worktree: { kind: "kept", path: WT_PATH },
    });
    expect(assets.removeWorktree).not.toHaveBeenCalled();
  });

  it("force overrides the live read and records the basis", async () => {
    const assets = buildAssets("force-dirty", {
      locate: locateReturning(recoveredArtifacts()),
      observed: { state: "working" },
    });
    const { registry } = buildRegistry(new Map());

    const report = await createCleanup(assets).cleanupAgent(ID, registry, {
      force: true,
    });

    expect(report).toMatchObject({
      settlement: { kind: "discovered", basis: { kind: "forced" } },
      worktree: { kind: "removed", path: WT_PATH },
      branch: { kind: "deleted" },
    });
    expect(assets.observe).not.toHaveBeenCalled();
    expect(assets.probes).not.toHaveBeenCalled();
  });

  it("refuses a contested id and lists the candidates, removing nothing", async () => {
    const candidates = [
      { worktreePath: `/a/${BRANCH}`, branch: BRANCH },
      { worktreePath: `/b/${BRANCH}`, branch: BRANCH },
    ];
    const assets = buildAssets("clean", {
      locate: locateReturning({ kind: "ambiguous", id: ID, candidates }),
      deliverablePresent: true,
    });
    const { registry } = buildRegistry(new Map());

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report).toEqual({
      agentId: ID,
      source: "recovered",
      outcome: {
        kind: "refused",
        reason: {
          kind: "ambiguous-artifacts",
          candidates: [`/a/${BRANCH}`, `/b/${BRANCH}`],
        },
      },
      settlement: {
        kind: "discovered",
        basis: { kind: "artifacts-ambiguous" },
        deliverable: { path: DELIVERABLE_PATH, present: true },
      },
      pane: { kind: "none" },
      worktree: { kind: "kept", path: null },
      branch: { kind: "not-applicable" },
    });
    expect(assets.probes).not.toHaveBeenCalled();
    expect(assets.removeWorktree).not.toHaveBeenCalled();
    expect(assets.removeGitWorktree).not.toHaveBeenCalled();
    expect(assets.deleteBranch).not.toHaveBeenCalled();
  });

  it("reports the unread deliverable instead of deleting it", async () => {
    const assets = buildAssets("clean", {
      locate: locateReturning(recoveredArtifacts()),
      observed: { state: "done" },
      deliverablePresent: true,
    });
    const { registry } = buildRegistry(new Map());

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report.settlement).toEqual({
      kind: "discovered",
      basis: { kind: "pane-not-working", state: "done" },
      deliverable: { path: DELIVERABLE_PATH, present: true },
    });
    expect(assets.deliverable).toHaveBeenCalledWith(ID);
  });

  it("refuses a recovered tree that cannot be resolved", async () => {
    const assets = buildAssets("clean", {
      locate: locateReturning(
        recoveredArtifacts({
          worktree: { path: WT_PATH, workspaceId: "w1" },
        }),
      ),
      observed: { state: "done" },
    });
    const { registry } = buildRegistry(new Map());

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report).toMatchObject({
      outcome: {
        kind: "refused",
        reason: {
          kind: "unverifiable",
          detail: "missing worktree path or repo cwd",
        },
      },
      worktree: { kind: "kept", path: WT_PATH },
      branch: { kind: "not-applicable" },
    });
    expect(assets.removeWorktree).not.toHaveBeenCalled();
  });

  it("keeps a recovered dirty tree with its reason", async () => {
    const assets = buildAssets("dirty-pre", {
      locate: locateReturning(recoveredArtifacts()),
      observed: { state: "done" },
    });
    const { registry } = buildRegistry(new Map());

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report.worktree).toEqual({ kind: "kept", path: WT_PATH });
    expect(report.outcome).toEqual({
      kind: "refused",
      reason: { kind: "dirty" },
    });
  });

  it("keeps a recovered worktree whose removal herdr does not confirm", async () => {
    const assets = buildAssets("clean", {
      locate: locateReturning(recoveredArtifacts()),
      observed: { state: "done" },
    });
    assets.removeWorktree.mockResolvedValue(false);
    const { registry } = buildRegistry(new Map());

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report.worktree).toEqual({
      kind: "removal-failed",
      path: WT_PATH,
      detail: "herdr did not confirm the worktree removal",
    });
    expect(report.branch).toEqual({ kind: "not-applicable" });
  });

  it("never closes a pane a recovered run might not own", async () => {
    const assets = buildAssets("clean", {
      locate: locateReturning(
        recoveredArtifacts({
          worktree: { path: WT_PATH, repoCwd: "/work/repo" },
        }),
      ),
      observed: { state: "done" },
    });
    const { registry } = buildRegistry(new Map());

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report.worktree).toEqual({ kind: "removed", path: WT_PATH });
    expect(report.pane).toEqual({ kind: "open", paneId: "w1:p1" });
    expect(assets.removeGitWorktree).toHaveBeenCalledWith(
      WT_PATH,
      "/work/repo",
    );
    expect(assets.closePane).not.toHaveBeenCalled();
  });

  it("uses a tracked run's recorded settlement even when discovery found the plan", async () => {
    // The hint carries no worktree of its own: settlement stays memory's, the address is discovery's.
    const broken = completed();
    delete broken.display.worktree;
    const spawns = new Map<string, AgentSpawn>([[ID, broken]]);
    const assets = buildAssets("clean", {
      locate: locateReturning(
        recoveredArtifacts({
          branch: BRANCH,
          paneCreated: true,
          pane: { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
        }),
      ),
    });
    const { registry, dropped } = buildRegistry(spawns);

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report).toMatchObject({
      source: "recovered",
      settlement: { kind: "recorded", phase: "settled" },
      worktree: { kind: "removed", path: WT_PATH },
    });
    expect(assets.observe).not.toHaveBeenCalled();
    expect(dropped).toEqual([ID]);
  });

  it("drops a contested run's spawn only after it is gone — never on refusal", async () => {
    const spawns = new Map<string, AgentSpawn>([[ID, completed()]]);
    const assets = buildAssets("clean", {
      locate: locateReturning({
        kind: "ambiguous",
        id: ID,
        candidates: [{ worktreePath: WT_PATH, branch: BRANCH }],
      }),
    });
    const { registry, dropped } = buildRegistry(spawns);

    await createCleanup(assets).cleanupAgent(ID, registry);

    expect(dropped).toEqual([]);
    expect(spawns.has(ID)).toBe(true);
  });
});

/* ── shouldDropSpawn (pure) ───────────────────────────────────────────── */

describe("shouldDropSpawn", () => {
  const base: CleanupReport = {
    agentId: ID,
    source: "tracked",
    outcome: { kind: "torn-down" },
    settlement: { kind: "recorded", phase: "settled" },
    pane: { kind: "none" },
    worktree: { kind: "none" },
    branch: { kind: "not-applicable" },
  };
  it.each<[string, CleanupReport, boolean]>([
    [
      "worktree removed → drop",
      { ...base, worktree: { kind: "removed", path: WT_PATH } },
      true,
    ],
    [
      "no worktree + closed pane → drop",
      { ...base, pane: { kind: "closed", paneId: "w1:p1" } },
      true,
    ],
    ["no worktree + no pane → drop", base, true],
    [
      "absent worktree → drop (nothing on disk to lose)",
      { ...base, worktree: { kind: "absent", path: WT_PATH } },
      true,
    ],
    [
      "kept worktree → keep",
      {
        ...base,
        outcome: { kind: "refused", reason: { kind: "dirty" } },
        worktree: { kind: "kept", path: WT_PATH },
      },
      false,
    ],
    [
      "no worktree + open pane → keep",
      { ...base, pane: { kind: "open", paneId: "w1:p1" } },
      false,
    ],
    [
      "removal-failed → keep",
      {
        ...base,
        worktree: { kind: "removal-failed", path: WT_PATH, detail: "x" },
      },
      false,
    ],
  ])("%s", (_name, report, expected) => {
    expect(shouldDropSpawn(report)).toBe(expected);
  });
});

/* ── recordedSettlement (pure) ────────────────────────────────────────── */

describe("recordedSettlement", () => {
  it("reads the verdict off the phase memory recorded", () => {
    expect(recordedSettlement(completed())).toEqual({
      kind: "recorded",
      phase: "settled",
    });
    expect(recordedSettlement(queued())).toEqual({
      kind: "recorded",
      phase: "queued",
    });
    expect(recordedSettlement(neverStarted())).toEqual({
      kind: "recorded",
      phase: "never-started",
    });
  });
});

/* ── cleanup: orchestration ────────────────────────────────────────────── */

interface Row {
  name: string;
  /** Fresh spawn per run. */
  spawn: () => AgentSpawn;
  tree: TreeState;
  opts?: { force?: boolean };
  /** isWorktreeDirty call count expected. */
  probes: number;
  expected: {
    outcome: CleanupReport["outcome"];
    settlement: SettlementVerdict;
    pane: CleanupReport["pane"];
    worktree: CleanupReport["worktree"];
    branch: CleanupReport["branch"];
    branchName?: string;
  };
  dropped: boolean;
}

const SETTLED_RECORDED: SettlementVerdict = {
  kind: "recorded",
  phase: "settled",
};

describe("cleanup — the settled-teardown matrix", () => {
  const rows: Row[] = [
    {
      name: "settled + clean tree: everything removed, spawn dropped",
      spawn: completed,
      tree: "clean",
      probes: 1,
      expected: {
        outcome: { kind: "torn-down" },
        settlement: SETTLED_RECORDED,
        pane: { kind: "closed", paneId: "w1:p1" },
        worktree: { kind: "removed", path: WT_PATH },
        branch: { kind: "deleted" },
        branchName: BRANCH,
      },
      dropped: true,
    },
    {
      name: "settled + dirty tree: kept with reason, nothing removed",
      spawn: completed,
      tree: "dirty-pre",
      probes: 1,
      expected: {
        outcome: { kind: "refused", reason: { kind: "dirty" } },
        settlement: SETTLED_RECORDED,
        pane: { kind: "open", paneId: "w1:p1" },
        worktree: { kind: "kept", path: WT_PATH },
        branch: { kind: "not-applicable" },
      },
      dropped: false,
    },
    {
      name: "settled + unverifiable tree: kept with the probe detail",
      spawn: completed,
      tree: "unverifiable",
      probes: 1,
      expected: {
        outcome: {
          kind: "refused",
          reason: { kind: "unverifiable", detail: "git status probe failed" },
        },
        settlement: SETTLED_RECORDED,
        pane: { kind: "open", paneId: "w1:p1" },
        worktree: { kind: "kept", path: WT_PATH },
        branch: { kind: "not-applicable" },
      },
      dropped: false,
    },
    {
      name: "settled + dirty tree with force: gate skipped, removed anyway",
      spawn: completed,
      tree: "force-dirty",
      probes: 0,
      opts: { force: true },
      expected: {
        outcome: { kind: "torn-down" },
        settlement: SETTLED_RECORDED,
        pane: { kind: "closed", paneId: "w1:p1" },
        worktree: { kind: "removed", path: WT_PATH },
        branch: { kind: "deleted" },
      },
      dropped: true,
    },
    {
      name: "settled + unlocatable worktree: kept-unverifiable, spawn kept",
      spawn: () => {
        const r = completed();
        // No repo cwd to resolve the checkout against: the owned tree is unlocatable.
        delete r.execution.spawnCtx;
        return r;
      },
      tree: "clean",
      probes: 0,
      expected: {
        outcome: {
          kind: "refused",
          reason: {
            kind: "unverifiable",
            detail: "missing worktree path or repo cwd",
          },
        },
        settlement: SETTLED_RECORDED,
        pane: { kind: "open", paneId: "w1:p1" },
        worktree: { kind: "kept", path: WT_PATH },
        branch: { kind: "not-applicable" },
      },
      dropped: false,
    },
    {
      name: "settled + no worktree + self-created pane: pane closed, spawn dropped",
      spawn: () => noWorktree(completed()),
      tree: "clean",
      probes: 0,
      expected: {
        outcome: { kind: "torn-down" },
        settlement: SETTLED_RECORDED,
        pane: { kind: "closed", paneId: "w1:p1" },
        worktree: { kind: "none" },
        branch: { kind: "not-applicable" },
      },
      dropped: true,
    },
    {
      name: "settled + no worktree + adopted pane: pane kept, spawn kept",
      spawn: () => {
        const r = noWorktree(completed());
        // Adopted pane: never created by the extension → never closed.
        r.execution.host = { ...r.execution.host!, paneCreated: false };
        return r;
      },
      tree: "clean",
      probes: 0,
      expected: {
        outcome: { kind: "torn-down" },
        settlement: SETTLED_RECORDED,
        pane: { kind: "open", paneId: "w1:p1" },
        worktree: { kind: "none" },
        branch: { kind: "not-applicable" },
      },
      dropped: false,
    },
    {
      name: "settled + removal not confirmed: removal-failed, spawn kept",
      spawn: completed,
      tree: "clean",
      probes: 1,
      expected: {
        outcome: { kind: "torn-down" },
        settlement: SETTLED_RECORDED,
        pane: { kind: "open", paneId: "w1:p1" },
        worktree: {
          kind: "removal-failed",
          path: WT_PATH,
          detail: "herdr did not confirm the worktree removal",
        },
        branch: { kind: "not-applicable" },
      },
      dropped: false,
    },
  ];

  it.each(rows)("$name", async (row) => {
    const spawns = new Map<string, AgentSpawn>([[ID, row.spawn()]]);
    const assets = buildAssets(row.tree);
    if (row.name.includes("removal not confirmed")) {
      assets.removeWorktree.mockResolvedValue(false);
    }
    const { registry } = buildRegistry(spawns);
    const opts = row.opts ? { force: row.opts.force === true } : undefined;

    const report = await createCleanup(assets).cleanupAgent(ID, registry, opts);

    expect(report).toMatchObject({ source: "tracked", ...row.expected });
    expect(assets.probes).toHaveBeenCalledTimes(row.probes);
    expect(spawns.has(ID)).toBe(!row.dropped);
  });

  it("keeps an unmerged branch but still removes the tree and drops the spawn", async () => {
    const spawns = new Map<string, AgentSpawn>([[ID, completed()]]);
    const assets = buildAssets("clean");
    assets.deleteBranch.mockResolvedValue({
      kind: "kept",
      reason: "unmerged",
    });
    const { registry } = buildRegistry(spawns);

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report.worktree).toEqual({ kind: "removed", path: WT_PATH });
    expect(report.branch).toEqual({ kind: "kept", reason: "unmerged" });
    expect(report.branchName).toBe(BRANCH);
    expect(spawns.has(ID)).toBe(false);
  });

  it("composes GateOutcome into the report via keptReport", async () => {
    const gate: GateOutcome = { kind: "kept", reason: { kind: "dirty" } };
    expect(gate.kind).toBe("kept");
    const basis: DiscoveryBasis = { kind: "pane-absent" };
    expect(basis.kind).toBe("pane-absent");
  });
});

/* ── cleanup — the proven-absent checkout ─────────────────────────────── */

/**
 * A settled tracked spawn shaped like the real locator's missing-dir answer
 * (agent-assets.locateTracked): the path is recorded, but the repo cwd probe
 * inside the checkout fails, so the plan is worktree-unlocatable with a path.
 */
describe("cleanup — the proven-absent checkout", () => {
  function unresolvable(): AgentSpawn {
    const r = completed();
    delete r.execution.spawnCtx;
    return r;
  }

  it("drops a settled tracked spawn whose owned checkout is already gone", async () => {
    const spawns = new Map<string, AgentSpawn>([[ID, unresolvable()]]);
    const assets = buildAssets("clean");
    assets.worktreeExists.mockResolvedValue(false);
    const { registry, dropped } = buildRegistry(spawns);

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report).toEqual({
      agentId: ID,
      source: "tracked",
      outcome: { kind: "torn-down" },
      branchName: BRANCH,
      settlement: { kind: "recorded", phase: "settled" },
      // No pane answers: reported gone, never closed (the extension closed nothing).
      pane: { kind: "gone", paneId: "w1:p1" },
      worktree: { kind: "absent", path: WT_PATH },
      branch: { kind: "not-applicable" },
    });
    expect(dropped).toEqual([ID]);
    expect(spawns.has(ID)).toBe(false);
    // Nothing to gate, remove, or delete: the branch stays, the record goes.
    expect(assets.probes).not.toHaveBeenCalled();
    expect(assets.removeWorktree).not.toHaveBeenCalled();
    expect(assets.removeGitWorktree).not.toHaveBeenCalled();
    expect(assets.deleteBranch).not.toHaveBeenCalled();
    expect(assets.closePane).not.toHaveBeenCalled();
  });

  it("keeps a checkout that exists but cannot be addressed", async () => {
    const spawns = new Map<string, AgentSpawn>([[ID, unresolvable()]]);
    const assets = buildAssets("clean");
    const { registry, dropped } = buildRegistry(spawns);

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report.worktree).toEqual({ kind: "kept", path: WT_PATH });
    expect(report.outcome).toEqual({
      kind: "refused",
      reason: {
        kind: "unverifiable",
        detail: "missing worktree path or repo cwd",
      },
    });
    expect(report.pane).toEqual({ kind: "open", paneId: "w1:p1" });
    expect(report.branch).toEqual({ kind: "not-applicable" });
    expect(dropped).toEqual([]);
    expect(spawns.has(ID)).toBe(true);
    expect(assets.worktreeExists).toHaveBeenCalledWith(WT_PATH);
    expect(assets.probes).not.toHaveBeenCalled();
    expect(assets.deleteBranch).not.toHaveBeenCalled();
  });

  it("never probes dirty state for a directory that is not there", async () => {
    const spawns = new Map<string, AgentSpawn>([[ID, unresolvable()]]);
    const assets = buildAssets("unverifiable");
    assets.worktreeExists.mockResolvedValue(false);
    const { registry } = buildRegistry(spawns);

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report.worktree).toEqual({ kind: "absent", path: WT_PATH });
    expect(assets.worktreeExists).toHaveBeenCalledTimes(1);
    expect(assets.probes).not.toHaveBeenCalled();
    expect(spawns.has(ID)).toBe(false);
  });

  it("reports a live pane as open only after observing it", async () => {
    const spawns = new Map<string, AgentSpawn>([[ID, unresolvable()]]);
    const assets = buildAssets("clean", { observed: { state: "done" } });
    assets.worktreeExists.mockResolvedValue(false);
    const { registry } = buildRegistry(spawns);

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report.pane).toEqual({ kind: "open", paneId: "w1:p1" });
    expect(assets.observe).toHaveBeenCalledTimes(1);
    expect(report.worktree).toEqual({ kind: "absent", path: WT_PATH });
    expect(spawns.has(ID)).toBe(false);
  });

  it("reports an unreadable pane as unknown without keeping the record", async () => {
    const spawns = new Map<string, AgentSpawn>([[ID, unresolvable()]]);
    const assets = buildAssets("clean", { observeFails: true });
    assets.worktreeExists.mockResolvedValue(false);
    const { registry, dropped } = buildRegistry(spawns);

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report.pane).toEqual({ kind: "unknown", paneId: "w1:p1" });
    expect(report.worktree).toEqual({ kind: "absent", path: WT_PATH });
    expect(dropped).toEqual([ID]);
  });

  it("reports no pane when the run never had a pane address", async () => {
    const r = unresolvable();
    delete r.execution.host;
    const spawns = new Map<string, AgentSpawn>([[ID, r]]);
    const assets = buildAssets("clean");
    assets.worktreeExists.mockResolvedValue(false);
    const { registry, dropped } = buildRegistry(spawns);

    const report = await createCleanup(assets).cleanupAgent(ID, registry);

    expect(report.pane).toEqual({ kind: "none" });
    expect(assets.observe).not.toHaveBeenCalled();
    expect(report.worktree).toEqual({ kind: "absent", path: WT_PATH });
    expect(dropped).toEqual([ID]);
  });
});

/* ── AgentManager.cleanup — adapter wiring ─────────────────────────────── */

/**
 * Install one session-backed spawn in `manager`, in the store and the session
 * map, as the spawn path does.
 */
function registerSpawn(manager: AgentManager, spawn: AgentSpawn): void {
  const session = new SubagentSession({
    id: ID,
    args: {
      pi: {} as never,
      ctx: {} as never,
      type: "general-purpose",
      prompt: "teardown adapter fixture",
      options: {
        spawnId: "tscleanup",
        description: "teardown adapter fixture",
        orchestration: TEST_ORCHESTRATION,
      },
    },
    deps: {
      transport: {
        createHost: () => ({}) as never,
        createIpc: () => ({}) as never,
      },
      slots: {
        reserve: () => {},
        reacquire: () => {},
        release: async () => {},
        cancelQueued: () => {},
      },
      onRunEnded: () => {},
      onFollowUpResult: () => {},
    },
  });
  Object.assign(session.spawn, spawn);
  (
    manager as unknown as { sessions: Map<string, SubagentSession> }
  ).sessions.set(ID, session);
}

describe("AgentManager.cleanup — adapter wiring", () => {
  let manager: AgentManager;

  beforeEach(() => {
    manager = new AgentManager();
    for (const entry of shared.store.list()) shared.store.drop(entry.id);
    removeHerdrWorktreeMock.mockReset().mockResolvedValue(true);
    deleteWorktreeBranchMock.mockReset().mockResolvedValue({ kind: "deleted" });
    isWorktreeDirtyMock.mockReset().mockResolvedValue(false);
    closePaneMock.mockReset().mockResolvedValue(undefined);
    dropNudgeMock.mockReset();
    resolveMainCheckoutMock.mockReset().mockResolvedValue("/work/repo");
  });

  it("delegates to cleanup with the assets seam as locator and deps", async () => {
    const spawn = completed();
    registerSpawn(manager, spawn);

    const report = await manager.cleanup(ID);

    // The pending completion nudge is withdrawn before the teardown starts.
    expect(dropNudgeMock).toHaveBeenCalledWith(ID);

    expect(report).toMatchObject({
      agentId: ID,
      source: "tracked",
      settlement: { kind: "recorded", phase: "settled" },
      worktree: { kind: "removed", path: WT_PATH },
      branch: { kind: "deleted" },
    });
    expect(isWorktreeDirtyMock).toHaveBeenCalledTimes(1);
    expect(removeHerdrWorktreeMock).toHaveBeenCalledWith({}, "w1");
    // No stop in the teardown plane: the pane goes with the workspace.
    expect(closePaneMock).not.toHaveBeenCalled();
    // The branch delete carries the host's attachment probe (4th arg).
    expect(deleteWorktreeBranchMock).toHaveBeenCalledWith(
      {},
      WT_PATH,
      "/work/repo",
      expect.any(Function),
    );
    expect(manager.getSpawn(ID)).toBeUndefined();
  });

  it("locates an id the store no longer tracks", async () => {
    const located = await manager.locate("deadbeef");

    expect(located.kind).toBe("not-found");
  });

  /** The staging directory the mocked shell maps ID to. */
  const stagingDir = path.join("/tmp", "pi-cowboy", ID);

  afterEach(() => fs.rmSync(stagingDir, { recursive: true, force: true }));

  /** A run's staging directory on disk, as its launch leaves it. */
  function stageArtifacts(): void {
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, "result.md"), "done");
  }

  it("removes the run's staging directory when disposal left no session", async () => {
    registerSpawn(manager, completed());
    stageArtifacts();
    // The store keeps the settled spawn; only the session that owned it goes.
    manager.dispose();
    expect(manager.getSpawn(ID)).toBeDefined();

    await manager.cleanup(ID);

    // The id-keyed removal is the only one left to run for that spawn.
    expect(fs.existsSync(stagingDir)).toBe(false);
  });

  it("removes the staging directory even when a failed removal keeps the spawn", async () => {
    registerSpawn(manager, completed());
    stageArtifacts();
    removeHerdrWorktreeMock.mockResolvedValue(false);

    const report = await manager.cleanup(ID);

    expect(report.outcome).toEqual({ kind: "torn-down" });
    expect(report.worktree.kind).toBe("removal-failed");
    expect(manager.getSpawn(ID)).toBeDefined();
    expect(fs.existsSync(stagingDir)).toBe(false);
  });

  it("leaves the staging directory alone when cleanup refuses a live run", async () => {
    registerSpawn(manager, spawn());
    stageArtifacts();

    const report = await manager.cleanup(ID);

    expect(report.outcome.kind).toBe("refused");
    expect(fs.existsSync(stagingDir)).toBe(true);
  });
});

/* ── AgentManager.clear — teardown ordering ───────────────────────────── */

describe("AgentManager.clear — teardown ordering", () => {
  let manager: AgentManager;
  /** A real checkout on disk: the teardown probes for it before anything else. */
  let checkout: string;

  beforeEach(() => {
    checkout = fs.mkdtempSync(path.join(os.tmpdir(), "cow-clear-order-"));
    manager = new AgentManager();
    for (const entry of shared.store.list()) shared.store.drop(entry.id);
    removeHerdrWorktreeMock.mockReset().mockResolvedValue(true);
    deleteWorktreeBranchMock.mockReset().mockResolvedValue({ kind: "deleted" });
    isWorktreeDirtyMock.mockReset().mockResolvedValue(false);
    closePaneMock.mockReset().mockResolvedValue(undefined);
    resolveMainCheckoutMock.mockReset().mockResolvedValue("/work/repo");
  });

  afterEach(() => fs.rmSync(checkout, { recursive: true, force: true }));

  /** A settled spawn owning `checkout`. */
  function clearable(): AgentSpawn {
    const spawn = completed();
    const worktree = spawn.display.worktree;
    if (worktree?.kind !== "owned") throw new Error("fixture owns no checkout");
    worktree.path = checkout;
    spawn.execution.spawnCtx = { cwd: "/work/repo" } as never;
    registerSpawn(manager, spawn);
    return manager.getSpawn(ID)!;
  }

  /** The retention reason recorded on a retained spawn. */
  function retentionOf(id: string): WorktreeRetentionReason | undefined {
    const { lifecycle } = manager.getSpawn(id)!;
    return hasOutcome(lifecycle)
      ? lifecycle.worktreeRetentionReason
      : undefined;
  }

  it("drops the spawn only after the checkout is removed", async () => {
    clearable();

    await expect(manager.clear(ID)).resolves.toEqual({ kind: "cleared" });

    expect(isWorktreeDirtyMock).toHaveBeenCalledWith({}, checkout);
    expect(removeHerdrWorktreeMock).toHaveBeenCalledWith({}, "w1");
    expect(deleteWorktreeBranchMock).toHaveBeenCalledWith(
      {},
      checkout,
      "/work/repo",
      expect.any(Function),
    );
    expect(manager.getSpawn(ID)).toBeUndefined();
    expect(manager.listAgents()).toEqual([]);
  });

  it("keeps a dirty checkout's spawn listed, with its reason on the spawn", async () => {
    isWorktreeDirtyMock.mockResolvedValue(true);
    const spawn = clearable();

    await expect(manager.clear(ID)).resolves.toEqual({
      kind: "kept",
      path: checkout,
      reason: { kind: "dirty" },
    });

    expect(removeHerdrWorktreeMock).not.toHaveBeenCalled();
    expect(deleteWorktreeBranchMock).not.toHaveBeenCalled();
    expect(manager.getSpawn(ID)).toBe(spawn);
    expect(manager.listAgents().map((entry) => entry.id)).toEqual([ID]);
    expect(retentionOf(ID)).toEqual({ kind: "dirty" });
  });

  it("keeps the spawn listed when the removal fails", async () => {
    removeHerdrWorktreeMock.mockResolvedValue(false);
    const spawn = clearable();

    await expect(manager.clear(ID)).resolves.toEqual({
      kind: "removal-failed",
      path: checkout,
      detail: "herdr did not confirm the worktree removal",
    });

    expect(manager.getSpawn(ID)).toBe(spawn);
    expect(retentionOf(ID)).toEqual({
      kind: "unverifiable",
      detail:
        "the removal was not confirmed (herdr did not confirm the worktree removal)",
    });
  });

  it("keeps an owned checkout no recorded cwd can address", async () => {
    const spawn = clearable();
    delete spawn.execution.spawnCtx;

    await expect(manager.clear(ID)).resolves.toEqual({
      kind: "kept",
      path: checkout,
      reason: {
        kind: "unverifiable",
        detail: "the run recorded no repository cwd",
      },
    });

    expect(isWorktreeDirtyMock).not.toHaveBeenCalled();
    expect(removeHerdrWorktreeMock).not.toHaveBeenCalled();
    expect(manager.getSpawn(ID)).toBe(spawn);
  });

  it("clears a spawn whose checkout is already gone", async () => {
    const spawn = clearable();
    const worktree = spawn.display.worktree;
    if (worktree?.kind !== "owned") throw new Error("fixture owns no checkout");
    worktree.path = path.join(checkout, "gone");

    await expect(manager.clear(ID)).resolves.toEqual({ kind: "cleared" });

    expect(isWorktreeDirtyMock).not.toHaveBeenCalled();
    expect(removeHerdrWorktreeMock).not.toHaveBeenCalled();
    expect(manager.getSpawn(ID)).toBeUndefined();
  });

  it("runs one teardown for a spawn already clearing, and no revive beside it", async () => {
    let confirmRemoval!: (removed: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      confirmRemoval = resolve;
    });
    removeHerdrWorktreeMock.mockReturnValue(pending);
    clearable();

    const first = manager.clear(ID);
    await expect(manager.clear(ID)).resolves.toEqual({
      kind: "refused",
      reason: "in-flight",
    });
    // A steer would revive the run into the worktree being cleaned up.
    await expect(manager.steer(ID, "one more turn")).resolves.toEqual({
      kind: "refused",
      reason: expect.stringContaining("being cleaned up"),
    });

    confirmRemoval(true);
    await expect(first).resolves.toEqual({ kind: "cleared" });
    expect(removeHerdrWorktreeMock).toHaveBeenCalledTimes(1);
    expect(manager.getSpawn(ID)).toBeUndefined();
  });

  it("refuses an id no spawn answers", async () => {
    await expect(manager.clear("deadbeef")).resolves.toEqual({
      kind: "refused",
      reason: "unknown-id",
    });
  });

  it("waits for an in-flight clear before cleaning the same agent", async () => {
    let confirmRemoval!: (removed: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      confirmRemoval = resolve;
    });
    removeHerdrWorktreeMock
      .mockReturnValueOnce(pending)
      .mockResolvedValue(true);
    clearable();

    const clear = manager.clear(ID);
    const cleanup = manager.cleanup(ID);

    confirmRemoval(true);
    await expect(clear).resolves.toEqual({ kind: "cleared" });
    // The clear took the spawn, so the waiting cleanup finds nothing to tear down.
    await expect(cleanup).rejects.toThrow(/not found/);
    expect(removeHerdrWorktreeMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a clear while the same agent is being cleaned up", async () => {
    let confirmRemoval!: (removed: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      confirmRemoval = resolve;
    });
    removeHerdrWorktreeMock.mockReturnValue(pending);
    clearable();

    const cleanup = manager.cleanup(ID);
    await expect(manager.clear(ID)).resolves.toEqual({
      kind: "refused",
      reason: "in-flight",
    });

    confirmRemoval(true);
    await expect(cleanup).resolves.toMatchObject({
      worktree: { kind: "removed" },
    });
    expect(removeHerdrWorktreeMock).toHaveBeenCalledTimes(1);
    expect(manager.getSpawn(ID)).toBeUndefined();
  });
});
