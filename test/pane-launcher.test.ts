/**
 * pane-launcher.test.ts — the pane-launcher install: type the function into the
 * pane, read it back until the marker proves the body landed, retry a lost
 * `pane run`, then fail loud in the function's own name — and, for a harness
 * whose launch state is more than the function, run the caller's proof once the
 * launcher is up.
 *
 * The install is named by its caller, so these tests exercise a harness that
 * is not the pi family: nothing here may depend on the function being `pi`. The
 * pane is reached through the multiplexer's neutral `PaneControl`, so this test
 * hands the install a recording stand-in and never touches herdr.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaneControl } from "../src/agents/agent-host.js";
import {
  installPaneLauncher,
  type PaneLauncherSpec,
} from "../src/agents/harness/pane-launcher.js";

const SPEC: PaneLauncherSpec = {
  commandName: "codex",
  body: 'export HERDR_AGENT=codex; codex "$@"',
  signature: "CODEX_LAUNCHER_1a2b3c",
  readyMarker: "CODEX_VERIFIED",
};

/** A pane surface that records what was typed and whose waits are controllable. */
function makePane() {
  const run = vi.fn(async () => {});
  // A predicate decides, per waited-for output, whether the wait times out.
  let timesOut: (output: string) => boolean = () => false;
  const waitForOutput = vi.fn(
    async (_paneId: string, output: string): Promise<void> => {
      if (timesOut(output)) throw new Error("timed out waiting");
    },
  );
  const pane: PaneControl = { kind: "test", run, waitForOutput };
  return {
    pane,
    run,
    waitForOutput,
    timeOutWhen: (predicate: (output: string) => boolean): void => {
      timesOut = predicate;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("installPaneLauncher", () => {
  it("types the body into the pane as a function of the name it is given", async () => {
    const { pane, run } = makePane();

    await installPaneLauncher(pane, "w1:p1", SPEC);

    expect(run).toHaveBeenNthCalledWith(
      1,
      "w1:p1",
      'codex() { : "CODEX_LAUNCHER_1a2b3c"; export HERDR_AGENT=codex; codex "$@"; }',
    );
  });

  it("reads the named function back and waits for a marker the command line alone cannot produce", async () => {
    const { pane, run, waitForOutput } = makePane();

    await installPaneLauncher(pane, "w1:p1", SPEC);

    expect(run).toHaveBeenNthCalledWith(
      2,
      "w1:p1",
      'typeset -f codex 2>/dev/null | grep -q "CODEX_LAUNCHER_1a2b3c" && echo CODEX_""VERIFIED',
    );
    expect(waitForOutput).toHaveBeenCalledWith(
      "w1:p1",
      "CODEX_VERIFIED",
      expect.any(Number),
    );
  });

  it("stops after the first install the pane confirms", async () => {
    const { pane, run } = makePane();

    await installPaneLauncher(pane, "w1:p1", SPEC);

    // One define + one verify, no retry once the marker landed.
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("retries a run the pane never evaluated and fails loud in the function's name", async () => {
    vi.useFakeTimers();
    const { pane, run, timeOutWhen } = makePane();
    timeOutWhen(() => true);

    const promise = installPaneLauncher(pane, "w1:p1", SPEC);
    const assertion = expect(promise).rejects.toThrow(
      /the codex launcher never landed/,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    // One define + one verify per attempt.
    expect(run).toHaveBeenCalledTimes(10);
  });
});

describe("installPaneLauncher proof", () => {
  /** The same launcher, with the caller's second proof attached. */
  const PROVEN: PaneLauncherSpec = {
    ...SPEC,
    proof: {
      command: "codex agent list | grep -x 'abc (primary)'",
      output: "abc (primary)",
      timeoutMs: 5_000,
      failure: "the staged codex definition is not live",
    },
  };

  it("runs the caller's proof through the pane once the launcher has landed", async () => {
    const { pane, run, waitForOutput } = makePane();

    await installPaneLauncher(pane, "w1:p1", PROVEN);

    expect(run).toHaveBeenNthCalledWith(
      3,
      "w1:p1",
      "codex agent list | grep -x 'abc (primary)'",
    );
    expect(waitForOutput).toHaveBeenCalledWith("w1:p1", "abc (primary)", 5_000);
  });

  it("fails with the caller's message when the proof never answers, without retrying the install", async () => {
    const { pane, run, timeOutWhen } = makePane();
    // The launcher's own verification passes; only the proof's answer is missing.
    timeOutWhen((output) => output === "abc (primary)");

    await expect(installPaneLauncher(pane, "w1:p1", PROVEN)).rejects.toThrow(
      "the staged codex definition is not live",
    );
    // One define, one verify, one proof: a failed proof is not a lost `pane run`.
    expect(run).toHaveBeenCalledTimes(3);
  });
});
