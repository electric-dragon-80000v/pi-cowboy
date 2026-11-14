/**
 * spawn-record.test.ts — the record projection and its codec.
 * A record is every field of an AgentSpawn except the three that only mean
 * something inside a live process, so `spawnFromRecord` is `encodeSpawnRecord`'s
 * inverse and the three minted fields are the only difference.
 */

import { describe, expect, it } from "vitest";
import type { AgentSpawn } from "../src/types.js";
import {
  decodeJournalEntry,
  encodeForget,
  encodeSpawnRecord,
  spawnFromRecord,
} from "../src/agents/spawn-record.js";
import { TEST_ORCHESTRATION } from "./helpers/orchestration.js";

const HOST = {
  multiplexer: "herdr",
  name: "cow-fix-login-01234567",
  paneId: "w1:p1",
  tabId: "w1:t1",
  workspaceId: "w1",
  paneCreated: true,
} as const;

/** A spawn carrying every optional field a record can hold. */
function fullSpawn(): AgentSpawn {
  return {
    id: "01234567",
    lifecycle: {
      phase: "settled",
      startedAt: 1_700_000_000_000,
      launch: { resultFile: "/tmp/pi-cowboy/01234567/result.md" },
      worktreeRetentionReason: { kind: "unverifiable", detail: "probe failed" },
      status: "completed",
      result: "the report",
      completedAt: 1_700_000_010_000,
    },
    display: {
      type: "general-purpose",
      description: "fix the login flow",
      taskSlug: "fix-login-flow",
      orchestration: TEST_ORCHESTRATION,
      invocation: {
        modelName: "sonnet",
        thinkingLevel: "high",
        fork: true,
        runInBackground: true,
      },
      worktree: {
        kind: "owned",
        path: "/repo/wt",
        branch: "cow-fix-login-01234567",
      },
      toolCallId: "call_1",
    },
    execution: {
      promise: Promise.resolve("resolved elsewhere"),
      abortController: new AbortController(),
      spawnCtx: { cwd: "/repo" } as never,
      host: HOST,
      harness: "pi",
      history: [
        {
          harness: "claude",
          host: { ...HOST, paneId: "w1:p0" },
          cwd: "/repo/wt",
          sessionId: "claude-session",
          startedAt: 1_699_999_000_000,
          endedAt: 1_699_999_500_000,
        },
      ],
    },
  };
}

describe("encodeSpawnRecord", () => {
  it("carries the whole spawn except the three fields a process owns", () => {
    const record = encodeSpawnRecord(fullSpawn());

    expect(record.v).toBe(1);

    expect(record.id).toBe("01234567");
    expect(record.lifecycle).toMatchObject({
      phase: "settled",
      status: "completed",
      result: "the report",
    });
    expect(record.display).toMatchObject({
      type: "general-purpose",
      taskSlug: "fix-login-flow",
      worktree: { kind: "owned", branch: "cow-fix-login-01234567" },
      invocation: { modelName: "sonnet" },
    });
    expect(record.execution.host).toEqual(HOST);
    expect(record.execution.harness).toBe("pi");
    expect(record.execution.history).toHaveLength(1);
    // The transcript-only handle belongs to the session that rendered the call.
    expect(record.display).not.toHaveProperty("toolCallId");
  });

  it("omits absent optionals rather than writing undefined", () => {
    const record = encodeSpawnRecord({
      id: "abcdefgh",
      lifecycle: { phase: "queued", queuedAt: 1 },
      display: {
        type: "general-purpose",
        description: "d",
        orchestration: TEST_ORCHESTRATION,
      },
      execution: {
        promise: Promise.resolve(""),
        abortController: new AbortController(),
        history: [],
      },
    });

    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
    expect(record.display).not.toHaveProperty("taskSlug");
    expect(record.display).not.toHaveProperty("invocation");
    expect(record.display).not.toHaveProperty("worktree");
    expect(record.execution).not.toHaveProperty("host");
    expect(record.execution).not.toHaveProperty("harness");
  });
});

describe("spawnFromRecord", () => {
  it("round-trips every persisted field", () => {
    const original = fullSpawn();
    const restored = spawnFromRecord(encodeSpawnRecord(original));

    expect(restored.id).toBe(original.id);
    expect(restored.lifecycle).toEqual(original.lifecycle);
    expect(restored.display).toEqual({
      type: original.display.type,
      description: original.display.description,
      taskSlug: original.display.taskSlug,
      orchestration: original.display.orchestration,
      invocation: original.display.invocation,
      worktree: original.display.worktree,
    });
    expect(restored.execution.host).toEqual(original.execution.host);
    expect(restored.execution.harness).toBe(original.execution.harness);
    expect(restored.execution.history).toEqual(original.execution.history);
  });

  it("mints the three fields that cannot travel", () => {
    const restored = spawnFromRecord(encodeSpawnRecord(fullSpawn()));

    // Fresh and un-aborted: a restored spawn stops nothing until it is told to.
    expect(restored.execution.abortController).toBeInstanceOf(AbortController);
    expect(restored.execution.abortController.signal.aborted).toBe(false);
    // Already settled: a restored run has no waiter left to unblock.
    expect(restored.execution.promise).toBeInstanceOf(Promise);
    // Absent, so a nudge takes its primary delivery path.
    expect(restored.execution).not.toHaveProperty("spawnCtx");
  });

  it("does not share mutable structure with the record", () => {
    const record = encodeSpawnRecord(fullSpawn());
    const restored = spawnFromRecord(record);

    restored.execution.history.push({
      harness: "pi",
      host: HOST,
      cwd: null,
      sessionId: "s",
      startedAt: 0,
      endedAt: 0,
    });

    expect(record.execution.history).toHaveLength(1);
  });
});

