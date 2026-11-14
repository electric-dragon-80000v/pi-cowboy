/**
 * spawn-adoption.ts — materialise the spawn store from the session at start.
 *
 * One call, two set differences against the store, so no `session_start` reason is
 * needed and neither half depends on the caller classifying the start:
 *
 *   - a record the branch knows and the store does not is restored (a `/reload`,
 *     or a `--resume` into another branch);
 *   - a spawn the store holds and the branch does not is written to the branch
 *     (a `/new`, `/resume` or `/fork` that replaced the session while spawns kept
 *     running).
 *
 * Both can apply to the same start — a `/resume` into an older branch while this
 * process still tracks a later spawn restores and seeds in one pass — which is
 * also how two spawns on one task slug can meet (`reportSlugCollision`).
 *
 * A restored record is a claim, not a fact, so each one is put to
 * `spawn-verification.ts` before it is materialised. The verdict decides:
 *
 *   - `adopt-live`  the run may still exist — restore it as recorded;
 *   - `settle`      its process is gone — record the end with a reason, which
 *                   frees its task slug for dedup and lets cleanup reach the
 *                   work tree (keeping it, with that reason, if it is dirty);
 *   - `forget`      nothing is left — leave a tombstone so no reload revives it.
 *
 * What is worth attaching needs no separate set: a restored spawn left `spawned` in
 * the store, with the pane and harness a supervisor needs, *is* the set — and the
 * manager reads it from there (see `AgentManager.attachLiveSpawns`).
 *
 * A restore publishes nothing: the branch already holds what was just read, and
 * only a record whose restored shape differs (a demoted queue entry, a settled
 * one) is written back.
 */

import { createLogger } from "../logger.js";
import { errorMessage } from "../utils.js";
import {
  ACTIVE_AGENT_PHASES,
  type AgentLifecycleState,
  type AgentSpawn,
} from "../types.js";
import type { AgentSpawnStore } from "./agent-spawn-store.js";
import type { SpawnJournal } from "./spawn-journal.js";
import { spawnFromRecord, type SpawnRecord } from "./spawn-record.js";
import type { Verdict } from "./spawn-verification.js";

const log = createLogger("adoption");

/** The note a restored queue entry carries: it was queued, and the queue it waited on is gone. */
export const RELOAD_QUEUED_MESSAGE =
  "The session was reloaded before the queued agent could start.";

/** Asking one record what it is worth; injected so adoption names no multiplexer. */
export type VerdictSource = (record: SpawnRecord) => Promise<Verdict>;

export interface AdoptSpawnRecordsRequest {
  readonly journal: SpawnJournal;
  readonly store: AgentSpawnStore;
  /** How a restored record is checked. Production always has a multiplexer to ask. */
  readonly verdictOf: VerdictSource;
  /** Where a record that could not be restored is reported. */
  notify?(message: string, kind: "warning"): void;
}

/**
 * What to materialise for one record. A pure answer — nothing is written here,
 * so the probes can run concurrently and the journal can be applied afterwards in
 * record order.
 */
type Restored =
  | {
      readonly kind: "restored";
      readonly record: SpawnRecord;
      /** The branch does not yet hold this shape — the only reason a restore writes. */
      readonly writeBack: boolean;
    }
  /** A tombstone is owed: the record is over and nothing is materialised. */
  | { readonly kind: "dropped" };

/**
 * A queued run cannot survive a session. The pools are per session and rebuilt
 * empty, so nothing is left to drain the entry, while a queued phase still
 * counts as active and would block dedup for its task slug forever. The restored
 * spawn therefore takes the terminal outcome a discarded queue entry already
 * has, which leaves it listed and cleanable.
 */
function demoteQueued(record: SpawnRecord, at: number): SpawnRecord {
  if (record.lifecycle.phase !== "queued") return record;
  const { queuedAt } = record.lifecycle;
  return {
    ...record,
    lifecycle: {
      phase: "never-started",
      queuedAt,
      status: "error",
      error: RELOAD_QUEUED_MESSAGE,
      completedAt: at,
    },
  };
}

/** The lifecycle a verifier's `settle` verdict applies to: only an in-flight run is ever asked about. */
type SpawnedLifecycle = Extract<AgentLifecycleState, { phase: "spawned" }>;

/**
 * Record that a run ended while no session was watching. It keeps the start it
 * earned and the launch it left behind, so status still reports a real duration
 * and cleanup still knows where the report lives.
 */
function settleRecord(
  record: SpawnRecord,
  lifecycle: SpawnedLifecycle,
  reason: string,
  at: number,
): SpawnRecord {
  return {
    ...record,
    lifecycle: {
      phase: "settled",
      startedAt: lifecycle.startedAt,
      ...(lifecycle.launch === undefined ? {} : { launch: lifecycle.launch }),
      status: "error",
      error: reason,
      completedAt: at,
    },
  };
}

/** Ask the verifier, and turn its answer into what to materialise. */
async function decide(
  record: SpawnRecord,
  request: AdoptSpawnRecordsRequest,
  at: number,
): Promise<Restored> {
  // A queued entry is settled by the demotion, never put to the verifier: it
  // never had a pane or a process to observe.
  const demoted = demoteQueued(record, at);
  if (demoted !== record) {
    return {
      kind: "restored",
      record: demoted,
      writeBack: true,
    };
  }
  // Only an in-flight record has anything to verify: a settled or never-started
  // one is already its own answer, and asking would let a verifier end it twice.
  if (!isInFlight(record)) {
    return { kind: "restored", record, writeBack: false };
  }
  return verifyInFlight(record, request, at);
}

