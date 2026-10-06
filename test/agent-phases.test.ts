/**
 * agent-phases.test.ts — the one lifecycle-phase lattice.
 * The phase lists are derived from a single table in types.ts, so a phase
 * added there has to be listed deliberately here: this pins the split and the
 * predicates that read it, which every active/ended caller now filters with.
 */

import { describe, expect, it } from "vitest";
import {
  ACTIVE_AGENT_PHASES,
  ALL_AGENT_PHASES,
  TERMINAL_AGENT_PHASES,
  hasOutcome,
  isActivePhase,
  isEndedPhase,
} from "../src/types.js";

describe("the phase lattice", () => {
  it("splits every phase into exactly one list", () => {
    expect(ACTIVE_AGENT_PHASES).toEqual(["queued", "spawned"]);
    expect(TERMINAL_AGENT_PHASES).toEqual(["settled", "never-started"]);
    expect(ALL_AGENT_PHASES).toEqual([
      ...ACTIVE_AGENT_PHASES,
      ...TERMINAL_AGENT_PHASES,
    ]);
  });

  it.each(ALL_AGENT_PHASES)("agrees with the predicates for %s", (phase) => {
    expect(isActivePhase(phase)).toBe(ACTIVE_AGENT_PHASES.includes(phase));
    expect(isEndedPhase(phase)).toBe(TERMINAL_AGENT_PHASES.includes(phase));
    expect(isActivePhase(phase)).toBe(!isEndedPhase(phase));
  });

  it("reads hasOutcome off the ended list", () => {
    expect(hasOutcome({ phase: "queued", queuedAt: 1 })).toBe(false);
    expect(hasOutcome({ phase: "spawned", startedAt: 1 })).toBe(false);
    expect(
      hasOutcome({
        phase: "settled",
        startedAt: 1,
        status: "completed",
        result: "done",
        completedAt: 2,
      }),
    ).toBe(true);
    expect(
      hasOutcome({
        phase: "never-started",
        queuedAt: 1,
        status: "error",
        error: "disposed before launch",
        completedAt: 2,
      }),
    ).toBe(true);
  });
});
