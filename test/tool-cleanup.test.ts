/** tool-cleanup.test.ts — the cleanup_cowboy_agent tool boundary: the store-miss decision and the report rendering (cleanup itself: agent-cleanup.test.ts). */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSpawn } from "../src/types.js";
import type {
  CleanupReport,
  WorktreeKeptReason,
} from "../src/agents/cleanup-policy.js";
import type { LocateResult } from "../src/agents/agent-assets.js";
import type { ToolResult } from "../src/agents/tool-result.js";
import type { CleanupBatchParams } from "../src/agents/schemas/cleanup-batch.schema.js";
import type { CleanupItemOutcome } from "../src/agents/tool-cleanup.js";

const { getManagerMock } = vi.hoisted(() => ({ getManagerMock: vi.fn() }));

vi.mock("../src/shell.js", () => ({ getManager: getManagerMock }));

const { executeCleanupAgentTool } =
  await import("../src/agents/tool-cleanup.js");

const ID = "a1b2c3d4";
const BRANCH = `cow-fix-login-${ID}`;
const WT_PATH = `/worktrees/${BRANCH}`;
const DELIVERABLE = `/tmp/pi-cowboy/${ID}/result.md`;

interface FakeManager {
  getSpawn: ReturnType<typeof vi.fn>;
  locate: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
  listAgents: ReturnType<typeof vi.fn>;
}

interface ManagerOptions {
  spawn?: AgentSpawn;
  located?: LocateResult;
  report?: CleanupReport;
  activeAgents?: AgentSpawn[];
}

function fakeManager(options: ManagerOptions = {}): FakeManager {
  return {
    getSpawn: vi.fn(() => options.spawn),
    locate: vi.fn(
      async (id: string): Promise<LocateResult> =>
        options.located ?? { kind: "not-found", id },
    ),
    cleanup: vi.fn(async () => options.report),
    listAgents: vi.fn(() => options.activeAgents ?? []),
  };
}

async function invoke(
  params: CleanupBatchParams,
): Promise<ToolResult<{ agents: CleanupItemOutcome[] }>> {
  return executeCleanupAgentTool(
    "call-1",
    params,
    undefined,
    undefined,
    {} as never,
  );
}

function text(result: ToolResult<{ agents: CleanupItemOutcome[] }>): string {
  return result.content.map((block) => block.text).join("\n");
}

function cleaned(
  result: ToolResult<{ agents: CleanupItemOutcome[] }>,
): CleanupReport {
  const outcome = result.details.agents[0];
  if (outcome.kind !== "cleaned") throw new Error("expected a cleaned item");
  return outcome.report;
}

function trackedReport(overrides: Partial<CleanupReport> = {}): CleanupReport {
  return {
    agentId: ID,
    source: "tracked",
    outcome: { kind: "torn-down" },
    settlement: { kind: "recorded", phase: "settled" },
    pane: { kind: "closed", paneId: "w1:p1" },
    worktree: { kind: "removed", path: WT_PATH },
    branch: { kind: "deleted" },
    branchName: BRANCH,
    ...overrides,
  };
}

function recoveredReport(
  overrides: Partial<CleanupReport> = {},
): CleanupReport {
  return {
    agentId: ID,
    source: "recovered",
    outcome: { kind: "torn-down" },
    settlement: {
      kind: "discovered",
      basis: { kind: "pane-not-working", state: "done" },
      deliverable: { path: DELIVERABLE, present: true },
    },
    pane: { kind: "closed", paneId: "w1:p1" },
    worktree: { kind: "removed", path: WT_PATH },
    branch: { kind: "deleted" },
    branchName: BRANCH,
    ...overrides,
  };
}

beforeEach(() => {
  getManagerMock.mockReset();
});

describe("executeCleanupAgentTool — validation", () => {
  it("rejects a repeated id before removing anything", async () => {
    const manager = fakeManager({
      spawn: { id: ID } as AgentSpawn,
      report: trackedReport(),
    });
    getManagerMock.mockReturnValue(manager);

    await expect(invoke({ agent_ids: [ID, ID] })).rejects.toThrow(
      /duplicate agent ids.*No item was handled/,
    );
    expect(manager.cleanup).not.toHaveBeenCalled();
  });
});

