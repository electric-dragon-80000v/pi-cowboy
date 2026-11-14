/**
 * spawn-verification.test.ts — the verdict table, row by row.
 * The probes are injected, so each row is one fake observation and one fake
 * locate; nothing here shells out or touches a session.
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentSpawn } from "../src/types.js";
import type { HostObservation } from "../src/agents/agent-host.js";
import type { LocateResult } from "../src/agents/agent-assets.js";
import {
  createSpawnVerification,
  PROCESS_GONE_ARTIFACTS_REMAIN,
} from "../src/agents/spawn-verification.js";
import type { SpawnRecord } from "../src/agents/spawn-record.js";
import { encodeSpawnRecord } from "../src/agents/spawn-record.js";
import { TEST_ORCHESTRATION } from "./helpers/orchestration.js";

const HOST = {
  multiplexer: "herdr",
  name: "cow-task-aaaaaaaa",
  paneId: "w1:p1",
  workspaceId: "w1",
  paneCreated: true,
} as const;

/** A recorded in-flight run, with the pane it occupies. */
function record(
  over: Partial<{ host: typeof HOST | undefined }> = {},
): SpawnRecord {
  const spawn: AgentSpawn = {
    id: "aaaaaaaa",
    lifecycle: { phase: "spawned", startedAt: 1_700_000_000_000 },
    display: {
      type: "general-purpose",
      description: "task",
      taskSlug: "task",
      orchestration: TEST_ORCHESTRATION,
    },
    execution: {
      promise: Promise.resolve(""),
      abortController: new AbortController(),
      history: [],
      ...("host" in over
        ? over.host === undefined
          ? {}
          : { host: over.host }
        : { host: HOST }),
    },
  };
  return encodeSpawnRecord(spawn);
}

const LOCATED = {
  kind: "located",
  source: "tracked",
  id: "aaaaaaaa",
  branch: "cow-task-aaaaaaaa",
  worktreeManaged: true,
  paneCreated: true,
  worktree: null,
  pane: { paneId: "w1:p1" },
} as const satisfies LocateResult;

const NOT_FOUND = {
  kind: "not-found",
  id: "aaaaaaaa",
} as const satisfies LocateResult;

const AMBIGUOUS = {
  kind: "ambiguous",
  id: "aaaaaaaa",
  candidates: [{ worktreePath: "/a", branch: "a" }],
} as const satisfies LocateResult;

/** A verifier over faked probes. */
function harness(
  observe: (pane: { paneId: string }) => Promise<HostObservation | undefined>,
  locate: () => Promise<LocateResult> = async () => LOCATED,
) {
  const notify = vi.fn();
  const locateSpy = vi.fn(locate);
  const observeSpy = vi.fn(observe);
  return {
    notify,
    locateSpy,
    observeSpy,
    verification: createSpawnVerification({
      locate: locateSpy,
      observe: observeSpy,
      notify,
    }),
  };
}

describe("the verdict table", () => {
  it.each(["working", "idle", "blocked"] as const)(
    "adopts a run whose pane is still %s",
    async (state) => {
      const { verification } = harness(async () => ({ state }));

      const record_ = record();
      await expect(verification.verdict(record_)).resolves.toEqual({
        kind: "adopt-live",
      });
    },
  );

  it("adopts a run whose pane answered `done`: it still hosts the agent", async () => {
    // `done` is a finished turn in a live pane, not an absent pane — attaching
    // finds the report it already wrote.
    const { verification } = harness(async () => ({ state: "done" }));

    const record_ = record();
    await expect(verification.verdict(record_)).resolves.toEqual({
      kind: "adopt-live",
    });
  });

  it("forgets a run whose pane is gone and whose artifacts are gone", async () => {
    const { verification } = harness(
      async () => undefined,
      async () => NOT_FOUND,
    );

    const record_ = record();
    await expect(verification.verdict(record_)).resolves.toEqual({
      kind: "forget",
    });
  });

  it("settles a run whose pane is gone but whose artifacts remain", async () => {
    const { verification } = harness(
      async () => undefined,
      async () => LOCATED,
    );

    const record_ = record();
    await expect(verification.verdict(record_)).resolves.toEqual({
      kind: "settle",
      reason: PROCESS_GONE_ARTIFACTS_REMAIN,
    });
  });

  it("adopts when the pane read throws: unreadable is never absence", async () => {
    const { verification, notify } = harness(async () => {
      throw new Error("herdr is unreachable");
    });

    const record_ = record();
    await expect(verification.verdict(record_)).resolves.toEqual({
      kind: "adopt-live",
    });
    // A failed read says nothing about the run, so it is not reported as one.
    expect(notify).not.toHaveBeenCalled();
  });

  it("adopts an ambiguous id and says so once", async () => {
    const { verification, notify } = harness(
      async () => ({ state: "idle" }),
      async () => AMBIGUOUS,
    );

    const record_ = record();
    await expect(verification.verdict(record_)).resolves.toEqual({
      kind: "adopt-live",
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatch(/more than one set of artifacts/);
    expect(notify.mock.calls[0]![1]).toBe("warning");

    // A second ambiguous record does not repeat the notice.
    const other = record();
    await verification.verdict(other);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("adopts ambiguity over a gone pane: two candidate trees is not an absence", async () => {
    const observe = vi.fn(async () => undefined);
    const { verification } = harness(observe, async () => AMBIGUOUS);

    const record_ = record();
    await expect(verification.verdict(record_)).resolves.toEqual({
      kind: "adopt-live",
    });
    // Ambiguity is decided before the pane is read.
    expect(observe).not.toHaveBeenCalled();
  });

  it("adopts a record that names no pane, because its process may exist unseen", async () => {
    // Settling it would free a task slug for a duplicate while the original might
    // still be running, which "one agent per task" forbids.
    const { verification, observeSpy } = harness(async () => undefined);

    const record_ = record({ host: undefined });
    await expect(verification.verdict(record_)).resolves.toEqual({
      kind: "adopt-live",
    });
    expect(observeSpy).not.toHaveBeenCalled();
  });

  it("keeps a run it could not even locate, rather than forgetting it", async () => {
    const { verification } = harness(
      async () => ({ state: "working" }),
      async () => {
        throw new Error("herdr list failed");
      },
    );

    const record_ = record();
    await expect(verification.verdict(record_)).resolves.toEqual({
      kind: "adopt-live",
    });
  });
});
