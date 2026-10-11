/**
 * pane-launcher.test.ts — the pane-launcher install: type the function into the
 * pane, read it back until the marker proves the body landed, retry a lost
 * `pane run`, then fail loud in the function's own name — and, for a harness
 * whose launch state is more than the function, run the caller's proof once the
 * launcher is up.
 *
 * The install is named by its caller, so these tests exercise a harness that
 * is not the pi family: nothing here may depend on the function being `pi`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  installPaneLauncher,
  type PaneLauncherSpec,
} from "../src/agents/harness/pane-launcher.js";

const { runInPaneMock, waitForPaneOutputMock } = vi.hoisted(() => ({
  runInPaneMock: vi.fn(),
  waitForPaneOutputMock: vi.fn(),
}));

vi.mock("../src/infrastructure/herdr-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/infrastructure/herdr-client.js")
    >();
  return {
    ...actual,
    runInPane: runInPaneMock,
    waitForPaneOutput: waitForPaneOutputMock,
  };
});

const PI = {} as unknown as ExtensionAPI;

const SPEC: PaneLauncherSpec = {
  commandName: "codex",
  body: 'export HERDR_AGENT=codex; codex "$@"',
  signature: "CODEX_LAUNCHER_1a2b3c",
  readyMarker: "CODEX_VERIFIED",
};

beforeEach(() => {
  runInPaneMock.mockReset().mockResolvedValue(undefined);
  waitForPaneOutputMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("installPaneLauncher", () => {
  it("types the body into the pane as a function of the name it is given", async () => {
    await installPaneLauncher(PI, "w1:p1", SPEC);

    expect(runInPaneMock).toHaveBeenNthCalledWith(
      1,
      PI,
      "w1:p1",
      'codex() { : "CODEX_LAUNCHER_1a2b3c"; export HERDR_AGENT=codex; codex "$@"; }',
    );
  });

  it("reads the named function back and waits for a marker the command line alone cannot produce", async () => {
    await installPaneLauncher(PI, "w1:p1", SPEC);

    expect(runInPaneMock).toHaveBeenNthCalledWith(
      2,
      PI,
      "w1:p1",
      'typeset -f codex 2>/dev/null | grep -q "CODEX_LAUNCHER_1a2b3c" && echo CODEX_""VERIFIED',
    );
    expect(waitForPaneOutputMock).toHaveBeenCalledWith(
      PI,
      "w1:p1",
      "CODEX_VERIFIED",
      expect.any(Number),
    );
  });

  it("stops after the first install the pane confirms", async () => {
    await installPaneLauncher(PI, "w1:p1", SPEC);

    // One define + one verify, no retry once the marker landed.
    expect(runInPaneMock).toHaveBeenCalledTimes(2);
  });

  it("retries a run the pane never evaluated and fails loud in the function's name", async () => {
    vi.useFakeTimers();
    waitForPaneOutputMock.mockRejectedValue(new Error("timed out waiting"));

    const promise = installPaneLauncher(PI, "w1:p1", SPEC);
    const assertion = expect(promise).rejects.toThrow(
      /the codex launcher never landed/,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    // One define + one verify per attempt.
    expect(runInPaneMock).toHaveBeenCalledTimes(10);
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
    await installPaneLauncher(PI, "w1:p1", PROVEN);

    expect(runInPaneMock).toHaveBeenNthCalledWith(
      3,
      PI,
      "w1:p1",
      "codex agent list | grep -x 'abc (primary)'",
    );
    expect(waitForPaneOutputMock).toHaveBeenCalledWith(
      PI,
      "w1:p1",
      "abc (primary)",
      5_000,
    );
  });

  it("fails with the caller's message when the proof never answers, without retrying the install", async () => {
    waitForPaneOutputMock.mockImplementation(async (_pi, _pane, match) => {
      // The launcher's own verification passes; only the proof's answer is missing.
      if (match === "abc (primary)") throw new Error("timed out waiting");
    });

    await expect(installPaneLauncher(PI, "w1:p1", PROVEN)).rejects.toThrow(
      "the staged codex definition is not live",
    );
    // One define, one verify, one proof: a failed proof is not a lost `pane run`.
    expect(runInPaneMock).toHaveBeenCalledTimes(3);
  });
});
