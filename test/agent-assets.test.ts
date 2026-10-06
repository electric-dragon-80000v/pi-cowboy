/**
 * agent-assets.test.ts — the located-artifacts seam; every probe faked to pin its decisions.
 * Degradation runs one way: an unreadable registry never becomes a claim of absence.
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentSpawn } from "../src/types.js";
import type { HostObservation } from "../src/agents/agent-host.js";
import {
  createAgentAssets,
  type AgentAssetsDeps,
  type Ambiguous,
  type AgentAssets,
  type Located,
  type LocateResult,
} from "../src/agents/agent-assets.js";
import type { HerdrAgentInfo } from "../src/infrastructure/herdr/agents.js";
import type { HerdrWorktreeInfo } from "../src/infrastructure/herdr/worktrees.js";

const ID = "a1b2c3d4";
const OTHER_ID = "z9y8x7w6";
const BRANCH = `cow-fix-login-${ID}`;
const WT_PATH = `/worktrees/${BRANCH}`;
const ROOT = "/worktrees";

/** A hint: an extension-owned worktree run with a recorded address. */
function hint(overrides: Partial<AgentSpawn> = {}): AgentSpawn {
  return {
    id: ID,
    display: {
      type: "general-purpose",
      description: "some task",
      taskSlug: "fix-login",
      worktree: { kind: "owned", path: WT_PATH, branch: BRANCH },
    },
    lifecycle: { phase: "spawned", startedAt: 1 },
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

function worktreeEntry(
  overrides: Partial<HerdrWorktreeInfo> = {},
): HerdrWorktreeInfo {
  return {
    path: WT_PATH,
    label: BRANCH,
    isLinkedWorktree: true,
    openWorkspaceId: "w1",
    ...overrides,
  };
}

function agentRecord(overrides: Partial<HerdrAgentInfo> = {}): HerdrAgentInfo {
  return {
    state: "done",
    paneId: "w1:p1",
    workspaceId: "w1",
    cwd: WT_PATH,
    interactiveReady: true,
    ...overrides,
  };
}

function buildDeps(overrides: Partial<AgentAssetsDeps> = {}): AgentAssetsDeps {
  return {
    deliverable: (id) => ({
      path: `/tmp/pi-cowboy/${id}/result.md`,
      present: false,
    }),
    listWorktrees: async () => [],
    listAgentRecords: async () => [],
    readPane: async () => undefined,
    worktreeRoot: async () => ROOT,
    listRootEntries: async () => [],
    resolveRepoCwd: async (path) =>
      path === WT_PATH ? "/work/repo" : undefined,
    isWorktreeDirty: async () => false,
    worktreeExists: async () => true,
    removeWorktree: async () => true,
    removeGitWorktree: async () => true,
    deleteBranch: async () => ({ kind: "deleted" as const }),
    closePane: async () => {},
    ...overrides,
  };
}

function assetsFor(overrides: Partial<AgentAssetsDeps> = {}): AgentAssets {
  return createAgentAssets(buildDeps(overrides));
}

async function located(result: LocateResult): Promise<Located> {
  expect(result.kind).toBe("located");
  return result as Located;
}

/* ── The tracked path: memory's provenance, live addresses ─────────────── */

describe("locate — a tracked run", () => {
  it("takes provenance from the hint and the checkout from memory's path", async () => {
    const assets = assetsFor({
      listWorktrees: async () => [worktreeEntry()],
    });

    const result = await located(await assets.locate(ID, hint()));

    expect(result).toEqual({
      kind: "located",
      source: "tracked",
      id: ID,
      branch: BRANCH,
      worktreeManaged: true,
      paneCreated: true,
      worktree: {
        path: WT_PATH,
        repoCwd: "/work/repo",
        workspaceId: "w1",
      },
      pane: { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
    });
  });

  it("prefers the workspace herdr reports over a stale recorded one", async () => {
    const assets = assetsFor({
      listWorktrees: async () => [worktreeEntry({ openWorkspaceId: "w9" })],
    });

    const result = await located(await assets.locate(ID, hint()));

    expect(result.worktree?.workspaceId).toBe("w9");
  });

  it("drops the workspace when herdr answers that no workspace hosts the checkout", async () => {
    // Recorded workspace gone (herdr restarted): removal must go through the git plane.
    const assets = assetsFor({
      listWorktrees: async () => [
        worktreeEntry({ openWorkspaceId: undefined }),
      ],
    });

    const result = await located(await assets.locate(ID, hint()));

    expect(result.worktree?.workspaceId).toBeUndefined();
  });

  it("keeps memory's address when the worktree registry cannot be read", async () => {
    const assets = assetsFor({
      listWorktrees: async () => {
        throw new Error("herdr down");
      },
    });

    const result = await located(await assets.locate(ID, hint()));

    expect(result.worktree?.workspaceId).toBe("w1");
  });

  it("refreshes the pane from a live record spawned in the checkout", async () => {
    const assets = assetsFor({
      listAgentRecords: async () => [
        agentRecord({ paneId: "w7:p3", tabId: "w7:t1", workspaceId: "w7" }),
      ],
    });

    const result = await located(await assets.locate(ID, hint()));

    expect(result.pane).toEqual({
      paneId: "w7:p3",
      tabId: "w7:t1",
      workspaceId: "w7",
    });
  });

  it("keeps the recorded pane when no live record matches", async () => {
    const assets = assetsFor({
      listAgentRecords: async () => [agentRecord({ cwd: "/elsewhere" })],
    });

    const result = await located(await assets.locate(ID, hint()));

    expect(result.pane).toEqual({
      paneId: "w1:p1",
      tabId: "w1:t1",
      workspaceId: "w1",
    });
  });

  it("keeps the recorded pane when the agent registry cannot be read", async () => {
    const assets = assetsFor({
      listAgentRecords: async () => {
        throw new Error("herdr down");
      },
    });

    const result = await located(await assets.locate(ID, hint()));

    expect(result.pane?.paneId).toBe("w1:p1");
  });

  it("never claims a worktree for a run memory says created none", async () => {
    const spawn = hint();
    delete spawn.display.worktree;
    const scan = vi.fn(async () => [BRANCH]);
    const assets = assetsFor({ listRootEntries: scan });

    const result = await located(await assets.locate(ID, spawn));

    expect(result).toMatchObject({
      worktreeManaged: false,
      paneCreated: true,
      worktree: null,
      pane: { paneId: "w1:p1" },
    });
    // Memory says we never made it: not ours to adopt, discovery stays shut.
    expect(scan).not.toHaveBeenCalled();
  });
});

/* ── The recovered path: discovery decides ────────────────────────────── */

describe("locate — a run with no record", () => {
  it("locates an adopted checkout from herdr's registry", async () => {
    const assets = assetsFor({
      listWorktrees: async () => [worktreeEntry({ openWorkspaceId: "w3" })],
      listAgentRecords: async () => [
        agentRecord({ workspaceId: "w3", cwd: "/ignored" }),
      ],
    });

    const result = await located(await assets.locate(ID));

    expect(result).toEqual({
      kind: "located",
      source: "recovered",
      id: ID,
      branch: BRANCH,
      worktreeManaged: true,
      // Nobody survived to prove the extension created the pane.
      paneCreated: false,
      worktree: {
        path: WT_PATH,
        repoCwd: "/work/repo",
        workspaceId: "w3",
      },
      pane: { paneId: "w1:p1", tabId: undefined, workspaceId: "w3" },
    });
  });

  it("matches the pane by workspace when no record reports the checkout cwd", async () => {
    const assets = assetsFor({
      listWorktrees: async () => [worktreeEntry({ openWorkspaceId: "w3" })],
      listAgentRecords: async () => [
        agentRecord({ workspaceId: "w3", cwd: "/somewhere-else" }),
      ],
    });

    const result = await located(await assets.locate(ID));

    expect(result.pane).toEqual({
      paneId: "w1:p1",
      tabId: undefined,
      workspaceId: "w3",
    });
  });

  it("falls back to the worktree root for a checkout herdr never adopted", async () => {
    const assets = assetsFor({
      listRootEntries: async (root) => {
        expect(root).toBe(ROOT);
        return ["unrelated", BRANCH];
      },
    });

    const result = await located(await assets.locate(ID));

    expect(result).toMatchObject({
      source: "recovered",
      worktreeManaged: true,
      branch: BRANCH,
      worktree: { path: WT_PATH, repoCwd: "/work/repo" },
      pane: null,
    });
  });

  it("takes the branch from a checkout whose name answers to the id", async () => {
    const assets = assetsFor({
      listWorktrees: async () => [
        worktreeEntry({ branch: "cow-legacy-name", path: `${ROOT}/${BRANCH}` }),
      ],
    });

    const result = await located(await assets.locate(ID));

    // Basename is the branch by construction: herdr's disagreeing report does not rename the run.
    expect(result.branch).toBe(BRANCH);
    expect(result.worktree?.path).toBe(`${ROOT}/${BRANCH}`);
  });

  it("reports not-found when nothing answers to the id", async () => {
    const assets = assetsFor();

    await expect(assets.locate(ID)).resolves.toEqual({
      kind: "not-found",
      id: ID,
    });
  });

  it("refuses to choose between two candidates", async () => {
    const assets = assetsFor({
      listWorktrees: async () => [
        worktreeEntry({ path: `${ROOT}/repo-a/${BRANCH}` }),
        worktreeEntry({ path: `${ROOT}/repo-b/${BRANCH}` }),
      ],
    });

    const result = (await assets.locate(ID)) as Ambiguous;

    expect(result.kind).toBe("ambiguous");
    expect(result.id).toBe(ID);
    expect(
      result.candidates.map((candidate) => candidate.worktreePath),
    ).toEqual([`${ROOT}/repo-a/${BRANCH}`, `${ROOT}/repo-b/${BRANCH}`]);
  });

  it("reports the same tree once when herdr and the filesystem both answer", async () => {
    const assets = assetsFor({
      listWorktrees: async () => [worktreeEntry()],
      listRootEntries: async () => [BRANCH],
    });

    const result = await located(await assets.locate(ID));

    expect(result.kind).toBe("located");
  });

  it("ignores a checkout outside the worktree root (not our ground)", async () => {
    const assets = assetsFor({
      listWorktrees: async () => [
        worktreeEntry({ path: `/elsewhere/${BRANCH}` }),
      ],
    });

    await expect(assets.locate(ID)).resolves.toEqual({
      kind: "not-found",
      id: ID,
    });
  });
});

/* ── Matching is exact ─────────────────────────────────────────────────── */

describe("locate — exact id matching", () => {
  it.each([
    [`cow-fix-login-${OTHER_ID}`, "another spawn's id"],
    [`not-an-extension-name-${ID}`, "no cow- prefix"],
    [`cow-fix-login-${ID}-extra`, "the id is not the suffix"],
  ])("ignores %s (%s)", async (name) => {
    const assets = assetsFor({
      listWorktrees: async () => [
        worktreeEntry({ path: `/worktrees/${name}`, branch: name }),
      ],
    });

    await expect(assets.locate(ID)).resolves.toEqual({
      kind: "not-found",
      id: ID,
    });
  });
});

/* ── The seam's other members ─────────────────────────────────────────── */

describe("assets members", () => {
  it("reports the deliverable from the id alone", async () => {
    const assets = assetsFor({
      deliverable: () => ({
        path: `/tmp/pi-cowboy/${ID}/result.md`,
        present: true,
      }),
    });

    expect(assets.deliverable(ID)).toEqual({
      path: `/tmp/pi-cowboy/${ID}/result.md`,
      present: true,
    });
  });

  it("answers observe with herdr's raw read", async () => {
    const readPane = vi.fn(
      async (paneId: string): Promise<HostObservation | undefined> =>
        paneId === "gone" ? undefined : { state: "working" },
    );
    const assets = assetsFor({ readPane });

    await expect(assets.observe({ paneId: "gone" })).resolves.toBeUndefined();
    await expect(assets.observe({ paneId: "w1:p1" })).resolves.toEqual({
      state: "working",
    });
  });

  it("lets a failed pane read throw (unreadable is not gone)", async () => {
    const assets = assetsFor({
      readPane: async () => {
        throw new Error("herdr down");
      },
    });

    await expect(assets.observe({ paneId: "w1:p1" })).rejects.toThrow(
      "herdr down",
    );
  });

  it("exposes the actuator half unchanged", async () => {
    const removeWorktree = vi.fn(async () => true);
    const closePane = vi.fn(async () => {});
    const assets = assetsFor({ removeWorktree, closePane });
    const ref = {
      engine: "herdr" as const,
      name: BRANCH,
      paneId: "w1:p1",
      tabId: "w1:t1",
      workspaceId: "w1",
      paneCreated: true,
    };

    await expect(assets.worktreeExists(WT_PATH)).resolves.toBe(true);
    await expect(assets.removeWorktree(ref)).resolves.toBe(true);
    await assets.closePane(ref);

    expect(removeWorktree).toHaveBeenCalledWith(ref);
    expect(closePane).toHaveBeenCalledWith(ref);
    await expect(assets.deleteBranch(WT_PATH, "/work/repo")).resolves.toEqual({
      kind: "deleted",
    });
  });
});

/* ── Authority disagreements ──────────────────────────────────────────── */

describe("locate — per-asset authority", () => {
  it("never treats a picked tree as owned — memory's path is not read", async () => {
    const spawn = hint();
    spawn.display.worktree = {
      kind: "picked",
      path: "/elsewhere/tree",
      branch: "feature-x",
    };
    const assets = assetsFor({
      listWorktrees: async () => [worktreeEntry({ openWorkspaceId: "w4" })],
    });

    const result = await located(await assets.locate(ID, spawn));

    expect(result).toMatchObject({
      // The run works inside a pre-existing tree: located, never owned.
      source: "tracked",
      branch: "feature-x",
      worktreeManaged: false,
      worktree: null,
      pane: { paneId: "w1:p1" },
    });
  });

  it("leaves repoCwd absent when the checkout cannot be resolved", async () => {
    const assets = assetsFor({ resolveRepoCwd: async () => undefined });

    const result = await located(await assets.locate(ID, hint()));

    expect(result.worktree).toEqual({
      path: WT_PATH,
      repoCwd: undefined,
      workspaceId: "w1",
    });
  });
});