describe("executeCleanupAgentTool — an id the store does not track", () => {
  it("runs the locator and reports the id unknown when nothing is found", async () => {
    const manager = fakeManager({ report: trackedReport() });
    getManagerMock.mockReturnValue(manager);

    const result = await invoke({ agent_ids: [ID] });
    expect(text(result)).toBe(`Agent ${ID} not found. Active agents: none`);
    expect(result.details.agents).toEqual([
      { kind: "unknown", agentId: ID, activeAgents: "none" },
    ]);
    expect(manager.locate).toHaveBeenCalledWith(ID);
    expect(manager.cleanup).not.toHaveBeenCalled();
  });

  it("names the live agents in that error", async () => {
    const manager = fakeManager({
      activeAgents: [
        {
          id: "ffffffff",
          display: { type: "general-purpose" },
          lifecycle: { phase: "spawned" },
        } as AgentSpawn,
      ],
    });
    getManagerMock.mockReturnValue(manager);

    const result = await invoke({ agent_ids: [ID] });
    expect(text(result)).toBe(
      `Agent ${ID} not found. Active agents: ffffffff (general-purpose)`,
    );
  });

  it("cleans up a run whose artifacts were located", async () => {
    const report = recoveredReport();
    const manager = fakeManager({
      located: {
        kind: "located",
        source: "recovered",
        id: ID,
        branch: BRANCH,
        worktreeManaged: true,
        paneCreated: false,
        worktree: { path: WT_PATH, repoCwd: "/work/repo" },
        pane: null,
      },
      report,
    });
    getManagerMock.mockReturnValue(manager);

    const result = await invoke({ agent_ids: [ID] });

    expect(manager.locate).toHaveBeenCalledWith(ID);
    expect(manager.cleanup).toHaveBeenCalledWith(ID);
    expect(cleaned(result)).toBe(report);
    expect(text(result)).toBe(
      [
        `Cleaned up agent ${ID}:`,
        "  agent status: unrecorded (basis: pane-not-working: done)",
        "  pane: closed",
        `  worktree: removed (${WT_PATH})`,
        `  branch: deleted (${BRANCH})`,
        "  recovered: no spawn record survived — this verdict rests on discovery (herdr's live read plus the worktree on disk)",
        `  deliverable: UNREAD at ${DELIVERABLE} — read it before deleting the directory`,
      ].join("\n"),
    );
  });

  it("cleans up a contested id too — the locator only answers not-found", async () => {
    const report = recoveredReport({
      settlement: {
        kind: "discovered",
        basis: { kind: "artifacts-ambiguous" },
        deliverable: { path: DELIVERABLE, present: false },
      },
      outcome: {
        kind: "refused",
        reason: {
          kind: "ambiguous-artifacts",
          candidates: [`/a/${BRANCH}`, `/b/${BRANCH}`],
        },
      },
      pane: { kind: "none" },
      worktree: { kind: "kept", path: null },
      branch: { kind: "not-applicable" },
    });
    const manager = fakeManager({
      located: {
        kind: "ambiguous",
        id: ID,
        candidates: [{ worktreePath: `/a/${BRANCH}`, branch: BRANCH }],
      },
      report,
    });
    getManagerMock.mockReturnValue(manager);

    const result = await invoke({ agent_ids: [ID] });

    expect(manager.cleanup).toHaveBeenCalledWith(ID);
    expect(text(result)).toContain(
      `Did not clean up agent ${ID}: two artifacts answer to this id (/a/${BRANCH}, /b/${BRANCH}) — nothing was removed; work out which run owns the id before removing either by hand`,
    );
    expect(text(result)).toContain(
      "  worktree: kept (worktree path not recorded)",
    );
    expect(text(result)).toContain(
      `deliverable: none written (${DELIVERABLE} does not exist)`,
    );
  });
});

describe("executeCleanupAgentTool — a tracked id", () => {
  it("skips the locator and renders the recorded verdict", async () => {
    const manager = fakeManager({
      spawn: { id: ID } as AgentSpawn,
      report: trackedReport(),
    });
    getManagerMock.mockReturnValue(manager);

    const result = await invoke({ agent_ids: [ID] });

    expect(manager.locate).not.toHaveBeenCalled();
    expect(manager.cleanup).toHaveBeenCalledWith(ID);
    expect(text(result)).toBe(
      [
        `Cleaned up agent ${ID}:`,
        "  agent status: settled",
        "  pane: closed",
        `  worktree: removed (${WT_PATH})`,
        `  branch: deleted (${BRANCH})`,
      ].join("\n"),
    );
    expect(text(result)).not.toContain("recovered:");
  });

  it("renders the phase a run ended in, never-started included", async () => {
    const manager = fakeManager({
      spawn: { id: ID } as AgentSpawn,
      report: trackedReport({
        settlement: { kind: "recorded", phase: "never-started" },
        pane: { kind: "none" },
      }),
    });
    getManagerMock.mockReturnValue(manager);

    const result = await invoke({ agent_ids: [ID] });

    expect(text(result)).toBe(
      [
        `Cleaned up agent ${ID}:`,
        "  agent status: never-started",
        "  pane: none",
        `  worktree: removed (${WT_PATH})`,
        `  branch: deleted (${BRANCH})`,
      ].join("\n"),
    );
  });
});