/** An in-flight record: the one phase whose claim is still a claim. */
type InFlightRecord = SpawnRecord & { readonly lifecycle: SpawnedLifecycle };

function isInFlight(record: SpawnRecord): record is InFlightRecord {
  return record.lifecycle.phase === "spawned";
}

/** The verified half of `decide`, narrowed to the one phase it decides about. */
async function verifyInFlight(
  record: InFlightRecord,
  request: AdoptSpawnRecordsRequest,
  at: number,
): Promise<Restored> {
  const verdict = await request.verdictOf(record);
  switch (verdict.kind) {
    case "adopt-live":
      // A live run is only addressable when the record names the pane to reach it.
      return {
        kind: "restored",
        record,
        writeBack: false,
      };
    case "forget":
      // The tombstone is the whole record's end; the apply pass writes it.
      return { kind: "dropped" };
    case "settle": {
      const settled = settleRecord(
        record,
        record.lifecycle,
        verdict.reason,
        at,
      );
      // The end is news the branch does not have, so the apply pass writes it.
      return {
        kind: "restored",
        record: settled,
        writeBack: true,
      };
    }
  }
}

/**
 * Say so when a restored run lands on a task slug another tracked run already holds.
 *
 * The store keys on id alone, so both are kept — deliberately. `/resume` into a
 * branch written before a later spawn can surface a record whose slug this process
 * already has an agent for, and dropping either would be wrong: the running one
 * would vanish from the list, and the restored one is a pane this start just
 * verified live. Dedup reads active phases, so the pair shows up as a refused
 * spawn for that slug rather than as two agents on one task; that is a confusing
 * refusal, and naming it here is what stops it looking like a bug.
 */
function reportSlugCollision(
  restored: AgentSpawn,
  request: AdoptSpawnRecordsRequest,
): void {
  const slug = restored.display.taskSlug;
  if (slug === undefined) return;
  const holder = request.store
    .list(ACTIVE_AGENT_PHASES)
    .find(
      (other) =>
        other.id !== restored.id &&
        other.display.taskSlug === slug &&
        other.lifecycle.phase !== "never-started",
    );
  if (holder === undefined) return;
  log.warn("restored run shares a task slug with a tracked one", {
    spawnId: restored.id,
    otherId: holder.id,
    taskSlug: slug,
  });
  request.notify?.(
    `Cowboy restored agent ${restored.id}, and agent ${holder.id} is already tracked for task "${slug}". Both are listed; that task cannot take a new agent until one of them is stopped or cleaned up.`,
    "warning",
  );
}

/**
 * Restore the branch's spawns into an empty store, then seed a branch that does
 * not know the spawns the store already holds. Never throws: a session whose
 * file was hand-edited must still start.
 */
export async function adoptSpawnRecords(
  request: AdoptSpawnRecordsRequest,
): Promise<void> {
  const { journal, store } = request;
  let records: readonly SpawnRecord[];
  try {
    const replay = journal.replay();
    if (replay.unreadable > 0) {
      log.warn("unreadable spawn journal entries", {
        count: replay.unreadable,
      });
      request.notify?.(
        `Cowboy could not read ${replay.unreadable} recorded agent${replay.unreadable === 1 ? "" : "s"} from this session; ${replay.unreadable === 1 ? "it is" : "they are"} not listed.`,
        "warning",
      );
    }
    records = replay.records;
  } catch (error) {
    log.warn("spawn replay failed", { detail: errorMessage(error) });
    request.notify?.(
      "Cowboy could not read its recorded agents from this session; any still running are not listed.",
      "warning",
    );
    records = [];
  }

  const remembered = new Set(records.map((record) => record.id));
  const at = Date.now();
  // A record this session already tracks is a replacement session's, not a
  // reload's; it needs no verdict and no restore.
  const missing = records.filter(
    (record) => store.get(record.id) === undefined,
  );
  // The probes are multiplexer round trips, so they run together rather than one
  // after another; the store and the journal are applied afterwards in record
  // order, which keeps the append-only branch in the order it was written. One
  // record's failure is its own — see the apply loop below.
  const decisions = await Promise.allSettled(
    missing.map((record) => decide(record, request, at)),
  );
  for (const [index, record] of missing.entries()) {
    try {
      const outcome = decisions[index]!;
      // A probe failure is this record's, not the batch's: it is reported below
      // exactly like a record that could not be materialised.
      if (outcome.status === "rejected") throw outcome.reason;
      const restored = outcome.value;
      if (restored.kind === "dropped") {
        journal.forget(record.id);
        continue;
      }
      const spawn = spawnFromRecord(restored.record);
      store.add(spawn);
      // One write per restore: the shape the branch does not already hold.
      if (restored.writeBack) journal.record(spawn);
      reportSlugCollision(spawn, request);
    } catch (error) {
      // One unreadable record is one lost agent, never a lost session.
      log.warn("spawn record could not be restored", {
        spawnId: record.id,
        detail: errorMessage(error),
      });
      request.notify?.(
        `Cowboy could not restore agent ${record.id} from this session; it is no longer listed.`,
        "warning",
      );
    }
  }

  // The other direction: a spawn this process still tracks that the branch has
  // never heard of. Written through the journal rather than through a publish,
  // so adoption is the same whether or not an observer is bound yet.
  for (const spawn of store.list()) {
    if (remembered.has(spawn.id)) continue;
    journal.record(spawn);
  }
}
