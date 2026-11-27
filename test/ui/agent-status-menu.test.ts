/**
 * agent-status-menu.test.ts — agent-status menu rows and the calls it makes.
 * Manager/runtime are structural fakes (listAgents, abort, cleanup, view.focus).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentSpawn } from "../../src/types.js";
import {
  subagentResultDirFor,
  subagentResultFileFor,
} from "../../src/paths.js";
import { probed } from "../../src/availability.js";
import type { PluginHarness } from "../../src/agents/harness.js";
import type { HandoverOutcome } from "../../src/agents/handover.js";
import type {
  CleanupOptions,
  CleanupReport,
} from "../../src/agents/cleanup-policy.js";
import { KEY, openMenu, type MenuSession } from "./harness.js";
import {
  dirtyRefusal,
  forcedTeardown,
  fullTeardown,
} from "./cleanup-fixtures.js";
import {
  resetShell,
  setCoordinator,
  setHarnessAvailability,
  setPi,
  shellState,
} from "./shell-mock.js";

vi.mock("../../src/shell.js", () => import("./shell-mock.js"));

/** The single-branch merge the menu performs: its readiness probe and its merge call. */
const merge = vi.hoisted(() => ({
  /** Next readiness verdict for a branch. */
  readiness: (_branch: string): Promise<"pending" | "nothing" | "unknown"> =>
    Promise.resolve("pending"),
  /** Every branch the menu asked to merge, in order. */
  merged: [] as string[],
  /** Next single-branch merge result. */
  merge: (_branch: string, _ctx?: unknown): Promise<unknown> =>
    Promise.resolve({
      outcome: {
        kind: "merged",
        branch: "cow-fix-login-abcd1234",
        target: "main",
      },
      text: 'Merged "cow-fix-login-abcd1234" into "main".',
    }),
}));

vi.mock("../../src/agents/tool-merge.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/agents/tool-merge.js")>();
  return {
    ...actual,
    branchMergeReadiness: async (branch: string) => {
      const kind = await merge.readiness(branch);
      return kind === "pending"
        ? { kind: "pending" as const }
        : kind === "nothing"
          ? { kind: "nothing" as const }
          : { kind: "unknown" as const };
    },
    mergeSingleBranch: (ctx: unknown, options: { branch: string }) => {
      merge.merged.push(options.branch);
      return merge.merge(options.branch, ctx) as never;
    },
  };
});

const { showAgentStatusMenu } =
  await import("../../src/ui/menu/menu-agent-status.js");

/** The report a landed merge produces: the tool's own sentence. */
const MERGED_RESULT = {
  outcome: { kind: "merged", branch: "cow-fix-login-abcd1234", target: "main" },
  text: 'Merged "cow-fix-login-abcd1234" into "main".',
};

/** Host address marking a live pane. */
const HOST = {
  multiplexer: "herdr" as const,
  name: "cow-fix-login-abcd1234",
  paneId: "pane-1",
  tabId: "tab-1",
  workspaceId: "ws-1",
  paneCreated: true,
};

/** A status row's head: the icon and id, before the fields' separators. */
function rowHead(label: string): string {
  return label.split(" • ")[0];
}

function baseSpawn(overrides: {
  id: string;
  lifecycle: AgentSpawn["lifecycle"];
  description?: string;
  host?: boolean;
  worktree?: boolean;
  harness?: string;
}): AgentSpawn {
  return {
    id: overrides.id,
    lifecycle: overrides.lifecycle,
    display: {
      type: "general-purpose" as AgentSpawn["display"]["type"],
      description: overrides.description ?? "Fix the login flow",
      ...(overrides.worktree === true
        ? {
            worktree: {
              kind: "owned",
              path: "/repo/.worktrees/fix-login",
              branch: "cow-fix-login-abcd1234",
            },
          }
        : {}),
    },
    execution: {
      promise: Promise.resolve(""),
      history: [],
      harness: overrides.harness ?? "pi",
      ...(overrides.host === true ? { host: HOST } : {}),
    },
  } as unknown as AgentSpawn;
}

function spawnedSpawn(id = "abcd1234-spawned-id"): AgentSpawn {
  return baseSpawn({
    id,
    lifecycle: { phase: "spawned", startedAt: Date.now() },
    host: true,
    worktree: true,
  });
}

function completedSpawn(
  id: string,
  result = "All done.\nSecond line.",
): AgentSpawn {
  return baseSpawn({
    id,
    lifecycle: {
      phase: "settled",
      startedAt: Date.now(),
      status: "completed",
      result,
      completedAt: Date.now(),
    },
    host: true,
    worktree: true,
  });
}

function errorSpawn(id: string, error = "boom"): AgentSpawn {
  return baseSpawn({
    id,
    lifecycle: {
      phase: "settled",
      startedAt: Date.now(),
      status: "error",
      error,
      completedAt: Date.now(),
    },
    host: true,
  });
}

