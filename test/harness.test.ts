/**
 * harness.test.ts — the harness contract: its id vocabulary and the pane
 * preparation shared by the pi-compatible harnesses (the shell tricks that point
 * the pane's `pi` at pig or pi-bolt).
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_HARNESS,
  HARNESS_IDS,
  resolveHarness,
} from "../src/agents/harness.js";
import { harnessFor } from "../src/agents/harness/registry.js";
import { probed, unprobed } from "../src/availability.js";

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

afterEach(() => {
  vi.useRealTimers();
});

describe("harness ids", () => {
  it("offers pi, pig, and pi-bolt, defaulting to pi", () => {
    expect([...HARNESS_IDS]).toEqual(["pi", "pig", "pi-bolt"]);
    expect(DEFAULT_HARNESS).toBe("pi");
  });
});

describe("resolveHarness", () => {
  it("leaves a harness the machine can launch alone", () => {
    expect(resolveHarness("pig", probed(["pi", "pig"]))).toBe("pig");
  });

  it("falls back to pi for a harness the machine cannot launch", () => {
    expect(resolveHarness("pig", probed(["pi"]))).toBe("pi");
    expect(resolveHarness("pi-bolt", probed(["pi", "pig"]))).toBe("pi");
  });

  it("leaves the configured harness alone until a probe says otherwise", () => {
    expect(resolveHarness("pi-bolt", unprobed())).toBe("pi-bolt");
  });
});

describe("available", () => {
  const realPath = process.env.PATH;
  const tmpDirs: string[] = [];

  /** A directory that becomes the whole PATH, so only what it holds is found. */
  function freshPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "harness-path-"));
    tmpDirs.push(dir);
    process.env.PATH = dir;
    return dir;
  }

  /** A runnable file, the way a real harness binary lands on PATH. */
  function executable(dir: string, name: string): void {
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(file, 0o755);
  }

  afterEach(() => {
    process.env.PATH = realPath;
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("launches pi whatever PATH says: it is the binary already running the pane", () => {
    process.env.PATH = "";

    expect(harnessFor("pi").available()).toBe(true);
  });

  it("finds each pi-compatible harness by its own binary name", () => {
    const dir = freshPath();
    expect(harnessFor("pig").available()).toBe(false);
    expect(harnessFor("pi-bolt").available()).toBe(false);

    executable(dir, "pig");
    expect(harnessFor("pig").available()).toBe(true);
    expect(harnessFor("pi-bolt").available()).toBe(false);

    executable(dir, "pi-bolt");
    expect(harnessFor("pi-bolt").available()).toBe(true);
  });

  it("follows a symlink to the binary, as a shell would", () => {
    const dir = freshPath();
    const real = join(dir, "real-pig");
    writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(real, join(dir, "pig"));

    expect(harnessFor("pig").available()).toBe(true);
  });

  it("is not fooled by a file that cannot be executed", () => {
    const dir = freshPath();
    writeFileSync(join(dir, "pig"), "#!/bin/sh\n", { mode: 0o644 });

    expect(harnessFor("pig").available()).toBe(false);
  });

  it("is not fooled by a directory named after the binary", () => {
    const dir = freshPath();
    mkdirSync(join(dir, "pig"));

    expect(harnessFor("pig").available()).toBe(false);
  });

  it("is not fooled by a broken symlink", () => {
    const dir = freshPath();
    symlinkSync(join(dir, "gone"), join(dir, "pig"));

    expect(harnessFor("pig").available()).toBe(false);
  });

  it("does not look in a directory that is not on PATH", () => {
    const dir = freshPath();
    const elsewhere = mkdtempSync(join(tmpdir(), "harness-elsewhere-"));
    tmpDirs.push(elsewhere);
    executable(elsewhere, "pig");

    expect(dir).not.toBe(elsewhere);
    expect(harnessFor("pig").available()).toBe(false);
  });
});

describe("prepare", () => {
  beforeEach(() => {
    runInPaneMock.mockReset().mockResolvedValue(undefined);
    waitForPaneOutputMock.mockReset().mockResolvedValue(undefined);
  });

  it("does nothing for pi: real pi is already the pane's `pi`", async () => {
    await harnessFor("pi").prepare({ pi: PI, paneId: "w1:p1", cwd: "/repo" });
    expect(runInPaneMock).not.toHaveBeenCalled();
    expect(waitForPaneOutputMock).not.toHaveBeenCalled();
  });

  it("plants the pi launcher in the pane for pig and confirms its body landed", async () => {
    await harnessFor("pig").prepare({ pi: PI, paneId: "w1:p9", cwd: "/repo" });
    expect(runInPaneMock).toHaveBeenNthCalledWith(
      1,
      PI,
      "w1:p9",
      'pi() { : "PIG_LAUNCHER_8f9a2b"; export HERDR_AGENT=pi; pig "$@"; }',
    );
    expect(runInPaneMock).toHaveBeenNthCalledWith(
      2,
      PI,
      "w1:p9",
      'typeset -f pi 2>/dev/null | grep -q "PIG_LAUNCHER_8f9a2b" && echo PIG_""VERIFIED',
    );
    expect(waitForPaneOutputMock).toHaveBeenCalledWith(
      PI,
      "w1:p9",
      "PIG_VERIFIED",
      expect.any(Number),
    );
  });

  it("plants its own pi launcher in the pane for pi-bolt and confirms its body landed", async () => {
    await harnessFor("pi-bolt").prepare({
      pi: PI,
      paneId: "w1:p9",
      cwd: "/repo",
    });
    expect(runInPaneMock).toHaveBeenNthCalledWith(
      1,
      PI,
      "w1:p9",
      'pi() { : "PI_BOLT_LAUNCHER_5e1c7a"; export HERDR_AGENT=pi; pi-bolt "$@"; }',
    );
    expect(runInPaneMock).toHaveBeenNthCalledWith(
      2,
      PI,
      "w1:p9",
      'typeset -f pi 2>/dev/null | grep -q "PI_BOLT_LAUNCHER_5e1c7a" && echo PI_""BOLT_VERIFIED',
    );
    expect(waitForPaneOutputMock).toHaveBeenCalledWith(
      PI,
      "w1:p9",
      "PI_BOLT_VERIFIED",
      expect.any(Number),
    );
  });

  it("verifies each pi-compatible harness against its own signature", async () => {
    await harnessFor("pig").prepare({ pi: PI, paneId: "w1:p1", cwd: "/repo" });
    const pigVerify = runInPaneMock.mock.calls[1][2];
    runInPaneMock.mockClear();

    await harnessFor("pi-bolt").prepare({
      pi: PI,
      paneId: "w1:p2",
      cwd: "/repo",
    });
    const boltVerify = runInPaneMock.mock.calls[1][2];

    expect(pigVerify).toContain("PIG_LAUNCHER_8f9a2b");
    expect(boltVerify).toContain("PI_BOLT_LAUNCHER_5e1c7a");
    expect(boltVerify).not.toContain("PIG_LAUNCHER_8f9a2b");
  });

  it("retries a lost `pane run` and fails loud when the launcher never lands", async () => {
    vi.useFakeTimers();
    waitForPaneOutputMock.mockRejectedValue(new Error("timed out waiting"));

    const promise = harnessFor("pi-bolt").prepare({
      pi: PI,
      paneId: "w1:p9",
      cwd: "/repo",
    });
    const assertion = expect(promise).rejects.toThrow(
      /the pi launcher never landed/,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    // One define + one verify per attempt.
    expect(runInPaneMock.mock.calls.length).toBe(10);
  });
});
