/**
 * spawn-adoption.test.ts — materialising the store from the session at start.
 * The two directions are one condition each: an empty store restores from the
 * branch, a populated store seeds a branch that does not know it.
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentSpawn } from "../src/types.js";
import { AgentSpawnStore } from "../src/agents/agent-spawn-store.js";
import {
  adoptSpawnRecords,
  RELOAD_QUEUED_MESSAGE,
} from "../src/agents/spawn-adoption.js";
import {
  createSpawnJournal,
  type SpawnJournal,
} from "../src/agents/spawn-journal.js";
import type { SpawnJournalEntry } from "../src/agents/spawn-record.js";
import { TEST_ORCHESTRATION } from "./helpers/orchestration.js";

/** The verdict source a test uses when it is not the subject: adopt as recorded. */
const TRUSTING = async () => ({ kind: "adopt-live" }) as const;

/** A spawn in the phase a test asks for. */
function spawn(
  id: string,
  lifecycle: AgentSpawn["lifecycle"] = {
    phase: "spawned",
    startedAt: 1_700_000_000_000,
  },
): AgentSpawn {
  return {
    id,
    lifecycle,
    display: {
      type: "general-purpose",
      description: `task ${id}`,
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

/** A journal over a fixed branch, recording everything it appends. */
function harness(branch: readonly unknown[] = []) {
  const appended: SpawnJournalEntry[] = [];
  const journal: SpawnJournal = createSpawnJournal({
    append: (entry) => {
      appended.push(entry);
    },
    readBranch: () => branch,
    now: () => 5_000,
  });
  return { journal, appended };
}

/** Encode one spawn into a branch entry, as a previous session would have. */
function entryFor(spawn_: AgentSpawn, writtenAt = 1): unknown {
  const appended: SpawnJournalEntry[] = [];
  createSpawnJournal({
    append: (entry) => appended.push(entry),
    readBranch: () => [],
    now: () => writtenAt,
  }).record(spawn_);
  return {
    type: "custom",
    customType: "pi-cowboy.spawn-journal",
    data: appended[0],
    id: "e1",
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

describe("a reload: an empty store over a remembered branch", () => {
  it("restores every remembered spawn and writes nothing back", async () => {
    const { journal, appended } = harness([
      entryFor(spawn("aaaaaaaa")),
      entryFor(spawn("bbbbbbbb")),
    ]);
    const store = new AgentSpawnStore();

    await adoptSpawnRecords({ journal, store, verdictOf: TRUSTING });

    expect(store.list().map((s) => s.id)).toEqual(["aaaaaaaa", "bbbbbbbb"]);
    // The branch already holds them; re-writing would double the file per reload.
    expect(appended).toEqual([]);
  });

  it("restores the fields a later session reads: result, worktree, placement", async () => {
    const settled: AgentSpawn = {
      ...spawn("aaaaaaaa", {
        phase: "settled",
        startedAt: 1,
        status: "completed",
        result: "the report",
        completedAt: 2,
      }),
      display: {
        type: "general-purpose",
        description: "fix it",
        taskSlug: "fix-it",
        orchestration: TEST_ORCHESTRATION,
        worktree: {
          kind: "owned",
          path: "/repo/wt",
          branch: "cow-fix-it-aaaaaaaa",
        },
      },
      execution: {
        promise: Promise.resolve(""),
        abortController: new AbortController(),
        history: [],
        host: {
          multiplexer: "herdr",
          name: "cow-fix-it-aaaaaaaa",
          paneId: "w1:p1",
          workspaceId: "w1",
          paneCreated: true,
        },
      },
    };
    const store = new AgentSpawnStore();

    await adoptSpawnRecords({
      journal: harness([entryFor(settled)]).journal,
      store,
      verdictOf: TRUSTING,
    });

    const restored = store.get("aaaaaaaa")!;
    expect(restored.lifecycle).toMatchObject({
      phase: "settled",
      status: "completed",
      result: "the report",
    });
    expect(restored.display.worktree?.branch).toBe("cow-fix-it-aaaaaaaa");
    expect(restored.execution.host?.paneId).toBe("w1:p1");
    // The minted half is live again, so a stop has a controller to abort.
    expect(restored.execution.abortController.signal.aborted).toBe(false);
  });

  it("ends a restored queue entry, because the queue it waited on is gone", async () => {
    const { journal, appended } = harness([
      entryFor(spawn("aaaaaaaa", { phase: "queued", queuedAt: 1_234 })),
    ]);
    const store = new AgentSpawnStore();

    await adoptSpawnRecords({ journal, store, verdictOf: TRUSTING });

    const restored = store.get("aaaaaaaa")!;
    expect(restored.lifecycle).toMatchObject({
      phase: "never-started",
      queuedAt: 1_234,
      status: "error",
      error: RELOAD_QUEUED_MESSAGE,
    });
    // Stamped when the reload happened, which is when that queue entry died.
    expect(restored.lifecycle).not.toHaveProperty("startedAt");
    // Written once, so the demotion does not re-stamp its clock on every reload.
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      kind: "spawn",
      at: 5_000,
      record: { id: "aaaaaaaa" },
    });
  });

  it("leaves a spawn the branch forgot tombstoned", async () => {
    const remembered = spawn("aaaaaaaa");
    const { journal } = harness([
      entryFor(remembered),
      {
        type: "custom",
        customType: "pi-cowboy.spawn-journal",
        data: { v: 1, kind: "forgotten", spawnId: "aaaaaaaa", at: 2 },
      },
    ]);
    const store = new AgentSpawnStore();

    await adoptSpawnRecords({ journal, store, verdictOf: TRUSTING });

    expect(store.list()).toEqual([]);
  });
});

describe("a replacement session: a populated store over a fresh branch", () => {
  it("seeds the branch with every spawn it still tracks", async () => {
    const { journal, appended } = harness([]);
    const store = new AgentSpawnStore();
    store.add(spawn("aaaaaaaa"));
    store.add(spawn("bbbbbbbb"));

    await adoptSpawnRecords({ journal, store, verdictOf: TRUSTING });

    expect(
      appended.map((e) => (e.kind === "spawn" ? e.record.id : null)),
    ).toEqual(["aaaaaaaa", "bbbbbbbb"]);
  });

  it("writes only the spawns the branch has never heard of", async () => {
    const { journal, appended } = harness([entryFor(spawn("aaaaaaaa"))]);
    const store = new AgentSpawnStore();
    store.add(spawn("aaaaaaaa"));
    store.add(spawn("bbbbbbbb"));

    await adoptSpawnRecords({ journal, store, verdictOf: TRUSTING });

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ record: { id: "bbbbbbbb" } });
  });

  it("keeps the spawn the process tracks instead of overwriting it from the record", async () => {
    const live = spawn("aaaaaaaa", { phase: "spawned", startedAt: 9 });
    const { journal } = harness([entryFor(spawn("aaaaaaaa"))]);
    const store = new AgentSpawnStore();
    store.add(live);

    await adoptSpawnRecords({ journal, store, verdictOf: TRUSTING });

    // Same object, same run: the record is a backup, never the truth while live.
    expect(store.get("aaaaaaaa")).toBe(live);
    expect(live.lifecycle).toMatchObject({ startedAt: 9 });
  });
});

describe("hostile input", () => {
  it("restores what it can and reports a record it cannot, without throwing", async () => {
    const notify = vi.fn();
    const { journal } = harness([
      entryFor(spawn("aaaaaaaa")),
      // A record whose display is unusable: the id must not be silently reused.
      {
        type: "custom",
        customType: "pi-cowboy.spawn-journal",
        data: {
          v: 1,
          kind: "spawn",
          record: {
            v: 1,
            id: "bbbbbbbb",
            lifecycle: { phase: "spawned", startedAt: 1 },
            display: null,
            execution: { history: [] },
          },
        },
      },
    ]);
    const store = new AgentSpawnStore();

    await expect(
      adoptSpawnRecords({ journal, store, verdictOf: TRUSTING, notify }),
    ).resolves.toBeUndefined();
    expect(store.list().map((s) => s.id)).toEqual(["aaaaaaaa"]);
    // The unreadable record is counted, not named: it has no id left to name.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatch(/could not read 1 recorded agent/);
  });

  it("starts empty when the branch cannot be read at all", async () => {
    const notify = vi.fn();
    const { journal } = harness([]);
    const broken: SpawnJournal = {
      ...journal,
      replay: () => {
        throw new Error("session file is corrupt");
      },
    };

    await expect(
      adoptSpawnRecords({
        journal: broken,
        store: new AgentSpawnStore(),
        verdictOf: TRUSTING,
        notify,
      }),
    ).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

/* ── Verified adoption: the verdict decides what is materialised ────────── */

/** A record's spawn with a pane address: the shape a run in flight has. */
function liveSpawn(id: string): AgentSpawn {
  const base = spawn(id, { phase: "spawned", startedAt: 1_700_000_000_000 });
  return {
    ...base,
    execution: {
      ...base.execution,
      host: {
        multiplexer: "herdr",
        name: `cow-${id}`,
        paneId: `w1:${id}`,
        workspaceId: "w1",
        paneCreated: true,
      },
      harness: "pi",
    },
  };
}

describe("verified adoption", () => {
  it("adopts a live record as recorded", async () => {
    const { journal, appended } = harness([entryFor(liveSpawn("aaaaaaaa"))]);
    const store = new AgentSpawnStore();
    await adoptSpawnRecords({
      journal,
      store,
      verdictOf: async () => ({ kind: "adopt-live" }),
    });

    expect(store.get("aaaaaaaa")?.lifecycle).toMatchObject({
      phase: "spawned",
      startedAt: 1_700_000_000_000,
    });
    // Restoring a live record publishes nothing: the branch already holds it.
    expect(appended).toEqual([]);
  });

  it("settles a record whose process is gone, keeping what it earned", async () => {
    const { journal, appended } = harness([entryFor(liveSpawn("aaaaaaaa"))]);
    const store = new AgentSpawnStore();
    await adoptSpawnRecords({
      journal,
      store,
      verdictOf: async () => ({
        kind: "settle",
        reason: "the process is gone",
      }),
    });

    const restored = store.get("aaaaaaaa")!;
    expect(restored.lifecycle).toMatchObject({
      phase: "settled",
      status: "error",
      error: "the process is gone",
      startedAt: 1_700_000_000_000,
    });
    // Ended: no process for a session to watch.
    // The end is news the branch does not have, so it is written once.
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      kind: "spawn",
      record: { id: "aaaaaaaa", lifecycle: { phase: "settled" } },
    });
  });

  it("forgets a record with nothing left, leaving a tombstone", async () => {
    const { journal, appended } = harness([entryFor(liveSpawn("aaaaaaaa"))]);
    const store = new AgentSpawnStore();
    await adoptSpawnRecords({
      journal,
      store,
      verdictOf: async () => ({ kind: "forget" }),
    });

    expect(store.list()).toEqual([]);
    expect(appended).toEqual([
      { v: 1, kind: "forgotten", spawnId: "aaaaaaaa", at: 5_000 },
    ]);
  });

  it("never asks about a queued record, which has no pane to ask about", async () => {
    const verdictOf = vi.fn(async () => ({ kind: "adopt-live" }) as const);
    const { journal } = harness([
      entryFor(spawn("aaaaaaaa", { phase: "queued", queuedAt: 1_234 })),
    ]);
    const store = new AgentSpawnStore();

    await adoptSpawnRecords({ journal, store, verdictOf });

    expect(verdictOf).not.toHaveBeenCalled();
    expect(store.get("aaaaaaaa")?.lifecycle).toMatchObject({
      phase: "never-started",
      error: RELOAD_QUEUED_MESSAGE,
    });
  });

  it("does not ask about a settled record, which is already its own answer", async () => {
    const verdictOf = vi.fn(async () => ({ kind: "adopt-live" }) as const);
    const { journal } = harness([
      entryFor(
        spawn("aaaaaaaa", {
          phase: "settled",
          startedAt: 1,
          status: "completed",
          result: "done",
          completedAt: 2,
        }),
      ),
    ]);
    const store = new AgentSpawnStore();

    await adoptSpawnRecords({ journal, store, verdictOf });

    expect(verdictOf).not.toHaveBeenCalled();
    expect(store.get("aaaaaaaa")?.lifecycle).toMatchObject({
      status: "completed",
    });
  });
});

describe("a restored run whose task slug another tracked run holds", () => {
  /** A live spawn on a named task slug. */
  function onSlug(id: string, taskSlug: string): AgentSpawn {
    const base = liveSpawn(id);
    return {
      ...base,
      display: { ...base.display, taskSlug, description: `task ${id}` },
    };
  }

  it("keeps both, and says so, instead of dropping either", async () => {
    const notify = vi.fn();
    const store = new AgentSpawnStore();
    // This process already tracks an agent for the task — a /resume into a branch
    // written before that later spawn is how the pair appears.
    store.add(onSlug("aaaaaaaa", "shared-task"));
    const { journal } = harness([entryFor(onSlug("bbbbbbbb", "shared-task"))]);
    await adoptSpawnRecords({
      journal,
      store,
      verdictOf: async () => ({ kind: "adopt-live" }),
      notify,
    });

    // Both listed: the running one must not vanish, and the restored one was
    // verified live.
    expect(
      store
        .list()
        .map((s) => s.id)
        .sort(),
    ).toEqual(["aaaaaaaa", "bbbbbbbb"]);
    // The collision is named rather than left to surface as a refused spawn.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatch(
      /already tracked for task "shared-task"/,
    );
  });

  it("says nothing when the slugs differ", async () => {
    const notify = vi.fn();
    const store = new AgentSpawnStore();
    store.add(onSlug("aaaaaaaa", "one-task"));
    const { journal } = harness([entryFor(onSlug("bbbbbbbb", "other-task"))]);

    await adoptSpawnRecords({
      journal,
      store,
      verdictOf: async () => ({ kind: "adopt-live" }),
      notify,
    });

    expect(notify).not.toHaveBeenCalled();
  });

  it("says nothing when the other run on that slug has already ended", async () => {
    const notify = vi.fn();
    const store = new AgentSpawnStore();
    // A settled run holds its slug no longer: dedup reads active phases only.
    store.add({
      ...onSlug("aaaaaaaa", "shared-task"),
      lifecycle: {
        phase: "settled",
        startedAt: 1,
        status: "completed",
        result: "done",
        completedAt: 2,
      },
    });
    const { journal } = harness([entryFor(onSlug("bbbbbbbb", "shared-task"))]);

    await adoptSpawnRecords({
      journal,
      store,
      verdictOf: async () => ({ kind: "adopt-live" }),
      notify,
    });

    expect(notify).not.toHaveBeenCalled();
  });
});
