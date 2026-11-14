/**
 * spawn-journal.ts — the session-backed mirror of the spawn store.
 *
 * The application never talks to the session: it talks to `AgentSpawnStore`,
 * which publishes registrations, saves and drops to a bound observer, and this
 * module is that observer. Writes go out as `custom` session entries — durable,
 * excluded from LLM context, and invisible in the transcript — and the session
 * is read back only once per session start, by `replay`.
 *
 * The read is `getBranch`, not `buildContextEntries`: the latter honours
 * compaction, so every record written before a `/compact` would be pruned and a
 * reload after one would restore only the tail. `getBranch` walks the live leaf
 * path, so the newest record for each spawn is always on it.
 *
 * Failure is never fatal. A journal that cannot write (an extension runtime
 * torn down while a settle pass is still in flight) is logged and ignored, and
 * a record it cannot parse is skipped: the in-memory store is the truth, and
 * the journal is only its backup.
 */

import { createLogger } from "../logger.js";
import { errorMessage } from "../utils.js";
import type { AgentSpawn } from "../types.js";
import {
  decodeJournalEntry,
  encodeForget,
  encodeSpawnRecord,
  type SpawnJournalEntry,
  type SpawnRecord,
} from "./spawn-record.js";

const log = createLogger("journal");

/** The `customType` every journal entry carries, so replay finds its own. */
export const SPAWN_JOURNAL_CUSTOM_TYPE = "pi-cowboy.spawn-journal";

/**
 * What a spawn store publishes to its backing store. The store holds the
 * contract and the journal implements it, so the store stays I/O-free and
 * shell-free.
 */
export interface AgentSpawnObserver {
  /** A spawn was registered, or its state moved. */
  record(spawn: AgentSpawn): void;
  /** A spawn left the store for good; it must not come back on a reload. */
  forget(spawnId: string): void;
}

/** What one branch replay found. */
export interface SpawnReplay {
  /**
   * Every spawn the branch remembers, in first-seen order, with a tombstone
   * removing the id; the newest record wins.
   */
  readonly records: readonly SpawnRecord[];
  /**
   * Entries carrying this journal's type that could not be read — a record from
   * another version, or a line edited by hand. Counted rather than swallowed so
   * the caller can say an agent went missing instead of quietly listing one fewer.
   */
  readonly unreadable: number;
}

/** One session's journal: the write side of the mirror, and the read that seeds it. */
export interface SpawnJournal extends AgentSpawnObserver {
  /** Read the branch back. Called once per session start. */
  replay(): SpawnReplay;
  /** Stop writing. A write after this is dropped: the runtime behind it is gone. */
  detach(): void;
}

export interface SpawnJournalDeps {
  /** Append one entry to the session. In production: `pi.appendEntry(SPAWN_JOURNAL_CUSTOM_TYPE, entry)`. */
  append(entry: SpawnJournalEntry): void;
  /** The session's active branch, root to leaf, as untrusted entries. */
  readBranch(): readonly unknown[];
  /** Where a skipped or failed write is reported, when the session can hear it. */
  notify?(message: string, kind: "warning"): void;
  /** The clock a record's `writtenAt` carries. */
  now?(): number;
}

/**
 * Whether an untrusted branch entry is one of ours, without decoding it — so a
 * branch full of ordinary messages costs a property read each, not a parse.
 */
function isJournalEntry(entry: unknown): entry is { data?: unknown } {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as { type?: unknown }).type === "custom" &&
    (entry as { customType?: unknown }).customType === SPAWN_JOURNAL_CUSTOM_TYPE
  );
}

/**
 * A record in a form two records can be compared by.
 *
 * Keys are sorted because a record that came back through a decode carries the
 * schema's key order rather than the encoder's — stringifying those two objects as
 * given would report one record as two. No clock needs stripping: an entry's `at`
 * rides the envelope, so a record is only ever agent state.
 */
function signature(record: SpawnRecord): string {
  return JSON.stringify(canonical(record));
}

/** One value with every object's keys in a fixed order, recursively. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = canonical(source[key]);
  }
  return sorted;
}

export function createSpawnJournal(deps: SpawnJournalDeps): SpawnJournal {
  const now = (): number => deps.now?.() ?? Date.now();
  let detached = false;
  let warnedFailure = false;
  /**
   * The last content written for each id, seeded by the branch read and kept up
   * to date by each write. An append whose content matches is dropped: the
   * branch already says exactly that, and a reload re-attaches every adopted run,
   * which commits an unchanged state. A file that grew a duplicate record per
   * reload carries no more information than one that did not.
   */
  const lastWritten = new Map<string, string>();

  function append(entry: SpawnJournalEntry): void {
    if (detached) return;
    try {
      deps.append(entry);
    } catch (error) {
      // A settle pass can outlive the runtime it would write through. The run
      // it reported is already safe in memory; only the backup is lost.
      if (!warnedFailure) {
        warnedFailure = true;
        log.warn("spawn journal write failed", {
          detail: errorMessage(error),
        });
        deps.notify?.(
          "Cowboy could not record its running agents in this session, so a reload may forget them. The agents themselves are unaffected.",
          "warning",
        );
      }
    }
  }

  return {
    record(spawn: AgentSpawn): void {
      const record = encodeSpawnRecord(spawn);
      const content = signature(record);
      if (lastWritten.get(record.id) === content) return;
      lastWritten.set(record.id, content);
      append({ v: 1, kind: "spawn", at: now(), record });
    },

    forget(spawnId: string): void {
      // A tombstone skips the dedup: it is idempotent on replay, and skipping one
      // because this map never saw the id would resurrect a spawn the branch still
      // remembers.
      lastWritten.delete(spawnId);
      append(encodeForget(spawnId, now()));
    },

    replay(): SpawnReplay {
      const byId = new Map<string, SpawnRecord>();
      let unreadable = 0;
      for (const entry of deps.readBranch()) {
        if (!isJournalEntry(entry)) continue;
        const decoded = decodeJournalEntry(entry.data);
        if (decoded === null) {
          unreadable += 1;
          continue;
        }
        if (decoded.kind === "forgotten") {
          byId.delete(decoded.spawnId);
          lastWritten.delete(decoded.spawnId);
          continue;
        }
        byId.set(decoded.record.id, decoded.record);
        // Seeded here, not only on write: the first re-attach after a reload must
        // already know what the branch holds for this id.
        lastWritten.set(decoded.record.id, signature(decoded.record));
      }
      return { records: [...byId.values()], unreadable };
    },

    detach(): void {
      detached = true;
    },
  };
}
