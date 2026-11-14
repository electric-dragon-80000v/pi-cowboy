/**
 * spawn-verification.ts — is a restored record still telling the truth?
 *
 * Adoption reads a record as a claim. This module is what turns the claim into
 * a verdict: the pane the record names is asked whether it still holds a live
 * agent, and only when that answer is a definite absence does the record get
 * settled or forgotten. Nothing here stops, closes, or writes anything — the
 * verdict is data, and `spawn-adoption.ts` applies it.
 *
 * The asymmetry is the point. A live observation is evidence the run exists; a
 * gone pane is evidence the run is over; a failed read is evidence of neither,
 * so it adopts. That is the same rule `cleanup-policy.ts` and `agent-assets.ts`
 * already follow for a recovered run: unreadable is never absence.
 *
 * A record that names no pane is the one case with no observation to make. It
 * was written between a run's launch and its placement, so its process may
 * already be alive in a pane nothing recorded. Declaring it over would free its
 * task slug for a duplicate while the original might still be running, which is
 * the one outcome "one agent per task" forbids — so it adopts too, and simply
 * cannot be acted on (it has no address to reach it through).
 */

import type { AgentSpawn } from "../types.js";
import type { HostObservation } from "./agent-host.js";
import type { LocateResult, PaneRef } from "./agent-assets.js";
import { spawnFromRecord, type SpawnRecord } from "./spawn-record.js";

/** What one record is worth, deciding how adoption materialises it. */
export type Verdict =
  /** The run may still be there: restore it as it was. */
  | { readonly kind: "adopt-live" }
  /** The process is gone and its artifacts are not: record the end. */
  | { readonly kind: "settle"; readonly reason: string }
  /** Nothing is left anywhere: leave a tombstone so a reload cannot resurrect it. */
  | { readonly kind: "forget" };

export interface SpawnVerificationDeps {
  /** Locate one agent's artifacts (`AgentAssets.locate`, with the record as the hint). */
  locate(id: string, hint: AgentSpawn): Promise<LocateResult>;
  /** The pane's live state: undefined = gone, a throw = unreadable (`AgentAssets.observe`). */
  observe(pane: PaneRef): Promise<HostObservation | undefined>;
  /** Where a condition worth saying out loud is reported. */
  notify?(message: string, kind: "warning"): void;
}

export interface SpawnVerification {
  /** Ask what one record is worth. Total: a record with nothing live answers at once. */
  verdict(record: SpawnRecord): Promise<Verdict>;
}

/** The reason a settled record carries when its pane is gone but its work is not. */
export const PROCESS_GONE_ARTIFACTS_REMAIN =
  "the process is gone, but its worktree and branch remain";

export function createSpawnVerification(
  deps: SpawnVerificationDeps,
): SpawnVerification {
  // One notice per session, not one per record: a multiplexer that cannot answer
  // would otherwise bury the session start in identical warnings.
  let reportedAmbiguity = false;

  async function locate(record: SpawnRecord): Promise<LocateResult> {
    try {
      // The locator wants the spawn as its hint, and a record is what produces one;
      // deriving it here keeps the pair out of every caller.
      return await deps.locate(record.id, spawnFromRecord(record));
    } catch {
      // A failed locate is not a failed agent: nothing to decide on, so keep it.
      return { kind: "not-found", id: record.id };
    }
  }

  function reportAmbiguity(record: SpawnRecord): void {
    if (reportedAmbiguity) return;
    reportedAmbiguity = true;
    deps.notify?.(
      `Cowboy found more than one set of artifacts for agent ${record.id}, so it cannot tell whether that agent is still running. It is listed, but may be stale.`,
      "warning",
    );
  }

  return {
    async verdict(record): Promise<Verdict> {
      // Callers ask only about an in-flight record (see spawn-adoption.ts): a
      // settled one is already an answer, and a queued one never had a pane.
      // Artifacts are read once and reused: both branches below want the same
      // answer, and a second round trip could disagree with the first.
      const found = await locate(record);
      // Ambiguity outranks the pane: two artifact pairs answer to this id, so
      // neither may be called live or absent. Adopting keeps the id listed and
      // settles nothing, which is the conservative half of "not sure".
      if (found.kind === "ambiguous") {
        reportAmbiguity(record);
        return { kind: "adopt-live" };
      }

      const ref = record.execution.host;
      // Nothing to observe: the launch was cut off before it placed the run, so
      // the process may already exist in a pane no record names. See the header.
      if (ref === undefined) return { kind: "adopt-live" };

      let observation: HostObservation | undefined;
      try {
        observation = await deps.observe(ref);
      } catch {
        // Unreadable is not absence: the run is left alone, not declared over.
        return { kind: "adopt-live" };
      }
      // Any answer other than "the pane is gone" means something is still there.
      // `done` is an agent that finished its turn in a pane that still hosts it,
      // and `unknown` is not evidence of absence.
      if (observation !== undefined) return { kind: "adopt-live" };

      // The pane is gone. What survives decides whether to settle or forget: a
      // record whose checkout or branch is still on disk keeps its listing, so
      // cleanup can take the worktree and state why it was kept if it is dirty.
      return found.kind === "not-found"
        ? { kind: "forget" }
        : { kind: "settle", reason: PROCESS_GONE_ARTIFACTS_REMAIN };
    },
  };
}
