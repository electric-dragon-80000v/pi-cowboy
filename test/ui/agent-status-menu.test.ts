/**
 * agent-status-menu.test.ts — agent-status menu rows and the calls it makes.
 * Manager/runtime are structural fakes (listAgents, abort, cleanup, view.focus).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentSpawn } from "../../src/types.js";
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
import { resetShell, setCoordinator, setPi, shellState } from "./shell-mock.js";

vi.mock("../../src/shell.js", () => import("./shell-mock.js"));

const { showAgentStatusMenu } =
  await import("../../src/ui/menu/menu-agent-status.js");

/** Host address marking a live pane. */
const HOST = {
  multiplexer: "herdr" as const,
  name: "cow-fix-login-abcd1234",
  paneId: "pane-1",
  tabId: "tab-1",
  workspaceId: "ws-1",
  paneCreated: true,
};

function baseSpawn(overrides: {
  id: string;
  lifecycle: AgentSpawn["lifecycle"];
  description?: string;
  host?: boolean;
  worktree?: boolean;
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

const aborted: string[] = [];
const cleanedUp: string[] = [];
const cleanupOpts: Array<{ id: string; force: boolean }> = [];
const focused: string[] = [];
/** Next abort verdict, per id (stopped unless set). */
let abortImpl: (id: string) => Promise<boolean> = () => Promise.resolve(true);

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
  };
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
  abortImpl = () => Promise.resolve(true);
  cleanupImpl = (id) => Promise.resolve(fullTeardown(id));
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
      /◈ abcd1234-spawned-id\s+• general-purpose\s+spawned\s+<1s\s+wt:cow-fix-login-abcd1234/,
    );
    expect(text).toMatch(
      /✓ beef5678-completed\s+• general-purpose\s+completed\s+<1s/,
    );
    expect(text).toContain("— Fix the login flow");
  });

  it("offers the group actions that match the listed agents", () => {
    installManager([
      spawnedSpawn(),
      completedSpawn("beef5678-completed"),
      errorSpawn("cafe9999-errored"),
    ]);
    const session = openAgentStatus();

    const labels = session.walkRows().map((row) => row.label);
    expect(labels).toEqual([
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
    expect(labels).not.toContain("✓ cafe9999-errored");
    expect(labels).toContain("✗ cafe9999-errored");
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
      "✓ Cleaned up agent beef5678-completed: pane closed, worktree removed (/repo/.worktrees/fix-login), branch deleted (cow-fix-login-abcd1234)",
      "✓ Cleaned up agent cafe9999-errored: pane closed, worktree removed (/repo/.worktrees/fix-login), branch deleted (cow-fix-login-abcd1234)",
    ]);
  });
});

describe("Agent status — the per-agent actions list", () => {
  it("offers the live actions for a spawned agent", () => {
    installManager([spawnedSpawn()]);
    const session = openAgentStatus();

    session.open("◈ abcd1234-spawned-id");

    // A healthy run has neither result nor error, so no viewer entry.
    expect(session.walkRows().map((row) => row.label)).toEqual([
      "View shell",
      "Stop",
    ]);
  });

  it("offers clean up instead of stop for a settled agent", () => {
    installManager([completedSpawn("beef5678-completed")]);
    const session = openAgentStatus();

    session.open("✓ beef5678-completed");

    const labels = session.walkRows().map((row) => row.label);
    expect(labels).toEqual(["View shell", "View result", "Clean up"]);
    session.focus("Clean up");
    expect(session.text()).toContain(
      "Close its pane and remove its worktree and merged branch",
    );
  });

  it("offers View error only for a failed agent", () => {
    installManager([errorSpawn("cafe9999-errored")]);
    const session = openAgentStatus();

    session.open("✗ cafe9999-errored");

    expect(session.walkRows().map((row) => row.label)).toEqual([
      "View shell",
      "View error",
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
    session.open("◈ abcd1234-spawned-id");

    session.open("Stop");

    // The list comes back with the stop still in flight, then the verdict lands.
    expect(session.activeRow()?.label).toBe("◈ abcd1234-spawned-id");
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
    session.open("◈ abcd1234-spawned-id");

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
    session.open("◈ abcd1234-spawned-id");

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
    session.open("✓ beef5678-completed");

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
    session.open("✓ beef5678-completed");

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
    session.open("✓ beef5678-completed");

    session.open("Clean up");
    await session.settle();
    session.press(KEY.escape);
    await session.settle();

    // No forced pass; the refusal is reported and the menu refreshes in place.
    expect(cleanupOpts).toEqual([{ id: "beef5678-completed", force: false }]);
    expect(session.closedScreens).toEqual([]);
    expect(session.activeRow()?.label).toBe("✓ beef5678-completed");
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
    session.open("✓ beef5678-completed");

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
    session.open("◈ abcd1234-spawned-id");

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
    session.open("◈ abcd1234-spawned-id");

    session.open("View shell");
    await session.settle();

    expect(session.notifications.at(-1)).toEqual({
      message:
        "✗ Failed to focus agent abcd1234-spawned-id's herdr pane: tab closed",
      kind: "error",
    });
  });
});

describe("Agent status — result viewer overlay", () => {
  const RESULT = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");

  function openViewer(text: string): MenuSession {
    installManager([completedSpawn("beef5678-completed", text)]);
    const session = openAgentStatus();
    session.open("✓ beef5678-completed");
    session.open("View result");
    return session;
  }

  it("opens as an overlay showing the tail of the result", async () => {
    const session = openViewer(RESULT);
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
    const session = openViewer(RESULT);
    await session.settle();

    session.press("g");

    expect(session.text()).toContain("line 0");
    expect(session.text()).toContain("55%");
    expect(session.text()).not.toContain("line 19");
  });

  it("scrolls a line at a time with the arrow keys", async () => {
    const session = openViewer(RESULT);
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
    const session = openViewer(RESULT);
    await session.settle();

    session.press("q");
    await session.settle();

    expect(session.closedScreens).toEqual([1]);
  });

  it("closes on Esc", async () => {
    const session = openViewer(RESULT);
    await session.settle();

    session.press(KEY.escape);
    await session.settle();

    expect(session.closedScreens).toEqual([1]);
  });

  it("shows a short result without a scroll indicator below 100%", async () => {
    const session = openViewer("just one line");
    await session.settle();

    expect(session.text()).toContain("1 lines · 100%");
    expect(session.text()).toContain("just one line");
  });
});