describe("executeCleanupAgentTool — report rendering", () => {
  it.each<[WorktreeKeptReason, string]>([
    [
      { kind: "dirty" },
      "Did not clean up agent " + ID + ": has uncommitted changes",
    ],
    [
      { kind: "unverifiable", detail: "git status probe failed" },
      "Did not clean up agent " +
        ID +
        ": state could not be verified (git status probe failed)",
    ],
    [
      { kind: "agent-active", phase: "spawned" },
      `Did not clean up agent ${ID}: the agent is still spawned and has not reported a result — stop it with stop_cowboy_agent, then clean up`,
    ],
    [
      { kind: "recovered-refusal", basis: { kind: "pane-working" } },
      `Did not clean up agent ${ID}: no settlement was recorded and herdr still reports the agent at work (pane-working) — stop it before retrying`,
    ],
    [
      {
        kind: "unverifiable",
        detail: "the pane state could not be read (herdr down)",
      },
      "Did not clean up agent " +
        ID +
        ": state could not be verified (the pane state could not be read (herdr down))",
    ],
    [
      {
        kind: "unverifiable",
        detail: "missing worktree path or repo cwd",
      },
      "Did not clean up agent " +
        ID +
        ": state could not be verified (missing worktree path or repo cwd)",
    ],
    [
      {
        kind: "ambiguous-artifacts",
        candidates: [`/a/${BRANCH}`, `/b/${BRANCH}`],
      },
      `Did not clean up agent ${ID}: two artifacts answer to this id (/a/${BRANCH}, /b/${BRANCH}) — nothing was removed; work out which run owns the id before removing either by hand`,
    ],
  ])(
    "states the refusal reason %# in the headline",
    async (reason, expected) => {
      const manager = fakeManager({
        spawn: { id: ID } as AgentSpawn,
        report: trackedReport({
          outcome: { kind: "refused", reason },
          worktree: { kind: "kept", path: WT_PATH },
          branch: { kind: "not-applicable" },
        }),
      });
      getManagerMock.mockReturnValue(manager);

      expect(text(await invoke({ agent_ids: [ID] }))).toContain(expected);
    },
  );

  it("states a refusal with no worktree to name", async () => {
    const manager = fakeManager({
      spawn: { id: ID } as AgentSpawn,
      report: trackedReport({
        outcome: { kind: "refused", reason: { kind: "dirty" } },
        worktree: { kind: "none" },
        branch: { kind: "not-applicable" },
      }),
    });
    getManagerMock.mockReturnValue(manager);

    const rendered = text(await invoke({ agent_ids: [ID] }));
    expect(rendered).toContain("Did not clean up agent " + ID);
    expect(rendered).toContain("has uncommitted changes");
    expect(rendered).toContain(
      "  worktree: none (agent ran without a worktree)",
    );
  });

  it.each<[CleanupReport, string[]]>([
    [
      trackedReport({
        worktree: {
          kind: "removal-failed",
          path: WT_PATH,
          detail: "herdr did not confirm the worktree removal",
        },
        branch: { kind: "not-applicable" },
      }),
      [
        `worktree: NOT removed — herdr did not confirm the worktree removal (${WT_PATH})`,
        "branch: not applicable",
      ],
    ],
    [
      trackedReport({
        pane: { kind: "open", paneId: "w1:p1" },
        worktree: { kind: "none" },
        branch: { kind: "not-applicable" },
        branchName: undefined,
      }),
      [
        "worktree: none (agent ran without a worktree)",
        "branch: not applicable",
      ],
    ],
    [
      trackedReport({ branch: { kind: "kept", reason: "unmerged" } }),
      [`branch: kept (unmerged) (${BRANCH})`],
    ],
    [
      trackedReport({
        branch: { kind: "delete-failed", detail: "branch checkout failed" },
      }),
      ["branch: NOT deleted — branch checkout failed"],
    ],
    [
      trackedReport({ pane: { kind: "none" }, worktree: { kind: "none" } }),
      ["pane: none"],
    ],
  ])("renders the failure and branch planes %#", async (report, expected) => {
    const manager = fakeManager({
      spawn: { id: ID } as AgentSpawn,
      report,
    });
    getManagerMock.mockReturnValue(manager);
    const rendered = text(await invoke({ agent_ids: [ID] }));

    expect(expected.filter((line) => !rendered.includes(line))).toEqual([]);
  });

  it("renders a forced verdict as a settled-looking unrecorded basis", async () => {
    const manager = fakeManager({
      spawn: { id: ID } as AgentSpawn,
      report: recoveredReport({
        settlement: {
          kind: "discovered",
          basis: { kind: "forced" },
          deliverable: { path: DELIVERABLE, present: false },
        },
      }),
    });
    getManagerMock.mockReturnValue(manager);

    expect(text(await invoke({ agent_ids: [ID] }))).toContain(
      "agent status: unrecorded (basis: forced)",
    );
  });
});

