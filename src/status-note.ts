/**
 * status-note.ts — the parenthetical note appended to a settled agent's result.
 * Only stopped runs get one (who stopped it, and whether it ever started).
 * A completed run carries no note: its result text IS the report.
 */
import {
  hasOutcome,
  type AgentLifecycleState,
  type StopInitiator,
} from "./types.js";

const STOP_NOTES: Record<StopInitiator, string> = {
  user: "STOPPED BY THE USER before completion — output is partial; the task was NOT finished",
  agent:
    "STOPPED BY YOU before completion — output is partial; the task was NOT finished",
};

/** Never-started spawns have no partial output, so the note says the task was not attempted. */
const NEVER_STARTED_STOP_NOTES: Record<StopInitiator, string> = {
  user: "STOPPED BY THE USER before the agent started — the task was NOT attempted",
  agent: "STOPPED BY YOU before the agent started — the task was NOT attempted",
};

function stopNote(state: AgentLifecycleState): string {
  if (!hasOutcome(state) || state.status !== "stopped") {
    // Unreachable — stopNote is only reached for stopped spawns.
    return STOP_NOTES.agent;
  }
  const { stop } = state;
  return state.phase === "never-started"
    ? NEVER_STARTED_STOP_NOTES[stop.initiator]
    : STOP_NOTES[stop.initiator];
}

export function getStatusNote(state: AgentLifecycleState): string {
  if (!hasOutcome(state) || state.status !== "stopped") return "";
  return ` (${stopNote(state)})`;
}
