import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SpawnCoordinator,
  findTaskDedup,
  TaskAlreadyInFlightError,
} from "../src/spawn/spawn-coordinator.js";
import { HerdrTaskRegistry, type LiveAttempt } from "../src/task-registry.js";
import type { AgentManager } from "../src/agents/agent-manager.js";
import { ACTIVE_AGENT_PHASES } from "../src/types.js";
import { getPiInstance, getSessionCtx } from "../src/shell.js";
import type { AgentSpawn } from "../src/types.js";
import { TEST_ORCHESTRATION } from "./helpers/orchestration.js";

const { findTaskAttemptsMock, getPiInstanceMock, isExtensionEnabledMock } =
  vi.hoisted(() => ({
    findTaskAttemptsMock: vi.fn(),
    getPiInstanceMock: vi.fn(),
    isExtensionEnabledMock: vi.fn(() => true),
  }));

vi.mock("../src/extension-toggle.js", () => ({
  isExtensionEnabled: isExtensionEnabledMock,
}));

vi.mock("../src/shell.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/shell.js")>()),
  getPiInstance: getPiInstanceMock,
  getSessionCtx: vi.fn(() => ({ isIdle: () => true })),
  getRuntime: () => ({
    host: {
      findAttempts: findTaskAttemptsMock,
    },
  }),
}));

/**
 * The registry a fake manager hands out: the real one over the fake's own
 * surface, as a production manager shares its registry with the coordinator.
 */
function registryFor(
  surface: Pick<AgentManager, "listAgents" | "spawn" | "getSpawn">,
): HerdrTaskRegistry {
  return new HerdrTaskRegistry({
    listAgents: () => surface.listAgents(ACTIVE_AGENT_PHASES),
    spawn: (type, prompt, options) =>
      surface.spawn(
        getPiInstance(),
        getSessionCtx() as ExtensionContext,
        type,
        prompt,
        options,
      ),
    getSpawn: (agentId) => surface.getSpawn(agentId),
    findTaskAttempts: (taskSlug) => findTaskAttemptsMock(taskSlug),
  });
}

/** Spawned-phase fixture. */
function spawnedSpawn(id: string, taskSlug: string): AgentSpawn {
  return {
    id,
    display: {
      type: "general-purpose",
      description: "some task",
      taskSlug,
      orchestration: TEST_ORCHESTRATION,
    },
    lifecycle: {
      phase: "spawned",
      startedAt: Date.now(),
    },
    execution: { promise: Promise.resolve("") },
  } as unknown as AgentSpawn;
}

/** Settled-spawn fixture, stopped by whoever asked for it. */
function stoppedSpawn(
  id: string,
  taskSlug: string,
  initiator: "user" | "agent",
): AgentSpawn {
  const spawn = spawnedSpawn(id, taskSlug);
  return {
    ...spawn,
    lifecycle: {
      phase: "settled",
      status: "stopped",
      startedAt: Date.now(),
      stop: { initiator },
    },
    execution: { promise: Promise.resolve("") },
  } as unknown as AgentSpawn;
}

/** Live, not-yet-started spawn: admitted, waiting for a concurrency slot. */
function queuedSpawn(id: string, taskSlug: string): AgentSpawn {
  const spawn = spawnedSpawn(id, taskSlug);
  return {
    ...spawn,
    lifecycle: { phase: "queued", queuedAt: Date.now() },
    execution: { promise: Promise.resolve("") },
  } as unknown as AgentSpawn;
}

/** A fake manager over the real registry, as a production manager serves the coordinator. */
function managerFor(spawn: AgentSpawn): AgentManager {
  const surface = {
    listAgents: vi.fn(() => []),
    spawn: vi.fn(() => spawn.id),
    getSpawn: vi.fn(() => spawn),
  };
  return {
    ...surface,
    getRegistry: () => registryFor(surface),
  } as unknown as AgentManager;
}

function liveAttempt(name: string): LiveAttempt {
  return { name };
}