describe("decodeJournalEntry", () => {
  it("reads back what it wrote", () => {
    const record = encodeSpawnRecord(fullSpawn());
    const entry = { v: 1, kind: "spawn", at: 1, record } as const;

    expect(decodeJournalEntry(JSON.parse(JSON.stringify(entry)))).toEqual(
      entry,
    );
    expect(decodeJournalEntry(encodeForget("01234567", 9))).toEqual({
      v: 1,
      kind: "forgotten",
      spawnId: "01234567",
      at: 9,
    });
  });

  it.each([
    ["a non-object", "nope"],
    ["null", null],
    ["an unknown version", { v: 2, kind: "forgotten", spawnId: "a", at: 1 }],
    ["an unknown kind", { v: 1, kind: "nonsense" }],
    ["a spawn without a record", { v: 1, kind: "spawn" }],
    ["a tombstone without an id", { v: 1, kind: "forgotten", at: 1 }],
    [
      "a lifecycle with an unknown phase",
      {
        v: 1,
        kind: "spawn",
        record: {
          v: 1,
          writtenAt: 1,
          id: "a",
          lifecycle: { phase: "exploded" },
          display: {
            type: "t",
            description: "d",
            orchestration: TEST_ORCHESTRATION,
          },
          execution: { history: [] },
        },
      },
    ],
  ])("answers null for %s", (_label, data) => {
    expect(decodeJournalEntry(data)).toBeNull();
  });
});

describe("a record from a hand-edited file", () => {
  /** One valid record's JSON, for a case to damage. */
  function goodRecord(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(encodeSpawnRecord(fullSpawn()))) as Record<
      string,
      unknown
    >;
  }

  function entry(record: unknown): unknown {
    return { v: 1, kind: "spawn", at: 1, record };
  }

  it("is refused when its id is not one this extension mints", () => {
    const record = goodRecord();
    record.id = "../../etc/passwd";

    expect(decodeJournalEntry(entry(record))).toBeNull();
  });

  it("is refused when its id has the wrong length", () => {
    const record = goodRecord();
    record.id = "abc";

    expect(decodeJournalEntry(entry(record))).toBeNull();
  });

  it("is refused when its report path is not absolute", () => {
    const record = goodRecord();
    (record.lifecycle as Record<string, unknown>).launch = {
      resultFile: "relative/result.md",
    };

    expect(decodeJournalEntry(entry(record))).toBeNull();
  });

  it("is refused when its report path climbs out with `..`", () => {
    const record = goodRecord();
    (record.lifecycle as Record<string, unknown>).launch = {
      resultFile: "/tmp/pi-cowboy/../../etc/shadow",
    };

    expect(decodeJournalEntry(entry(record))).toBeNull();
  });

  it("is refused when its worktree path climbs out with `..`", () => {
    const record = goodRecord();
    (record.display as Record<string, unknown>).worktree = {
      kind: "owned",
      path: "/repo/../../../etc",
      branch: "cow-x-01234567",
    };

    expect(decodeJournalEntry(entry(record))).toBeNull();
  });

  it("still accepts the paths the extension itself writes", () => {
    // The same record untouched, so the checks above are not simply rejecting all.
    expect(decodeJournalEntry(entry(goodRecord()))).not.toBeNull();
  });
});

describe("a record states what the spawn was when it was taken", () => {
  it("copies every nested value, so a later mutation cannot rewrite it", () => {
    const spawn = fullSpawn();
    const record = encodeSpawnRecord(spawn);

    // The writer goes on mutating the spawn in place between polls.
    spawn.lifecycle = { phase: "queued", queuedAt: 9 };
    spawn.display.orchestration.name = "mutated";
    spawn.display.orchestration.cues.spawned = "mutated";
    spawn.display.invocation!.modelName = "mutated";
    spawn.display.worktree!.branch = "mutated";

    // The record still describes the moment it was taken.
    expect(record.lifecycle).toMatchObject({ phase: "settled" });
    expect(record.display.orchestration.name).not.toBe("mutated");
    expect(record.display.orchestration.cues.spawned).not.toBe("mutated");
    expect(record.display.invocation?.modelName).not.toBe("mutated");
    expect(record.display.worktree?.branch).not.toBe("mutated");
  });

  it("copies a lifecycle's nested launch too", () => {
    const spawn = fullSpawn();
    const record = encodeSpawnRecord(spawn);
    if (record.lifecycle.phase !== "settled")
      throw new Error("expected settled");

    const launch =
      spawn.lifecycle.phase === "settled" ? spawn.lifecycle.launch : undefined;
    if (launch !== undefined) launch.resultFile = "/mutated";

    expect(record.lifecycle.launch?.resultFile).not.toBe("/mutated");
  });
});