/** Settled without ever launching: an outcome, but no run to hand over. */
function neverStartedSpawn(id: string): AgentSpawn {
  const spawn = baseSpawn({
    id,
    lifecycle: {
      phase: "never-started",
      queuedAt: Date.now(),
      status: "stopped",
      stop: { initiator: "user" },
      completedAt: Date.now(),
    },
  });
  // A run that never launched never engaged a harness.
  spawn.execution.harness = undefined;
  return spawn;
}

/** The lifecycle a stop leaves behind: the same run, settled and stopped. */
function settleStopped(spawn: AgentSpawn): void {
  spawn.lifecycle = {
    phase: "settled",
    startedAt: Date.now(),
    status: "stopped",
    stop: { initiator: "user" },
    completedAt: Date.now(),
  };
}

const aborted: string[] = [];
const cleanedUp: string[] = [];
const cleanupOpts: Array<{ id: string; force: boolean }> = [];
const focused: string[] = [];
const handedOver: Array<{ id: string; harness: string }> = [];
/** Next abort verdict, per id (stopped unless set). */
let abortImpl: (id: string) => Promise<boolean> = () => Promise.resolve(true);
/** Next handover outcome (a completed handover unless set). */
let handoverImpl: (id: string, harness: string) => Promise<HandoverOutcome> = (
  _id,
  harness,
) => Promise.resolve({ kind: "handed-over", from: "pi", to: harness });

/** Next cleanup report (a full teardown unless set), keyed on the force flag. */
let cleanupImpl: (id: string, force: boolean) => Promise<CleanupReport> = (
  id,
) => Promise.resolve(fullTeardown(id));

function installManager(agents: AgentSpawn[]): void {
  shellState.manager = {
    listAgents: () => agents,
    abort: (id: string) => {
      aborted.push(id);
      return abortImpl(id);
    },
    cleanup: (id: string, opts?: CleanupOptions) => {
      const force = opts?.force !== undefined;
      cleanedUp.push(id);
      cleanupOpts.push({ id, force });
      return cleanupImpl(id, force);
    },
    handover: (id: string, request: { harness: string }) => {
      handedOver.push({ id, harness: request.harness });
      return handoverImpl(id, request.harness);
    },
  };
}

/** A plugin harness the registry knows but that cannot export a session. */
function registerPluginWithoutReader(id: string): void {
  shellState.harnesses.register({
    id,
    displayName: `Plugin ${id}`,
    listModels: async () => ({ kind: "unavailable", notice: "test" }),
  } as unknown as PluginHarness);
}

function openAgentStatus(width = 160): MenuSession {
  return openMenu(
    (ctx: ExtensionCommandContext) => showAgentStatusMenu(ctx),
    width,
  );
}