describe("findTaskDedup", () => {
  it("returns none when the task has no live attempt", () => {
    expect(findTaskDedup([], [])).toEqual({ kind: "none" });
  });

  it("prefers the in-memory spawn over herdr attempts (freshest signal)", () => {
    const spawn = spawnedSpawn("r1", "fix-login-flow");
    const dedup = findTaskDedup(
      [spawn],
      [liveAttempt("cow-fix-login-flow-01234567")],
    );
    expect(dedup).toEqual({ kind: "spawn", spawn });
  });

  it("falls back to the live herdr attempt when no in-memory spawn exists (parent reload)", () => {
    const attempt = liveAttempt("cow-fix-login-flow-01234567");
    const dedup = findTaskDedup([], [attempt]);
    expect(dedup).toEqual({ kind: "herdr", attempt });
  });

  it("uses the first in-memory spawn when several share the slug", () => {
    const first = spawnedSpawn("r1", "fix-login-flow");
    const second = spawnedSpawn("r2", "fix-login-flow");
    expect(findTaskDedup([first, second], [])).toEqual({
      kind: "spawn",
      spawn: first,
    });
  });
});

describe("SpawnCoordinator.spawn dedup (verify-only)", () => {
  /**
   * A fake manager plus the spies behind its surface, so assertions read the
   * spy directly: `manager.spawn` is a method of the real type and referencing
   * it as a value would lose its binding.
   */
  function makeManager(spawn?: AgentSpawn) {
    const mocks = {
      listAgents: vi.fn(() => []),
      spawn: vi.fn(() => spawn?.id ?? "a1"),
      getSpawn: vi.fn(() => spawn),
    };
    const manager = {
      ...mocks,
      getRegistry: () => registryFor(mocks),
    } as unknown as AgentManager;
    return { manager, mocks };
  }

  function intent(overrides: Partial<{ taskSlug: string }> = {}) {
    return {
      type: "general-purpose",
      prompt: "do it",
      runInBackground: true,
      taskSlug: "fix-login-flow",
      ...overrides,
    } as never;
  }

  beforeEach(() => {
    findTaskAttemptsMock.mockReset();
    getPiInstanceMock.mockReset().mockReturnValue({});
  });

  it("blocks a live herdr attempt without touching it", async () => {
    const { manager, mocks } = makeManager();
    const coordinator = new SpawnCoordinator(manager);
    findTaskAttemptsMock.mockResolvedValue([
      liveAttempt("cow-fix-login-flow-01234567"),
    ]);
    await expect(
      coordinator.spawn({} as never, intent()),
    ).rejects.toBeInstanceOf(TaskAlreadyInFlightError);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("blocks an idle leftover attempt too — nothing is reclaimed", async () => {
    // Dedup is verify-only: the duplicate request fails, the leftover is untouched.
    const { manager, mocks } = makeManager();
    const coordinator = new SpawnCoordinator(manager);
    findTaskAttemptsMock.mockResolvedValue([
      liveAttempt("cow-fix-login-flow-01234567"),
    ]);
    await expect(
      coordinator.spawn({} as never, intent()),
    ).rejects.toBeInstanceOf(TaskAlreadyInFlightError);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("spawns when no spawn or herdr attempt exists", async () => {
    const spawn = {
      id: "a1",
      lifecycle: { phase: "spawned", startedAt: Date.now() },
      execution: { promise: Promise.resolve("") },
    } as unknown as AgentSpawn;
    const { manager, mocks } = makeManager(spawn);
    const coordinator = new SpawnCoordinator(manager);
    findTaskAttemptsMock.mockResolvedValue([]);
    const result = await coordinator.spawn({} as never, intent());
    expect(result.agentId).toBe("a1");
    expect(mocks.spawn).toHaveBeenCalled();
  });
});

describe("TaskAlreadyInFlightError", () => {
  it("names the in-memory agent and its status", () => {
    const spawn = spawnedSpawn("0123456789abcdef0", "fix-login-flow");
    const err = new TaskAlreadyInFlightError(
      { kind: "spawn", spawn },
      "fix-login-flow",
    );
    expect(err.name).toBe("TaskAlreadyInFlightError");
    expect(err.taskSlug).toBe("fix-login-flow");
    expect(err.dedup).toEqual({ kind: "spawn", spawn });
    expect(err.dedup.kind).toBe("spawn");
    expect(err.message).toContain("already in flight as agent 01234567");
    expect(err.message).toContain("state: spawned");
    expect(err.message).toContain("No second agent was spawned");
  });

  it("names the live backend attempt when the spawn is gone", () => {
    const attempt = liveAttempt("cow-fix-login-flow-01234567");
    const err = new TaskAlreadyInFlightError(
      { kind: "herdr", attempt },
      "fix-login-flow",
    );
    expect(err.dedup).toEqual({ kind: "herdr", attempt });
    expect(err.dedup.kind).toBe("herdr");
    if (err.dedup.kind === "herdr") {
      expect(err.dedup.attempt.name).toBe("cow-fix-login-flow-01234567");
    }
    expect(err.message).toContain(
      "already in flight as cow-fix-login-flow-01234567",
    );
    // The error reports only knowable state: a herdr attempt's prompt is never probed.
    expect(err.message).toContain("state: live");
  });
});

describe("SpawnCoordinator completion nudges", () => {
  const NUDGE_WINDOW_MS = 200;

  /** Parent session fixture: `idle` states whether the orchestrator's turn is over. */
  function parentSession(idle: boolean): ExtensionContext {
    return { isIdle: () => idle } as unknown as ExtensionContext;
  }

  function intent(runInBackground: boolean) {
    return {
      type: "general-purpose",
      prompt: "do it",
      runInBackground,
      taskSlug: "fix-login-flow",
    } as never;
  }

  beforeEach(() => {
    findTaskAttemptsMock.mockReset().mockResolvedValue([]);
    getPiInstanceMock.mockReset();
    isExtensionEnabledMock.mockReset().mockReturnValue(true);
    vi.mocked(getSessionCtx).mockReturnValue(parentSession(true));
  });

  it("emits no nudge while the extension is disabled", async () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      getPiInstanceMock.mockReturnValue({ sendMessage });
      isExtensionEnabledMock.mockReturnValue(false);
      const spawn = spawnedSpawn("bg-off", "fix-login-flow");
      const coordinator = new SpawnCoordinator(managerFor(spawn));
      await coordinator.spawn({} as never, intent(true));

      coordinator.onAgentComplete(spawn);
      vi.advanceTimersByTime(NUDGE_WINDOW_MS);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("nudges on every settlement of a background agent, not only the first", async () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      getPiInstanceMock.mockReturnValue({ sendMessage });
      const spawn = spawnedSpawn("bg1", "fix-login-flow");
      const coordinator = new SpawnCoordinator(managerFor(spawn));
      await coordinator.spawn({} as never, intent(true));

      coordinator.onAgentComplete(spawn);
      vi.advanceTimersByTime(NUDGE_WINDOW_MS);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "subagent-result" }),
        { deliverAs: "followUp", triggerTurn: true },
      );

      // Steered by the parent, then settled a second time: still news.
      coordinator.onAgentComplete(spawn);
      vi.advanceTimersByTime(NUDGE_WINDOW_MS);
      expect(sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues the nudge as a follow-up while the orchestrator is mid-turn", async () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      getPiInstanceMock.mockReturnValue({ sendMessage });
      vi.mocked(getSessionCtx).mockReturnValue(parentSession(false));
      const spawn = spawnedSpawn("bg-busy", "fix-login-flow");
      const coordinator = new SpawnCoordinator(managerFor(spawn));
      await coordinator.spawn({} as never, intent(true));

      coordinator.onAgentComplete(spawn);
      vi.advanceTimersByTime(NUDGE_WINDOW_MS);

      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "subagent-result" }),
        { deliverAs: "followUp", triggerTurn: true },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not nudge a stop the parent agent ordered itself", async () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      getPiInstanceMock.mockReturnValue({ sendMessage });
      const spawn = stoppedSpawn("stopped-by-agent", "fix-login-flow", "agent");
      const coordinator = new SpawnCoordinator(managerFor(spawn));
      await coordinator.spawn({} as never, intent(true));

      // stop_cowboy_agent returned this settlement to the caller that asked for it.
      coordinator.onAgentComplete(spawn);
      vi.advanceTimersByTime(NUDGE_WINDOW_MS);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still nudges a stop the parent did not order", async () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      getPiInstanceMock.mockReturnValue({ sendMessage });
      const spawn = stoppedSpawn("stopped-by-user", "fix-login-flow", "user");
      const coordinator = new SpawnCoordinator(managerFor(spawn));
      await coordinator.spawn({} as never, intent(true));

      coordinator.onAgentComplete(spawn);
      vi.advanceTimersByTime(NUDGE_WINDOW_MS);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers a settled agent's later report as news, carrying the report itself", async () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      getPiInstanceMock.mockReturnValue({ sendMessage });
      const spawn = spawnedSpawn("bg3", "fix-login-flow");
      const coordinator = new SpawnCoordinator(managerFor(spawn));
      await coordinator.spawn({} as never, intent(true));

      coordinator.onAgentFollowUp(spawn, "the agent kept going");
      vi.advanceTimersByTime(NUDGE_WINDOW_MS);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "subagent-result",
          content: expect.stringContaining("the agent kept going"),
        }),
        { deliverAs: "followUp", triggerTurn: true },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rides one batch window with the settlement and keeps only the newest report", async () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      getPiInstanceMock.mockReturnValue({ sendMessage });
      const spawn = spawnedSpawn("bg4", "fix-login-flow");
      const coordinator = new SpawnCoordinator(managerFor(spawn));
      await coordinator.spawn({} as never, intent(true));

      coordinator.onAgentComplete(spawn);
      coordinator.onAgentFollowUp(spawn, "first draft");
      coordinator.onAgentFollowUp(spawn, "second draft");
      vi.advanceTimersByTime(NUDGE_WINDOW_MS);

      // The settlement and the report are two messages; the report is the latest.
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage.mock.calls[1]![0].content).toContain("second draft");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reports a later report for a foreground agent", async () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      getPiInstanceMock.mockReturnValue({ sendMessage });
      const spawn = spawnedSpawn("fg2", "fix-login-flow");
      const coordinator = new SpawnCoordinator(managerFor(spawn));
      await coordinator.spawn({} as never, intent(false));

      coordinator.onAgentFollowUp(spawn, "nobody is waiting for this");
      vi.advanceTimersByTime(NUDGE_WINDOW_MS);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers a later report even after cleanup dropped the settlement's nudge", async () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      getPiInstanceMock.mockReturnValue({ sendMessage });
      const spawn = spawnedSpawn("bg5", "fix-login-flow");
      const coordinator = new SpawnCoordinator(managerFor(spawn));
      await coordinator.spawn({} as never, intent(true));

      // Dropping the settlement's own nudge says nothing about the agent: a run
      // that survives its cleanup keeps reporting, and each report is added as
      // news on the same window.
      coordinator.dropNudge(spawn.id);
      coordinator.onAgentFollowUp(spawn, "the run kept going");
      vi.advanceTimersByTime(NUDGE_WINDOW_MS);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]![0].content).toContain(
        "the run kept going",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a pending nudge once cleanup takes over, and a later settlement nudges again", async () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      getPiInstanceMock.mockReturnValue({ sendMessage });
      const spawn = spawnedSpawn("bg2", "fix-login-flow");
      const coordinator = new SpawnCoordinator(managerFor(spawn));
      await coordinator.spawn({} as never, intent(true));

      // Cleanup starts inside the batch window: the settlement is already reported.
      coordinator.onAgentComplete(spawn);
      coordinator.dropNudge(spawn.id);
      vi.advanceTimersByTime(NUDGE_WINDOW_MS);
      expect(sendMessage).not.toHaveBeenCalled();

      // A later settlement of the same id is news again.
      coordinator.onAgentComplete(spawn);
      vi.advanceTimersByTime(NUDGE_WINDOW_MS);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a later report already queued when cleanup takes over, and reports the next one", async () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      getPiInstanceMock.mockReturnValue({ sendMessage });
      const spawn = spawnedSpawn("bg6", "fix-login-flow");
      const coordinator = new SpawnCoordinator(managerFor(spawn));
      await coordinator.spawn({} as never, intent(true));

      // The report lands inside the batch window, then cleanup starts.
      coordinator.onAgentFollowUp(spawn, "too late");
      coordinator.dropNudge(spawn.id);
      vi.advanceTimersByTime(NUDGE_WINDOW_MS);
      expect(sendMessage).not.toHaveBeenCalled();

      // A report that arrives after the drop is queued afresh.
      coordinator.onAgentFollowUp(spawn, "still here");
      vi.advanceTimersByTime(NUDGE_WINDOW_MS);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]![0].content).toContain("still here");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never nudges for a foreground spawn's settlement", async () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      getPiInstanceMock.mockReturnValue({ sendMessage });
      const spawn = spawnedSpawn("fg1", "fix-login-flow");
      const coordinator = new SpawnCoordinator(managerFor(spawn));
      await coordinator.spawn({} as never, intent(false));

      coordinator.onAgentComplete(spawn);
      vi.advanceTimersByTime(NUDGE_WINDOW_MS);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SpawnCoordinator spawn announcement", () => {
  /** A parent context with a UI, plus the sink its notifications land in. */
  function uiContext(hasUI = true) {
    const notify = vi.fn();
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    return {
      notify,
      ctx: { hasUI, ui: { notify, theme } } as unknown as ExtensionContext,
    };
  }

  function intent(runInBackground: boolean) {
    return {
      type: "general-purpose",
      prompt: "do it",
      runInBackground,
      taskSlug: "fix-login-flow",
    } as never;
  }

  beforeEach(() => {
    findTaskAttemptsMock.mockReset().mockResolvedValue([]);
    getPiInstanceMock.mockReset().mockReturnValue({});
  });

  it("announces the spawn it admitted, naming the id stop/cleanup take", async () => {
    const spawn = spawnedSpawn("0123456789abcdef0", "fix-login-flow");
    const { ctx, notify } = uiContext();

    await new SpawnCoordinator(managerFor(spawn)).spawn(ctx, intent(true));

    expect(notify).toHaveBeenCalledWith(
      "✓ Spawned agent 0123456789abcdef0 (general-purpose)",
      "info",
    );
  });

  it("announces a queued spawn as waiting rather than spawned", async () => {
    const spawn = queuedSpawn("queued1", "fix-login-flow");
    const { ctx, notify } = uiContext();

    await new SpawnCoordinator(managerFor(spawn)).spawn(ctx, intent(true));

    expect(notify).toHaveBeenCalledWith(
      "✓ Queued agent queued1 (general-purpose)",
      "info",
    );
  });

  it("announces before a foreground spawn waits for its result", async () => {
    let settle: () => void = () => {};
    const spawn = {
      ...spawnedSpawn("fg-announced", "fix-login-flow"),
      execution: {
        promise: new Promise<string>((resolve) => {
          settle = () => resolve("");
        }),
      },
    } as unknown as AgentSpawn;
    const { ctx, notify } = uiContext();
    const coordinator = new SpawnCoordinator(managerFor(spawn));

    const pending = coordinator.spawn(ctx, intent(false));
    // The settlement never arrived, so an announcement can only have been made
    // on the way to the wait.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(notify).toHaveBeenCalledTimes(1);
    settle();
    await pending;
  });

  it("stays silent when the parent has no UI to notify", async () => {
    const spawn = spawnedSpawn("headless1", "fix-login-flow");
    const { ctx, notify } = uiContext(false);

    await new SpawnCoordinator(managerFor(spawn)).spawn(ctx, intent(true));

    expect(notify).not.toHaveBeenCalled();
  });

  it("stays silent for a spawn that settled on admission", async () => {
    const spawn = stoppedSpawn("aborted1", "fix-login-flow", "user");
    const { ctx, notify } = uiContext();

    await new SpawnCoordinator(managerFor(spawn)).spawn(ctx, intent(true));

    expect(notify).not.toHaveBeenCalled();
  });
});
