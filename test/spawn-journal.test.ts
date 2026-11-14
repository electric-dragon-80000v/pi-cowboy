/**
 * spawn-journal.test.ts — the write side of the session mirror, and its replay.
 * Every dependency is injected, so this file names no `pi` and no session.
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentSpawn } from "../src/types.js";
import {
  createSpawnJournal,
  SPAWN_JOURNAL_CUSTOM_TYPE,
  type SpawnJournalDeps,
} from "../src/agents/spawn-journal.js";
import type { SpawnJournalEntry } from "../src/agents/spawn-record.js";
import { TEST_ORCHESTRATION } from "./helpers/orchestration.js";

/** A minimal spawn in the phase a test asks for. */
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

/** A spawn with a pane address, so its record is the shape an adopted run writes. */
function liveSpawn(id: string): AgentSpawn {
  const base = spawn(id);
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

/** A branch entry as pi writes one of our custom entries. */
function journalEntry(entry: SpawnJournalEntry): unknown {
  return {
    type: "custom",
    customType: SPAWN_JOURNAL_CUSTOM_TYPE,
    data: entry,
    id: "e1",
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** One `spawn` entry, as the journal would write it for this spawn at this moment. */
function spawnEntry(spawn_: AgentSpawn, at: number): SpawnJournalEntry {
  return { v: 1, kind: "spawn", at, record: recordOf(spawn_, at) };
}

/** Bind a journal over a recording `append` and a fixed branch. */
function harness(
  branch: readonly unknown[] = [],
  overrides: Partial<SpawnJournalDeps> = {},
) {
  const appended: SpawnJournalEntry[] = [];
  const journal = createSpawnJournal({
    append: (entry) => {
      appended.push(entry);
    },
    readBranch: () => branch,
    now: () => 1_000,
    ...overrides,
  });
  return { journal, appended };
}

describe("writing", () => {
  it("appends one spawn entry per publish", () => {
    const { journal, appended } = harness();

    journal.record(spawn("aaaaaaaa"));

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      v: 1,
      kind: "spawn",
      at: 1_000,
      record: { id: "aaaaaaaa" },
    });
  });

  it("appends a tombstone when a spawn is forgotten", () => {
    const { journal, appended } = harness();

    journal.forget("aaaaaaaa");

    expect(appended).toEqual([
      { v: 1, kind: "forgotten", spawnId: "aaaaaaaa", at: 1_000 },
    ]);
  });

  it("drops every write after detach", () => {
    const { journal, appended } = harness();

    journal.detach();
    journal.record(spawn("aaaaaaaa"));
    journal.forget("aaaaaaaa");

    expect(appended).toEqual([]);
  });

  it("drops an append identical to the last one written for that id", () => {
    // A reload re-attaches every adopted run, and attach commits the state the
    // record already holds. Writing that again would grow the file on every reload.
    const { journal, appended } = harness();
    const spawn = liveSpawn("aaaaaaaa");

    journal.record(spawn);
    journal.record(spawn);
    journal.record(spawn);

    expect(appended).toHaveLength(1);
  });

  it("appends once when the state actually moves", () => {
    const { journal, appended } = harness();
    const spawn = liveSpawn("aaaaaaaa");
    journal.record(spawn);

    // The same spawn, one phase later: different content, so it is news.
    const progressed: AgentSpawn = {
      ...spawn,
      lifecycle: {
        phase: "settled",
        startedAt: 1_700_000_000_000,
        status: "completed",
        result: "finished",
        completedAt: 1_700_000_010_000,
      },
    };
    journal.record(progressed);

    expect(appended).toHaveLength(2);
    expect(appended[1]).toMatchObject({
      record: { lifecycle: { phase: "settled" } },
    });
  });

  it("tells two spawns apart, so one moving does not silence the other", () => {
    const { journal, appended } = harness();
    const one = liveSpawn("aaaaaaaa");
    const two = liveSpawn("bbbbbbbb");

    journal.record(one);
    journal.record(two);
    journal.record(one);

    expect(appended).toHaveLength(2);
  });

  it("is not silenced by a reload: the branch it read seeds the guard", () => {
    // The first re-attach after a reload must already know what the branch holds.
    const spawn = liveSpawn("aaaaaaaa");
    const branch = [journalEntry(spawnEntry(spawn, 1_000))];

    const { journal: reloaded, appended } = harness(branch);
    reloaded.replay();
    reloaded.record(spawn);

    expect(appended).toEqual([]);
  });

  it("swallows a failed append, reporting it once and never throwing", () => {
    const notify = vi.fn();
    const { journal } = harness([], {
      append: () => {
        throw new Error("stale extension runtime");
      },
      notify,
    });

    expect(() => journal.record(spawn("aaaaaaaa"))).not.toThrow();
    expect(() => journal.record(spawn("bbbbbbbb"))).not.toThrow();

    // One notice, not one per settle — a reload must not become a toast storm.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatch(/may forget them/);
    expect(notify.mock.calls[0]![1]).toBe("warning");
  });
});

describe("replay", () => {
  it("answers empty for a branch with nothing of ours", () => {
    const { journal } = harness([
      { type: "message", message: { role: "user", content: "hi" } },
      // Another extension's custom entry, same file, different type.
      { type: "custom", customType: "someone.else", data: { v: 1 } },
    ]);

    expect(journal.replay()).toEqual({ records: [], unreadable: 0 });
  });

  it("keeps the newest record per id, in first-seen order", () => {
    const branch = [
      journalEntry({
        v: 1,
        kind: "spawn",
        at: 1,
        record: recordOf(spawn("aaaaaaaa"), 1),
      }),
      journalEntry({
        v: 1,
        kind: "spawn",
        at: 1,
        record: recordOf(spawn("bbbbbbbb"), 2),
      }),
      journalEntry({
        v: 1,
        kind: "spawn",
        at: 1,
        record: recordOf(spawn("aaaaaaaa"), 3),
      }),
    ];

    const replayed = createSpawnJournal({
      append: () => {},
      readBranch: () => branch,
    }).replay();

    expect(replayed.records.map((record) => record.id)).toEqual([
      "aaaaaaaa",
      "bbbbbbbb",
    ]);
  });

  it("removes an id a tombstone names, so a drop is not resurrected", () => {
    const branch = [
      journalEntry({
        v: 1,
        kind: "spawn",
        at: 1,
        record: recordOf(spawn("aaaaaaaa"), 1),
      }),
      journalEntry({
        v: 1,
        kind: "spawn",
        at: 1,
        record: recordOf(spawn("bbbbbbbb"), 1),
      }),
      journalEntry({ v: 1, kind: "forgotten", spawnId: "aaaaaaaa", at: 2 }),
    ];

    const replayed = createSpawnJournal({
      append: () => {},
      readBranch: () => branch,
    }).replay();

    expect(replayed.records.map((record) => record.id)).toEqual(["bbbbbbbb"]);
  });

  it("re-adopts an id that was forgotten and then spawned again", () => {
    const branch = [
      journalEntry({
        v: 1,
        kind: "spawn",
        at: 1,
        record: recordOf(spawn("aaaaaaaa"), 1),
      }),
      journalEntry({ v: 1, kind: "forgotten", spawnId: "aaaaaaaa", at: 2 }),
      journalEntry({
        v: 1,
        kind: "spawn",
        at: 1,
        record: recordOf(spawn("aaaaaaaa"), 3),
      }),
    ];

    const replayed = createSpawnJournal({
      append: () => {},
      readBranch: () => branch,
    }).replay();

    expect(replayed.records.map((record) => record.id)).toEqual(["aaaaaaaa"]);
  });

  it("skips an entry it cannot decode rather than losing the rest", () => {
    const branch = [
      journalEntry({
        v: 1,
        kind: "spawn",
        at: 1,
        record: recordOf(spawn("aaaaaaaa"), 1),
      }),
      {
        type: "custom",
        customType: SPAWN_JOURNAL_CUSTOM_TYPE,
        data: { v: 99 },
      },
      journalEntry({
        v: 1,
        kind: "spawn",
        at: 1,
        record: recordOf(spawn("bbbbbbbb"), 1),
      }),
    ];

    const replayed = createSpawnJournal({
      append: () => {},
      readBranch: () => branch,
    }).replay();

    expect(replayed.records.map((record) => record.id)).toEqual([
      "aaaaaaaa",
      "bbbbbbbb",
    ]);
    // The middle entry was ours and unreadable: counted, never silently dropped.
    expect(replayed.unreadable).toBe(1);
  });
});

/** The encoded record a branch entry carries, without exporting the encoder twice. */
function recordOf(spawn_: AgentSpawn, writtenAt: number) {
  const appended: SpawnJournalEntry[] = [];
  createSpawnJournal({
    append: (entry) => appended.push(entry),
    readBranch: () => [],
    now: () => writtenAt,
  }).record(spawn_);
  const entry = appended[0]!;
  if (entry.kind !== "spawn") throw new Error("expected a spawn entry");
  return entry.record;
}