describe("executeCleanupAgentTool — batch", () => {
  const OTHER = "ffffffff";
  const OTHER_BRANCH = `cow-add-tests-${OTHER}`;
  const OTHER_WT = `/worktrees/${OTHER_BRANCH}`;

  function batchManager(
    reports: Record<string, CleanupReport>,
    missing: readonly string[] = [],
  ) {
    return {
      getSpawn: vi.fn((id: string) =>
        missing.includes(id) ? undefined : ({ id } as AgentSpawn),
      ),
      locate: vi.fn(async (id: string): Promise<LocateResult> => ({
        kind: "not-found",
        id,
      })),
      cleanup: vi.fn(async (id: string) => reports[id]),
      listAgents: vi.fn(() => []),
    };
  }

  it("cleans every id in one call and joins the summaries with the batch separator", async () => {
    const second = trackedReport({
      agentId: OTHER,
      worktree: { kind: "removed", path: OTHER_WT },
      branch: { kind: "kept", reason: "unmerged" },
      branchName: OTHER_BRANCH,
    });
    const manager = batchManager({ [ID]: trackedReport(), [OTHER]: second });
    getManagerMock.mockReturnValue(manager);

    const result = await invoke({ agent_ids: [ID, OTHER] });

    expect(manager.cleanup).toHaveBeenCalledTimes(2);
    expect(manager.cleanup).toHaveBeenNthCalledWith(1, ID);
    expect(manager.cleanup).toHaveBeenNthCalledWith(2, OTHER);
    expect(text(result)).toBe(
      [
        `Cleaned up agent ${ID}:`,
        "  agent status: settled",
        "  pane: closed",
        `  worktree: removed (${WT_PATH})`,
        `  branch: deleted (${BRANCH})`,
        "",
        "---",
        "",
        `Cleaned up agent ${OTHER}:`,
        "  agent status: settled",
        "  pane: closed",
        `  worktree: removed (${OTHER_WT})`,
        `  branch: kept (unmerged) (${OTHER_BRANCH})`,
      ].join("\n"),
    );
    expect(result.details.agents.map((a) => a.kind)).toEqual([
      "cleaned",
      "cleaned",
    ]);
  });

  it("keeps a still-spawned agent's worktree while removing the settled ones", async () => {
    const spawned = trackedReport({
      agentId: OTHER,
      settlement: { kind: "recorded", phase: "spawned" },
      pane: { kind: "open", paneId: "w1:p9" },
      outcome: {
        kind: "refused",
        reason: { kind: "agent-active", phase: "spawned" },
      },
      worktree: { kind: "kept", path: OTHER_WT },
      branch: { kind: "not-applicable" },
      branchName: OTHER_BRANCH,
    });
    const manager = batchManager({ [ID]: trackedReport(), [OTHER]: spawned });
    getManagerMock.mockReturnValue(manager);

    const result = await invoke({ agent_ids: [ID, OTHER] });
    const rendered = text(result);

    expect(rendered).toContain(`worktree: removed (${WT_PATH})`);
    expect(rendered).toContain(
      `Did not clean up agent ${OTHER}: the agent is still spawned and has not reported a result — stop it with stop_cowboy_agent, then clean up`,
    );
    expect(rendered).toContain(`  worktree: kept (${OTHER_WT})`);
    expect(result.details.agents.map((a) => a.kind)).toEqual([
      "cleaned",
      "cleaned",
    ]);
  });

  it("reports an unknown id as data and still cleans the rest", async () => {
    const otherReport = trackedReport({
      agentId: OTHER,
      worktree: { kind: "removed", path: OTHER_WT },
      branch: { kind: "kept", reason: "unmerged" },
      branchName: OTHER_BRANCH,
    });
    const manager = batchManager({ [OTHER]: otherReport }, [ID]);
    getManagerMock.mockReturnValue(manager);

    const result = await invoke({ agent_ids: [ID, OTHER] });

    expect(manager.locate).toHaveBeenCalledWith(ID);
    expect(manager.cleanup).toHaveBeenCalledTimes(1);
    expect(manager.cleanup).toHaveBeenCalledWith(OTHER);
    expect(text(result)).toBe(
      [
        `Agent ${ID} not found. Active agents: none`,
        "",
        "---",
        "",
        `Cleaned up agent ${OTHER}:`,
        "  agent status: settled",
        "  pane: closed",
        `  worktree: removed (${OTHER_WT})`,
        `  branch: kept (unmerged) (${OTHER_BRANCH})`,
      ].join("\n"),
    );
    expect(result.details.agents.map((a) => a.kind)).toEqual([
      "unknown",
      "cleaned",
    ]);
  });
});