beforeEach(() => {
  resetShell();
  aborted.length = 0;
  cleanedUp.length = 0;
  cleanupOpts.length = 0;
  focused.length = 0;
  handedOver.length = 0;
  abortImpl = () => Promise.resolve(true);
  merge.readiness = () => Promise.resolve("pending");
  merge.merged.length = 0;
  merge.merge = () => Promise.resolve(MERGED_RESULT);
  cleanupImpl = (id) => Promise.resolve(fullTeardown(id));
  handoverImpl = (_id, harness) =>
    Promise.resolve({ kind: "handed-over", from: "pi", to: harness });
  setPi({ exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
  setCoordinator(null);
  shellState.runtime = {
    view: {
      focus: (ref: unknown) => {
        focused.push((ref as { name: string }).name);
        return Promise.resolve();
      },
    },
  };
});

describe("Agent status — empty states", () => {
  it("notifies when the manager is not initialized", async () => {
    const session = openAgentStatus();
    await session.settle();

    expect(session.notifications.map((n) => n.message)).toContain(
      "No agents have been spawned this session",
    );
    expect(session.screenCount).toBe(0);
  });

  it("notifies when the manager lists no agents", async () => {
    installManager([]);
    const session = openAgentStatus();
    await session.settle();

    expect(session.notifications.map((n) => n.message)).toContain(
      "No agents have been spawned this session",
    );
    expect(session.screenCount).toBe(0);
  });
});

describe("Agent status — the list", () => {
  it("renders one row per agent with status, duration and worktree", () => {
    installManager([spawnedSpawn(), completedSpawn("beef5678-completed")]);
    const session = openAgentStatus();

    expect(session.title()).toBe("Status");
    const text = session.text();
    expect(text).toMatch(
      /◈ abcd1234-spawned-id • pi • general-purpose • spawned • <1s • wt:cow-fix-login-abcd1234/,
    );
    expect(text).toMatch(
      /✓ beef5678-completed • pi • general-purpose • completed • <1s/,
    );
    expect(text).toContain("— Fix the login flow");
  });

  it("shows the harness the run launched under", () => {
    installManager([
      baseSpawn({
        id: "abcd1234-spawned-id",
        lifecycle: { phase: "spawned", startedAt: Date.now() },
        host: true,
        harness: "opencode",
      }),
    ]);
    const session = openAgentStatus();

    expect(session.text()).toContain("• opencode • general-purpose");
  });

  it("offers the group actions that match the listed agents", () => {
    installManager([
      spawnedSpawn(),
      completedSpawn("beef5678-completed"),
      errorSpawn("cafe9999-errored"),
    ]);
    const session = openAgentStatus();

    const labels = session.walkRows().map((row) => row.label);
    expect(labels.map(rowHead)).toEqual([
      "◈ abcd1234-spawned-id",
      "✓ beef5678-completed",
      "✗ cafe9999-errored",
      "Stop 1 active agent(s)",
      "Clean up 2 settled agent(s)",
      "Clean up 1 completed agent(s)",
    ]);
  });

  it("hides the completed-only row when no agent completed", () => {
    installManager([spawnedSpawn(), errorSpawn("cafe9999-errored")]);
    const session = openAgentStatus();

    const labels = session.walkRows().map((row) => row.label);
    expect(labels).toContain("Clean up 1 settled agent(s)");
    expect(labels).not.toContain("Clean up 1 completed agent(s)");
    expect(labels.map(rowHead)).not.toContain("✓ cafe9999-errored");
    expect(labels.map(rowHead)).toContain("✗ cafe9999-errored");
  });
});

describe("Agent status — group actions", () => {
  it("stops every active agent and closes the menu", async () => {
    installManager([
      spawnedSpawn("aaaa1111-spawned"),
      spawnedSpawn("bbbb2222-spawned"),
    ]);
    const session = openAgentStatus();

    session.open("Stop 2 active agent(s)");
    await session.settle();

    expect(aborted).toEqual(["aaaa1111-spawned", "bbbb2222-spawned"]);
    expect(session.notifications.map((n) => n.message)).toEqual([
      "Stopping 2 agent(s) …",
      "✓ Stopped 2 agent(s)",
    ]);
    expect(session.closedScreens).toHaveLength(1);
  });

  it("reports the agents the batch could not stop", async () => {
    installManager([
      spawnedSpawn("aaaa1111-spawned"),
      spawnedSpawn("bbbb2222-spawned"),
    ]);
    abortImpl = (id) =>
      id.startsWith("aaaa")
        ? Promise.resolve(false)
        : Promise.reject(new Error("pane gone"));
    const session = openAgentStatus();

    session.open("Stop 2 active agent(s)");
    await session.settle();

    expect(session.notifications.at(-1)).toEqual({
      message:
        "✗ Failed to stop 2 agent(s): aaaa1111-spawned (already settled), bbbb2222-spawned (pane gone)",
      kind: "error",
    });
  });

  it("cleans up only completed agents through the completed-only row", async () => {
    installManager([
      completedSpawn("beef5678-completed"),
      errorSpawn("cafe9999-errored"),
    ]);
    const session = openAgentStatus();

    session.open("Clean up 1 completed agent(s)");
    await session.settle();

    expect(cleanedUp).toEqual(["beef5678-completed"]);
    expect(session.notifications.map((n) => n.message)).toEqual([
      "Cleaning up agent beef5678-completed \u2026",
      "✓ Cleaned up agent beef5678-completed: pane closed, worktree removed (/repo/.worktrees/fix-login), branch deleted (cow-fix-login-abcd1234)",
    ]);
  });

  it("cleans up every settled agent through the settled row", async () => {
    installManager([
      spawnedSpawn(),
      completedSpawn("beef5678-completed"),
      errorSpawn("cafe9999-errored"),
    ]);
    const session = openAgentStatus();

    session.open("Clean up 2 settled agent(s)");
    await session.settle();

    // The group row never touches the spawned agent.
    expect(cleanedUp).toEqual(["beef5678-completed", "cafe9999-errored"]);
    expect(session.closedScreens).toHaveLength(1);
    // Each teardown reports as it lands, so a slow worktree never hides the rest.
    expect(session.notifications.map((n) => n.message)).toEqual([
      "Cleaning up 2 agent(s) \u2026",
      "✓ Cleaned up agent beef5678-completed: pane closed, worktree removed (/repo/.worktrees/fix-login), branch deleted (cow-fix-login-abcd1234)",
      "✓ Cleaned up agent cafe9999-errored: pane closed, worktree removed (/repo/.worktrees/fix-login), branch deleted (cow-fix-login-abcd1234)",
    ]);
  });
});

describe("Agent status — the per-agent actions list", () => {
  it("offers the live actions for a spawned agent", async () => {
    installManager([spawnedSpawn()]);
    const session = openAgentStatus();

    session.open(/◈ abcd1234-spawned-id/);
    await session.settle();

    // A healthy run has neither result nor error, so no viewer entry.
    expect(session.walkRows().map((row) => row.label)).toEqual([
      "View shell",
      "Handover",
      "Export",
      "Stop",
    ]);
  });

  it("offers clean up instead of stop for a settled agent", async () => {
    installManager([completedSpawn("beef5678-completed")]);
    const session = openAgentStatus();

    session.open(/✓ beef5678-completed/);
    await session.settle();

    const labels = session.walkRows().map((row) => row.label);
    expect(labels).toEqual([
      "View shell",
      "View result",
      "Merge",
      "Handover",
      "Export",
      "Clean up",
    ]);
    session.focus("Clean up");
    expect(session.text()).toContain(
      "Close its pane and remove its worktree and merged branch",
    );
  });

  it("offers View error only for a failed agent", async () => {
    installManager([errorSpawn("cafe9999-errored")]);
    const session = openAgentStatus();

    session.open(/✗ cafe9999-errored/);
    await session.settle();

    expect(session.walkRows().map((row) => row.label)).toEqual([
      "View shell",
      "View error",
      "Handover",
      "Export",
      "Clean up",
    ]);
  });

  it("stops the agent from its actions list without waiting on the stop", async () => {
    installManager([spawnedSpawn()]);
    let releaseAbort: (() => void) | undefined;
    abortImpl = () =>
      new Promise<boolean>((resolve) => {
        releaseAbort = () => resolve(true);
      });
    const session = openAgentStatus();
    session.open(/◈ abcd1234-spawned-id/);
    await session.settle();

    session.open("Stop");

    // The list comes back with the stop still in flight, then the verdict lands.
    expect(session.activeRow()?.label).toContain("◈ abcd1234-spawned-id");
    expect(session.closedScreens).toEqual([]);
    expect(session.notifications.map((n) => n.message)).toEqual([
      "Stopping agent abcd1234-spawned-id …",
    ]);

    releaseAbort?.();
    await session.settle();

    expect(aborted).toEqual(["abcd1234-spawned-id"]);
    expect(session.notifications.at(-1)).toEqual({
      message: "✓ Stopped abcd1234-spawned-id",
      kind: "info",
    });
  });

  it("reports an agent that settled before the stop reached it", async () => {
    installManager([spawnedSpawn()]);
    abortImpl = () => Promise.resolve(false);
    const session = openAgentStatus();
    session.open(/◈ abcd1234-spawned-id/);
    await session.settle();

    session.open("Stop");
    await session.settle();

    expect(session.notifications.at(-1)).toEqual({
      message: "✗ Failed to stop agent abcd1234-spawned-id: already settled",
      kind: "error",
    });
  });

  it("reports a stop that threw", async () => {
    installManager([spawnedSpawn()]);
    abortImpl = () => Promise.reject(new Error("herdr unreachable"));
    const session = openAgentStatus();
    session.open(/◈ abcd1234-spawned-id/);
    await session.settle();

    session.open("Stop");
    await session.settle();

    expect(session.notifications.at(-1)).toEqual({
      message: "✗ Failed to stop agent abcd1234-spawned-id: herdr unreachable",
      kind: "error",
    });
  });

  it("cleans a settled agent up and closes the menu", async () => {
    installManager([completedSpawn("beef5678-completed")]);
    const session = openAgentStatus();
    session.open(/✓ beef5678-completed/);
    await session.settle();

    session.open("Clean up");
    await session.settle();

    expect(cleanedUp).toEqual(["beef5678-completed"]);
    expect(cleanupOpts).toEqual([{ id: "beef5678-completed", force: false }]);
    expect(session.closedScreens).toHaveLength(1);
    expect(session.notifications.at(-1)).toEqual({
      message:
        "✓ Cleaned up agent beef5678-completed: pane closed, worktree removed (/repo/.worktrees/fix-login), branch deleted (cow-fix-login-abcd1234)",
      kind: "info",
    });
  });

  it("offers Force on a forceable refusal, then runs the forced pass on Y", async () => {
    installManager([completedSpawn("beef5678-completed")]);
    cleanupImpl = (id, force) =>
      Promise.resolve(force ? forcedTeardown(id) : dirtyRefusal(id));
    const session = openAgentStatus();
    session.open(/✓ beef5678-completed/);
    await session.settle();

    session.open("Clean up");
    await session.settle();

    // The refusal is offered in-menu — Force first, Cancel second — and the
    // menu stays open behind the decision.
    expect(session.closedScreens).toEqual([]);
    expect(session.activeRow()?.label).toBe("Force");
    expect(session.walkRows().map((row) => row.label)).toEqual([
      "Force",
      "Cancel",
    ]);

    session.press(KEY.enter);
    expect(session.text()).toContain(
      "Force cleanup of agent beef5678-completed?",
    );
    expect(session.text()).toContain("This DELETES its worktree");

    session.press("y");
    await session.settle();

    expect(cleanupOpts).toEqual([
      { id: "beef5678-completed", force: false },
      { id: "beef5678-completed", force: true },
    ]);
    expect(session.closedScreens).toHaveLength(1);
    expect(session.notifications.at(-1)).toEqual({
      message:
        "✓ Cleaned up agent beef5678-completed forced — has uncommitted changes: pane closed, worktree removed (/repo/.worktrees/fix-login), branch deleted (cow-fix-login-abcd1234)",
      kind: "info",
    });
  });

  it("keeps the menu open with the agent listed when the offer is declined", async () => {
    installManager([completedSpawn("beef5678-completed")]);
    cleanupImpl = (id, force) =>
      Promise.resolve(force ? forcedTeardown(id) : dirtyRefusal(id));
    const session = openAgentStatus();
    session.open(/✓ beef5678-completed/);
    await session.settle();

    session.open("Clean up");
    await session.settle();
    session.press(KEY.escape);
    await session.settle();

    // No forced pass; the refusal is reported and the menu refreshes in place.
    expect(cleanupOpts).toEqual([{ id: "beef5678-completed", force: false }]);
    expect(session.closedScreens).toEqual([]);
    expect(session.activeRow()?.label).toContain("✓ beef5678-completed");
    expect(session.notifications.at(-1)).toEqual({
      message:
        "✓ Did not clean up agent beef5678-completed: has uncommitted changes pane closed",
      kind: "warning",
    });
  });

  it("reports a cleanup that threw", async () => {
    installManager([completedSpawn("beef5678-completed")]);
    cleanupImpl = () => Promise.reject(new Error("worktree is locked"));
    const session = openAgentStatus();
    session.open(/✓ beef5678-completed/);
    await session.settle();

    session.open("Clean up");
    await session.settle();

    expect(session.notifications.at(-1)).toEqual({
      message:
        "✗ Failed to clean up agent beef5678-completed: worktree is locked",
      kind: "error",
    });
  });

  it("focuses the agent's herdr pane, reporting every stage", async () => {
    installManager([spawnedSpawn()]);
    const session = openAgentStatus();
    session.open(/◈ abcd1234-spawned-id/);
    await session.settle();

    session.open("View shell");
    await session.settle();

    expect(focused).toEqual(["cow-fix-login-abcd1234"]);
    expect(session.notifications.map((n) => n.message)).toEqual([
      "Focusing agent abcd1234-spawned-id's herdr pane …",
      "✓ Focused agent abcd1234-spawned-id's herdr pane",
    ]);
  });

  it("reports a focus that threw", async () => {
    installManager([spawnedSpawn()]);
    shellState.runtime = {
      view: {
        focus: () => Promise.reject(new Error("tab closed")),
      },
    };
    const session = openAgentStatus();
    session.open(/◈ abcd1234-spawned-id/);
    await session.settle();

    session.open("View shell");
    await session.settle();

    expect(session.notifications.at(-1)).toEqual({
      message:
        "✗ Failed to focus agent abcd1234-spawned-id's herdr pane: tab closed",
      kind: "error",
    });
  });
});

describe("Agent status — handover", () => {
  it("offers handover for an agent that never started, refusing it with the reason", async () => {
    installManager([neverStartedSpawn("dead0000-queued")]);
    const session = openAgentStatus();

    session.open(/dead0000-queued/);
    await session.settle();
    const labels = session.walkRows().map((row) => row.label);
    expect(labels).toContain("Handover");
    // A run that never launched has no session to read.
    expect(labels).not.toContain("Export");

    session.open("Handover");
    await session.settle();

    expect(aborted).toEqual([]);
    expect(session.closedScreens).toHaveLength(1);
    expect(session.notifications.at(-1)).toEqual({
      message:
        "✓ Agent dead0000-queued was not exported: it never started, so there is no session to export.",
      kind: "warning",
    });
  });

  it("asks before stopping a running agent, and leaves it running when declined", async () => {
    installManager([spawnedSpawn()]);
    const session = openAgentStatus();

    session.open(/◈ abcd1234-spawned-id/);
    await session.settle();
    session.open("Handover");

    expect(session.text()).toContain(
      "Agent abcd1234-spawned-id is still running.",
    );
    expect(session.text()).toContain(
      "pi-cowboy will need to stop it before it can be handed over. Proceed?",
    );
    expect(aborted).toEqual([]);

    session.press("n");
    await session.settle();

    // The decline returns to the agent's own actions, still running.
    expect(aborted).toEqual([]);
    expect(session.closedScreens).toEqual([]);
    expect(session.walkRows().map((row) => row.label)).toContain("Handover");
  });

  it("stops the run on Y, then offers the handover targets", async () => {
    setHarnessAvailability(probed(["pi", "claude"]));
    const spawn = spawnedSpawn();
    installManager([spawn]);
    abortImpl = () => {
      settleStopped(spawn);
      return Promise.resolve(true);
    };
    const session = openAgentStatus();

    session.open(/◈ abcd1234-spawned-id/);
    await session.settle();
    session.open("Handover");
    session.press("y");
    await session.settle();

    expect(aborted).toEqual(["abcd1234-spawned-id"]);
    expect(session.notifications.map((n) => n.message)).toEqual([
      "Stopping agent abcd1234-spawned-id …",
      "✓ Stopped agent abcd1234-spawned-id",
    ]);
    expect(session.walkRows().map((row) => row.label)).toEqual([
      "Hand over to Claude",
    ]);

    session.open("Hand over to Claude");
    await session.settle();

    expect(handedOver).toEqual([
      { id: "abcd1234-spawned-id", harness: "claude" },
    ]);
  });

  it("reports a stop that failed and opens nothing", async () => {
    installManager([spawnedSpawn()]);
    abortImpl = () => Promise.reject(new Error("herdr unreachable"));
    const session = openAgentStatus();

    session.open(/◈ abcd1234-spawned-id/);
    await session.settle();
    session.open("Handover");
    session.press("y");
    await session.settle();

    expect(session.closedScreens).toHaveLength(1);
    expect(session.notifications.at(-1)).toEqual({
      message: "✗ Failed to stop agent abcd1234-spawned-id: herdr unreachable",
      kind: "error",
    });
  });

  it("reports a run the stop left active instead of dangling it", async () => {
    installManager([spawnedSpawn()]);
    const session = openAgentStatus();

    session.open(/◈ abcd1234-spawned-id/);
    await session.settle();
    session.open("Handover");
    session.press("y");
    await session.settle();

    expect(session.closedScreens).toHaveLength(1);
    expect(session.notifications.at(-1)).toEqual({
      message:
        "✗ Failed to stop agent abcd1234-spawned-id: the run is still active, so there is no finished session to hand over yet",
      kind: "error",
    });
    expect(handedOver).toEqual([]);
  });

  it("lists the launchable harnesses without the source", async () => {
    setHarnessAvailability(probed(["pi", "claude"]));
    installManager([completedSpawn("beef5678-completed")]);
    const session = openAgentStatus();

    session.open(/✓ beef5678-completed/);
    await session.settle();
    session.open("Handover");

    expect(session.walkRows().map((row) => row.label)).toEqual([
      "Hand over to Claude",
    ]);
  });

  it("reports an agent no other harness can take over", async () => {
    setHarnessAvailability(probed(["pi"]));
    installManager([completedSpawn("beef5678-completed")]);
    const session = openAgentStatus();

    session.open(/✓ beef5678-completed/);
    await session.settle();
    session.open("Handover");

    expect(session.closedScreens).toHaveLength(1);
    expect(session.notifications.at(-1)).toEqual({
      message:
        "✓ Agent beef5678-completed was not handed over: no other harness can take it over.",
      kind: "warning",
    });
  });

  it("reports a source harness that cannot export, without opening the submenu", async () => {
    registerPluginWithoutReader("reg-no-export");
    installManager([
      baseSpawn({
        id: "face1234-plugin",
        lifecycle: {
          phase: "settled",
          startedAt: Date.now(),
          status: "completed",
          result: "done",
          completedAt: Date.now(),
        },
        harness: "reg-no-export",
      }),
    ]);
    const session = openAgentStatus();

    session.open(/✓ face1234-plugin/);
    await session.settle();
    session.open("Handover");
    await session.settle();

    expect(session.closedScreens).toHaveLength(1);
    expect(session.notifications.at(-1)).toEqual({
      message:
        '✓ Agent face1234-plugin was not exported: harness "reg-no-export" cannot export its own session, so there is nothing to write.',
      kind: "warning",
    });
  });

  it("hands the agent over to the picked harness and closes the menu", async () => {
    setHarnessAvailability(probed(["pi", "claude"]));
    installManager([completedSpawn("beef5678-completed")]);
    const session = openAgentStatus();

    session.open(/✓ beef5678-completed/);
    await session.settle();
    session.open("Handover");
    session.open("Hand over to Claude");
    await session.settle();

    expect(handedOver).toEqual([
      { id: "beef5678-completed", harness: "claude" },
    ]);
    expect(session.closedScreens).toHaveLength(1);
    expect(session.notifications.map((n) => n.message)).toEqual([
      "Handing agent beef5678-completed over to claude …",
      '✓ Agent beef5678-completed handed over from "pi" to "claude". The ended run is archived; the next one runs in the same checkout and reports when it settles.',
    ]);
  });
});

describe("Agent status — the export row", () => {
  it("hides Export for a harness with no record reader", async () => {
    registerPluginWithoutReader("reg-no-export");
    installManager([
      baseSpawn({
        id: "face1234-plugin",
        lifecycle: {
          phase: "settled",
          startedAt: Date.now(),
          status: "completed",
          result: "done",
          completedAt: Date.now(),
        },
        harness: "reg-no-export",
      }),
    ]);
    const session = openAgentStatus();

    session.open(/✓ face1234-plugin/);
    await session.settle();

    const labels = session.walkRows().map((row) => row.label);
    expect(labels).toContain("Handover");
    expect(labels).not.toContain("Export");
  });

  it("hides Export until the run has a pane to read from", async () => {
    installManager([
      baseSpawn({
        id: "feed0000-queued",
        lifecycle: { phase: "queued", queuedAt: Date.now() },
      }),
    ]);
    const session = openAgentStatus();

    session.open(/feed0000-queued/);
    await session.settle();

    expect(session.walkRows().map((row) => row.label)).not.toContain("Export");
  });

  it("offers Export for a run that is still working", async () => {
    setHarnessAvailability(probed(["pi", "claude"]));
    installManager([spawnedSpawn()]);
    const session = openAgentStatus();

    session.open(/◈ abcd1234-spawned-id/);
    await session.settle();

    expect(session.walkRows().map((row) => row.label)).toEqual([
      "View shell",
      "Handover",
      "Export",
      "Stop",
    ]);
  });
});

describe("Agent status — the merge row", () => {
  it("hides Merge for a run that is still working", async () => {
    installManager([spawnedSpawn()]);
    const session = openAgentStatus();

    session.open(/◈ abcd1234-spawned-id/);
    await session.settle();

    expect(session.walkRows().map((row) => row.label)).not.toContain("Merge");
  });

  it("hides Merge when the branch has nothing main lacks", async () => {
    merge.readiness = () => Promise.resolve("nothing");
    installManager([completedSpawn("beef5678-completed")]);
    const session = openAgentStatus();

    session.open(/✓ beef5678-completed/);
    await session.settle();

    expect(session.walkRows().map((row) => row.label)).not.toContain("Merge");
  });

  it("keeps Merge when the readiness probe could not answer", async () => {
    merge.readiness = () => Promise.resolve("unknown");
    installManager([completedSpawn("beef5678-completed")]);
    const session = openAgentStatus();

    session.open(/✓ beef5678-completed/);
    await session.settle();

    expect(session.walkRows().map((row) => row.label)).toContain("Merge");
  });

  it("hides Merge for an agent with no worktree branch", async () => {
    installManager([errorSpawn("cafe9999-errored")]);
    const session = openAgentStatus();

    session.open(/✗ cafe9999-errored/);
    await session.settle();

    expect(session.walkRows().map((row) => row.label)).not.toContain("Merge");
  });

  it("merges the agent's branch through the tool's own path and reports it", async () => {
    installManager([completedSpawn("beef5678-completed")]);
    const session = openAgentStatus();
    session.open(/✓ beef5678-completed/);
    await session.settle();

    session.open("Merge");
    await session.settle();

    expect(merge.merged).toEqual(["cow-fix-login-abcd1234"]);
    expect(session.notifications.map((n) => n.message)).toEqual([
      "Merging agent beef5678-completed's branch cow-fix-login-abcd1234 …",
      '✓ Merged "cow-fix-login-abcd1234" into "main".',
    ]);
  });

  it("reports an already-merged branch as a warning", async () => {
    merge.merge = () =>
      Promise.resolve({
        outcome: {
          kind: "already-merged",
          branch: "cow-fix-login-abcd1234",
          target: "main",
        },
        text: '"cow-fix-login-abcd1234" is already merged into "main" — nothing to do.',
      });
    installManager([completedSpawn("beef5678-completed")]);
    const session = openAgentStatus();
    session.open(/✓ beef5678-completed/);
    await session.settle();

    session.open("Merge");
    await session.settle();

    expect(session.notifications.at(-1)).toEqual({
      message:
        '✓ "cow-fix-login-abcd1234" is already merged into "main" — nothing to do.',
      kind: "warning",
    });
  });

  it("reports a merge that threw and keeps the row", async () => {
    merge.merge = () => Promise.reject(new Error("the main checkout is dirty"));
    installManager([completedSpawn("beef5678-completed")]);
    const session = openAgentStatus();
    session.open(/✓ beef5678-completed/);
    await session.settle();

    session.open("Merge");
    await session.settle();

    expect(session.notifications.at(-1)).toEqual({
      message:
        "✗ Failed to merge agent beef5678-completed's branch cow-fix-login-abcd1234: the main checkout is dirty",
      kind: "error",
    });
    expect(session.walkRows().map((row) => row.label)).toContain("Merge");
  });

  it("retires the row once the merge lands", async () => {
    let readiness: "pending" | "nothing" = "pending";
    merge.readiness = () => Promise.resolve(readiness);
    merge.merge = () => {
      readiness = "nothing";
      return Promise.resolve(MERGED_RESULT);
    };
    installManager([completedSpawn("beef5678-completed")]);
    const session = openAgentStatus();
    session.open(/✓ beef5678-completed/);
    await session.settle();

    session.open("Merge");
    await session.settle();

    expect(merge.merged).toEqual(["cow-fix-login-abcd1234"]);
    const labels = session.walkRows().map((row) => row.label);
    expect(labels).not.toContain("Merge");
    expect(labels).toContain("Handover");
  });
});

describe("Agent status — open result file", () => {
  const execs: Array<{ command: string; args: readonly string[] }> = [];
  const staged: string[] = [];
  let platform: ReturnType<typeof vi.spyOn>;

  /** Write the run's report where the extension derives it from the id. */
  function writeResultFile(id: string, content = "all done"): string {
    const file = subagentResultFileFor(id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    staged.push(id);
    return file;
  }

  beforeEach(() => {
    platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    execs.length = 0;
    setPi({
      exec: (command: string, args: readonly string[]) => {
        execs.push({ command, args });
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    });
  });

  afterEach(() => {
    platform.mockRestore();
    for (const id of staged.splice(0)) {
      rmSync(subagentResultDirFor(id), { recursive: true, force: true });
    }
  });

  it("offers the row before Merge once the report has content", async () => {
    installManager([completedSpawn("beef5678-completed")]);
    writeResultFile("beef5678-completed");
    const session = openAgentStatus();

    session.open(/✓ beef5678-completed/);
    await session.settle();

    expect(session.walkRows().map((row) => row.label)).toEqual([
      "View shell",
      "View result",
      "Open result file",
      "Merge",
      "Handover",
      "Export",
      "Clean up",
    ]);
  });

  it("hides the row without a non-empty report", async () => {
    installManager([completedSpawn("beef5678-completed")]);
    const session = openAgentStatus();

    session.open(/✓ beef5678-completed/);
    await session.settle();

    expect(session.walkRows().map((row) => row.label)).not.toContain(
      "Open result file",
    );
  });

  it("hides the row off macOS", async () => {
    platform.mockReturnValue("linux");
    installManager([completedSpawn("beef5678-completed")]);
    writeResultFile("beef5678-completed");
    const session = openAgentStatus();

    session.open(/✓ beef5678-completed/);
    await session.settle();

    expect(session.walkRows().map((row) => row.label)).not.toContain(
      "Open result file",
    );
  });

  it("hands the file to `open` and reports it", async () => {
    installManager([completedSpawn("beef5678-completed")]);
    const file = writeResultFile("beef5678-completed");
    const session = openAgentStatus();
    session.open(/✓ beef5678-completed/);
    await session.settle();

    session.open("Open result file");
    await session.settle();

    expect(execs).toEqual([{ command: "open", args: [file] }]);
    expect(session.notifications.map((n) => n.message)).toEqual([
      "Opening agent beef5678-completed's result file …",
      `✓ Opened agent beef5678-completed's result file ${file}`,
    ]);
  });

  it("reports an `open` that failed", async () => {
    setPi({
      exec: () =>
        Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "no application knows how to open",
        }),
    });
    installManager([completedSpawn("beef5678-completed")]);
    writeResultFile("beef5678-completed");
    const session = openAgentStatus();
    session.open(/✓ beef5678-completed/);
    await session.settle();

    session.open("Open result file");
    await session.settle();

    expect(session.notifications.at(-1)).toEqual({
      message:
        "✗ Failed to open agent beef5678-completed's result file: no application knows how to open",
      kind: "error",
    });
  });
});

describe("Agent status — result viewer overlay", () => {
  const RESULT = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");

  async function openViewer(text: string): Promise<MenuSession> {
    installManager([completedSpawn("beef5678-completed", text)]);
    const session = openAgentStatus();
    session.open(/✓ beef5678-completed/);
    await session.settle();
    session.open("View result");
    return session;
  }

  it("opens as an overlay showing the tail of the result", async () => {
    const session = await openViewer(RESULT);
    await session.settle();

    // The viewer is a second ctx.ui.custom screen on top of the menu.
    expect(session.screenCount).toBe(2);
    expect(session.text()).toContain("Agent · beef5678-completed");
    expect(session.text()).toContain("20 lines · 100%");
    expect(session.text()).toContain("q/Esc close");
    expect(session.text()).toContain("line 19");
    expect(session.text()).not.toContain("line 0");
  });

  it("scrolls to the top with g", async () => {
    const session = await openViewer(RESULT);
    await session.settle();

    session.press("g");

    expect(session.text()).toContain("line 0");
    expect(session.text()).toContain("55%");
    expect(session.text()).not.toContain("line 19");
  });

  it("scrolls a line at a time with the arrow keys", async () => {
    const session = await openViewer(RESULT);
    await session.settle();

    session.press("g");
    expect(session.text()).not.toContain("line 11");

    session.press(KEY.down);
    expect(session.text()).toContain("line 11");

    session.press(KEY.up);
    expect(session.text()).not.toContain("line 11");
    expect(session.text()).toContain("line 0");
  });

  it("closes on q without leaving the menu", async () => {
    const session = await openViewer(RESULT);
    await session.settle();

    session.press("q");
    await session.settle();

    expect(session.closedScreens).toEqual([1]);
  });

  it("closes on Esc", async () => {
    const session = await openViewer(RESULT);
    await session.settle();

    session.press(KEY.escape);
    await session.settle();

    expect(session.closedScreens).toEqual([1]);
  });

  it("shows a short result without a scroll indicator below 100%", async () => {
    const session = await openViewer("just one line");
    await session.settle();

    expect(session.text()).toContain("1 lines · 100%");
    expect(session.text()).toContain("just one line");
  });
});
