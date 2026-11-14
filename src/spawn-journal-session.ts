/**
 * spawn-journal-session.ts — the composition that binds the spawn journal to a
 * live session, and takes it down again.
 *
 * This is the only place that names both pi and the session manager on the
 * journal's behalf, and the only place that binds the adoption verifier to a
 * multiplexer. Every other module keeps its independence: the store publishes to
 * an observer it never has to know, the journal takes injected functions, the
 * verifier takes injected probes, and adoption takes a journal, a store, and a
 * verdict source.
 *
 * Binding is async because verification is: each restored record is asked about
 * once before it is materialised. Teardown stays an explicit act on the returned
 * handle, and it must run after the manager's disposal — that disposal is what
 * turns a queued run into the ended disposition a reload needs to find.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createMultiplexerAgentAssets } from "./agents/agent-assets.js";
import { adoptSpawnRecords } from "./agents/spawn-adoption.js";
import {
  createSpawnJournal,
  SPAWN_JOURNAL_CUSTOM_TYPE,
} from "./agents/spawn-journal.js";
import {
  createSpawnVerification,
  type Verdict,
} from "./agents/spawn-verification.js";
import type { ExecutionRuntime } from "./agents/agent-host.js";
import type { SpawnRecord } from "./agents/spawn-record.js";
import { getAgentSpawns } from "./shell.js";

/** One session's bound journal. */
export interface SessionSpawnJournal {
  /** Unbind: no write may outlive the session that gave the journal a target. */
  dispose(): void;
}

/**
 * Bind this session's journal and seed the store from it: a reload restores what
 * memory lost, a replacement session is told what this process still tracks (see
 * spawn-adoption.ts). Each restored record is verified against the session's own
 * multiplexer before it is trusted.
 */
export async function bindSessionSpawnJournal(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: ExecutionRuntime,
): Promise<SessionSpawnJournal> {
  const notify = (message: string, kind: "warning"): void => {
    if (ctx.hasUI) ctx.ui.notify(message, kind);
  };
  const journal = createSpawnJournal({
    append: (entry) => pi.appendEntry(SPAWN_JOURNAL_CUSTOM_TYPE, entry),
    readBranch: () => ctx.sessionManager.getBranch(),
    notify,
  });

  // The verifier reads the session's multiplexer: the pane a record names is asked
  // through the same catalog and host the rest of this session uses.
  const assets = createMultiplexerAgentAssets(
    pi,
    runtime.host,
    runtime.placements,
  );
  const verification = createSpawnVerification({
    locate: (id, hint) => assets.locate(id, hint),
    observe: (pane) => assets.observe(pane),
    notify,
  });

  // Bound after adoption: a restore publishes nothing, and the seed pass writes
  // the spawns the branch does not know yet.
  await adoptSpawnRecords({
    journal,
    store: getAgentSpawns(),
    verdictOf: (record: SpawnRecord): Promise<Verdict> =>
      verification.verdict(record),
    notify,
  });
  getAgentSpawns().setObserver(journal);

  return {
    dispose(): void {
      // Only this session's own binding goes: a replacement session's start can bind
      // its journal before this teardown runs, and clearing that one blind would
      // leave the live session with nothing mirroring it.
      getAgentSpawns().clearObserver(journal);
      journal.detach();
    },
  };
}
