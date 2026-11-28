/**
 * pane-launcher.test.ts — the pane-launcher install: stage the function and its
 * read-back in a file, have the pane source it until the marker proves the body
 * landed, retry a lost `pane run`, then fail loud in the function's own name —
 * and, for a harness whose launch state is more than the function, source the
 * caller's staged proof once the launcher is up.
 *
 * The install is named by its caller, so these tests exercise a harness that
 * is not the pi family: nothing here may depend on the function being `pi`. The
 * pane is reached through the multiplexer's neutral `PaneControl`, so this test
 * hands the install a recording stand-in and never touches herdr.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneControl } from "../src/agents/agent-host.js";
import {
  installPaneLauncher,
  singleQuoteShellWord,
  type PaneLauncherSpec,
} from "../src/agents/harness/pane-launcher.js";
import { sourcedLines } from "./sourced-file.js";

/** This test's staging root; the launcher file sits in a directory inside it. */
let root: string;
let SPEC: PaneLauncherSpec;

const LAUNCHER: Omit<PaneLauncherSpec, "file"> = {
  agentMultiplexerKind: "codex",
  body: 'codex "$@"',
  signature: "CODEX_LAUNCHER_1a2b3c",
  readyMarker: "CODEX_VERIFIED",
};

/** A pane surface that records what was typed and whose waits are controllable. */
function makePane() {
  const run = vi.fn(async (_paneId: string, _command: string) => {});
  // A predicate decides, per waited-for output, whether the wait times out.
  let timesOut: (output: string) => boolean = () => false;
  const waitForOutput = vi.fn(
    async (_paneId: string, output: string): Promise<void> => {
      if (timesOut(output)) throw new Error("timed out waiting");
    },
  );
  const pane: PaneControl = {
    kind: "test",
    run,
    sendKeys: async () => {},
    waitForOutput,
  };
  return {
    pane,
    run,
    waitForOutput,
    timeOutWhen: (predicate: (output: string) => boolean): void => {
      timesOut = predicate;
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cowboy-launcher-"));
  // A directory the install has to create: a harness names a path, not a tree.
  SPEC = { ...LAUNCHER, file: join(root, "abc", "launcher.sh") };
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe("installPaneLauncher", () => {
  it("types only the command that sources the staged launcher", async () => {
    const { pane, run } = makePane();

    await installPaneLauncher(pane, "w1:p1", SPEC);

    expect(run).toHaveBeenNthCalledWith(
      1,
      "w1:p1",
      `. ${singleQuoteShellWord(SPEC.file)}`,
    );
  });

  it("quotes a staged path that holds a single quote", async () => {
    const { pane, run } = makePane();
    const file = join(root, "it's", "launcher.sh");

    await installPaneLauncher(pane, "w1:p1", { ...SPEC, file });

    expect(run).toHaveBeenNthCalledWith(
      1,
      "w1:p1",
      `. '${file.replaceAll("'", "'\\''")}'`,
    );
    // The quoted path still names the staged file.
    expect(sourcedLines(run.mock.calls[0]![1])[0]).toContain(
      "CODEX_LAUNCHER_1a2b3c",
    );
  });

  it("stages the body as a function of the name it is given, then its read-back", async () => {
    const { pane, run, waitForOutput } = makePane();

    await installPaneLauncher(pane, "w1:p1", SPEC);

    // The marker rides split, so an echo of the staged text cannot produce it.
    expect(sourcedLines(run.mock.calls[0]![1])).toEqual([
      'codex() { : "CODEX_LAUNCHER_1a2b3c"; codex "$@"; }',
      'typeset -f codex 2>/dev/null | grep -q "CODEX_LAUNCHER_1a2b3c" && echo CODEX_""VERIFIED',
    ]);
    expect(waitForOutput).toHaveBeenCalledWith(
      "w1:p1",
      "CODEX_VERIFIED",
      expect.any(Number),
    );
  });

  it("stages the launcher owner-only", async () => {
    const { pane } = makePane();

    await installPaneLauncher(pane, "w1:p1", SPEC);

    expect(statSync(SPEC.file).mode & 0o777).toBe(0o600);
  });

  it("stops after the first install the pane confirms", async () => {
    const { pane, run } = makePane();

    await installPaneLauncher(pane, "w1:p1", SPEC);

    expect(run).toHaveBeenCalledTimes(1);
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

    // One sourced launcher per attempt.
    expect(run).toHaveBeenCalledTimes(5);
  });
});

describe("installPaneLauncher multiplexer environment", () => {
  it("exports the multiplexer's identity variable in a subshell", async () => {
    const { pane, run } = makePane();
    const herdr: PaneControl = {
      ...pane,
      launchEnvironment: (kind): Readonly<Record<string, string>> =>
        kind === "codex" ? { HERDR_AGENT: "codex" } : {},
    };

    await installPaneLauncher(herdr, "w1:p1", SPEC);

    expect(sourcedLines(run.mock.calls[0]![1])[0]).toBe(
      'codex() { : "CODEX_LAUNCHER_1a2b3c"; ( export HERDR_AGENT=\'codex\' && { codex "$@"; } ); }',
    );
  });

  it("leaves the body unchanged when the multiplexer needs nothing", async () => {
    const { pane, run } = makePane();
    const quiet: PaneControl = { ...pane, launchEnvironment: () => ({}) };

    await installPaneLauncher(quiet, "w1:p1", SPEC);

    expect(sourcedLines(run.mock.calls[0]![1])[0]).toBe(
      'codex() { : "CODEX_LAUNCHER_1a2b3c"; codex "$@"; }',
    );
  });

  it("refuses a name that is not an identifier and stages nothing", async () => {
    const { pane } = makePane();
    const broken: PaneControl = {
      ...pane,
      launchEnvironment: () => ({ "BAD NAME": "x" }),
    };

    await expect(installPaneLauncher(broken, "w1:p1", SPEC)).rejects.toThrow(
      /invalid launch environment name/,
    );
    expect(existsSync(SPEC.file)).toBe(false);
  });

  it("refuses a value carrying a control character", async () => {
    const { pane } = makePane();
    const broken: PaneControl = {
      ...pane,
      launchEnvironment: () => ({ HERDR_AGENT: "pi\nrm -rf /" }),
    };

    await expect(installPaneLauncher(broken, "w1:p1", SPEC)).rejects.toThrow(
      /control character/,
    );
  });
});

describe("installPaneLauncher proof", () => {
  const PROOF = {
    command: "codex agent list | grep -x 'abc (primary)'",
    output: "abc (primary)",
    timeoutMs: 5_000,
    failure: "the staged codex definition is not live",
  };

  it("sources the caller's staged proof once the launcher has landed", async () => {
    const { pane, run, waitForOutput } = makePane();

    await installPaneLauncher(pane, "w1:p1", { ...SPEC, proof: PROOF });

    expect(run).toHaveBeenNthCalledWith(
      2,
      "w1:p1",
      `. ${singleQuoteShellWord(`${SPEC.file}.proof`)}`,
    );
    expect(sourcedLines(run.mock.calls[1]![1])).toEqual([
      "codex agent list | grep -x 'abc (primary)'",
    ]);
    expect(waitForOutput).toHaveBeenCalledWith("w1:p1", "abc (primary)", 5_000);
  });

  it("fails with the caller's message when the proof never answers, without retrying the install", async () => {
    const { pane, run, timeOutWhen } = makePane();
    // The launcher's own verification passes; only the proof's answer is missing.
    timeOutWhen((output) => output === "abc (primary)");

    await expect(
      installPaneLauncher(pane, "w1:p1", { ...SPEC, proof: PROOF }),
    ).rejects.toThrow("the staged codex definition is not live");
    // One install, one proof: a failed proof is not a lost `pane run`.
    expect(run).toHaveBeenCalledTimes(2);
  });
});
