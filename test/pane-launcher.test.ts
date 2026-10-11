/**
 * pane-launcher.test.ts — the pane-launcher install: type the function into the
 * pane, read it back until the marker proves the body landed, retry a lost
 * `pane run`, then fail loud in the function's own name.
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
