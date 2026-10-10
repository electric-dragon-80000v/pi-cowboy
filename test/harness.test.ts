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
  type ExtensionLaunchMode,
  type HarnessLaunchRequest,
  type SkillLaunchMode,
  type ToolSelection,
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

describe("buildArgs", () => {
  /** A launch request with every optional arm absent. */
  function request(
    overrides: Partial<HarnessLaunchRequest> = {},
  ): HarnessLaunchRequest {
    return {
      subagentId: "esp02hpw",
      systemPromptFile: "/spawn/esp02hpw/system.md",
      taskFile: "/spawn/esp02hpw/task.md",
      resultFile: "/spawn/esp02hpw/result.md",
      modelKey: null,
      toolSelection: { kind: "default" } satisfies ToolSelection,
      thinkingLevel: null,
      forkSessionFile: null,
      skills: { kind: "default" } satisfies SkillLaunchMode,
      extensions: { kind: "default" } satisfies ExtensionLaunchMode,
      projectTrusted: true,
      ...overrides,
    };
  }

  const BASE = [
    "--system-prompt",
    "/spawn/esp02hpw/system.md",
    "--append-system-prompt",
    "cowboy-subagent-esp02hpw",
    "--name",
    "esp02hpw",
    "--no-context-files",
    "--approve",
    "@/spawn/esp02hpw/task.md",
  ];

  // One harness belongs to the pi family; the binary behind the pane's `pi`
  // takes the same CLI, so the family shares its argv assembly.
  it.each(["pi", "pig", "pi-bolt"] as const)(
    "%s launches the pi family's argv",
    (id) => {
      expect(harnessFor(id).buildArgs(request())).toEqual(BASE);
    },
  );

  it("derives the report token from the subagent id, never a second field", () => {
    const args = harnessFor("pi").buildArgs(
      request({ subagentId: "another-id" }),
    );

    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(
      "cowboy-subagent-another-id",
    );
  });

  it("carries the resolved model, thinking, and fork only when they exist", () => {
    const withAll = harnessFor("pi").buildArgs(
      request({
        modelKey: "override/special-model",
        thinkingLevel: "high",
        forkSessionFile: "/sessions/parent.jsonl",
      }),
    );
    expect(withAll).toEqual(
      expect.arrayContaining([
        "--model",
        "override/special-model",
        "--thinking",
        "high",
        "--fork",
        "/sessions/parent.jsonl",
      ]),
    );

    const bare = harnessFor("pi").buildArgs(request());
    expect(bare).not.toContain("--model");
    expect(bare).not.toContain("--thinking");
    expect(bare).not.toContain("--fork");
  });

  it("maps the tool selection union onto pi's tool flags", () => {
    expect(
      harnessFor("pi").buildArgs(request({ toolSelection: { kind: "none" } })),
    ).toEqual(expect.arrayContaining(["--no-tools"]));

    const include = harnessFor("pi").buildArgs(
      request({ toolSelection: { kind: "include", names: ["read", "write"] } }),
    );
    expect(include).toEqual(expect.arrayContaining(["--tools", "read,write"]));

    const exclude = harnessFor("pi").buildArgs(
      request({ toolSelection: { kind: "exclude", names: ["read"] } }),
    );
    expect(exclude).toEqual(
      expect.arrayContaining(["--exclude-tools", "read"]),
    );

    // The default case emits no tool flag: pi's own discovery stands.
    expect(harnessFor("pi").buildArgs(request())).not.toContain("--no-tools");
  });

  it("withholds skills and extensions by their modes", () => {
    const noSkills = harnessFor("pi").buildArgs(
      request({ skills: { kind: "none" } }),
    );
    expect(noSkills).toContain("--no-skills");

    const noExt = harnessFor("pi").buildArgs(
      request({ extensions: { kind: "none" } }),
    );
    expect(noExt).toContain("--no-extensions");

    const extPaths = harnessFor("pi").buildArgs(
      request({ extensions: { kind: "paths", paths: ["npm:pi-intercom"] } }),
    );
    expect(extPaths).toEqual(
      expect.arrayContaining(["--no-extensions", "-e", "npm:pi-intercom"]),
    );
  });

  it("swaps the approve flag on an untrusted project", () => {
    const args = harnessFor("pi").buildArgs(request({ projectTrusted: false }));

    expect(args).toEqual(expect.arrayContaining(["--no-approve"]));
    expect(args).not.toContain("--approve");
  });

  it("rides the task as a trailing @file so the text never crosses argv", () => {
    const args = harnessFor("pi").buildArgs(request());

    expect(args.at(-1)).toBe("@/spawn/esp02hpw/task.md");
  });
});

describe("teardown", () => {
  it.each(["pi", "pig", "pi-bolt"] as const)(
    "%s has no filesystem state to undo: the launcher dies with the pane",
    async (id) => {
      await expect(
        harnessFor(id).teardown({
          pi: PI,
          paneId: "w1:p1",
          cwd: "/repo",
          subagentId: "esp02hpw",
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("tolerates a teardown called with nothing to remove (a run that never prepared)", async () => {
    await expect(
      harnessFor("pi").teardown({
        pi: PI,
        paneId: null,
        cwd: null,
        subagentId: "esp02hpw",
      }),
    ).resolves.toBeUndefined();
  });
});
