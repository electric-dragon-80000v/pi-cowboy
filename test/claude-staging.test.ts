/**
 * claude-staging.test.ts — the claude harness: the config directory it stages,
 * the launcher it plants in the pane, the argv it builds, and the constant
 * model list it answers.
 *
 * Staging is asserted as parsed files rather than exact bytes, so the proof
 * is about the answers claude reads (theme, bypass acceptance, onboarding,
 * workspace trust), not their serialization. The pane side is asserted as the
 * exact shell the pane runs, because quoting there is the whole of the
 * launcher's correctness.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  ClaudeLaunchRequest,
  SubagentLaunchInputs,
} from "../src/agents/harness.js";
import { harnessFor } from "../src/agents/harness/registry.js";
import {
  claudeConfigDir,
  removeClaudeStaging,
  writeClaudeStaging,
} from "../src/agents/harness/claude/staging.js";

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

/** The subagent these tests stage; the shape a spawn id has. */
const SUBAGENT_ID = "esp02hpw";

/**
 * The real TMPDIR, put back after every test. Staging resolves its directory
 * per call, so a test that stages redirects TMPDIR rather than writing into the
 * machine's own staging area.
 */
let realTmpdir: string | undefined;

/** Temporary roots this file made; removed after every test, pass or fail. */
const madeRoots: string[] = [];

/** The root this test redirected TMPDIR to. */
let tmpRoot: string;

/** A name inside this test's redirected TMPDIR. */
function inTmpRoot(name: string): string {
  return join(tmpRoot, name);
}

/** The launch inputs every claude launch carries. */
function launchInputs(
  overrides: Partial<ClaudeLaunchRequest> = {},
): ClaudeLaunchRequest {
  const shared: SubagentLaunchInputs = {
    subagentId: SUBAGENT_ID,
    systemPromptFile: "/spawn/esp02hpw/system.md",
    taskFile: "/spawn/esp02hpw/task.md",
    resultFile: "/spawn/esp02hpw/result.md",
    modelKey: null,
    toolSelection: { kind: "default" },
  };
  return { ...shared, family: "claude", ...overrides };
}

beforeEach(() => {
  realTmpdir = process.env.TMPDIR;
  tmpRoot = mkdtempSync(join(tmpdir(), "cowboy-claude-"));
  madeRoots.push(tmpRoot);
  process.env.TMPDIR = tmpRoot;
  runInPaneMock.mockReset().mockResolvedValue(undefined);
  waitForPaneOutputMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  // Remove through the module, with the redirected TMPDIR still in place.
  removeClaudeStaging(SUBAGENT_ID);
  if (realTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmpdir;
  for (const root of madeRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("claudeConfigDir", () => {
  it("names the config directory under the spawn's staging directory", () => {
    expect(claudeConfigDir(SUBAGENT_ID)).toBe(
      join(tmpdir(), "pi-cowboy", SUBAGENT_ID, "claude"),
    );
  });
});

describe("writeClaudeStaging", () => {
  it("writes the settings and the state file, and nothing else", () => {
    const dir = writeClaudeStaging({ subagentId: SUBAGENT_ID, cwd: tmpRoot });

    expect(dir).toBe(claudeConfigDir(SUBAGENT_ID));
    expect(readdirSync(dir).sort()).toEqual([".claude.json", "settings.json"]);
  });

  it("stages the answers the TUI's dialogs read", () => {
    const dir = writeClaudeStaging({ subagentId: SUBAGENT_ID, cwd: tmpRoot });

    const settings: unknown = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf-8"),
    );
    // The theme skips the syntax-theme picker; the persisted acceptance is the
    // half of `--dangerously-skip-permissions` the argv cannot carry.
    expect(settings).toEqual({
      theme: "dark",
      skipDangerousModePermissionPrompt: true,
    });

    const state: unknown = JSON.parse(
      readFileSync(join(dir, ".claude.json"), "utf-8"),
    );
    // Onboarding marked complete, and the spawn's own directory trusted — keyed
    // by the canonical path, the spelling claude looks the workspace up under.
    expect(state).toEqual({
      hasCompletedOnboarding: true,
      projects: {
        [realpathSync.native(tmpRoot)]: { hasTrustDialogAccepted: true },
      },
    });
  });

  it("keys the trust entry by the given path when it has no canonical one", () => {
    const missing = inTmpRoot("never-created");
    expect(existsSync(missing)).toBe(false);

    const dir = writeClaudeStaging({ subagentId: SUBAGENT_ID, cwd: missing });

    const state = JSON.parse(
      readFileSync(join(dir, ".claude.json"), "utf-8"),
    ) as { projects: Record<string, unknown> };
    expect(Object.keys(state.projects)).toEqual([missing]);
  });

  it("seeds no credential-derived state: approval stays the user's to give", () => {
    const dir = writeClaudeStaging({ subagentId: SUBAGENT_ID, cwd: tmpRoot });

    const stateText = readFileSync(join(dir, ".claude.json"), "utf-8");
    expect(stateText).not.toContain("customApiKeyResponses");
    expect(stateText).not.toContain("approved");
  });

  it("replaces the staging a previous call wrote", () => {
    const first = inTmpRoot("first");
    writeClaudeStaging({ subagentId: SUBAGENT_ID, cwd: first });
    const dir = writeClaudeStaging({ subagentId: SUBAGENT_ID, cwd: tmpRoot });

    const state = JSON.parse(
      readFileSync(join(dir, ".claude.json"), "utf-8"),
    ) as { projects: Record<string, unknown> };
    expect(Object.keys(state.projects)).toEqual([realpathSync.native(tmpRoot)]);
  });
});

describe("removeClaudeStaging", () => {
  it("removes the staging tree it wrote", () => {
    const dir = writeClaudeStaging({ subagentId: SUBAGENT_ID, cwd: tmpRoot });
    expect(existsSync(dir)).toBe(true);

    removeClaudeStaging(SUBAGENT_ID);

    expect(existsSync(dir)).toBe(false);
  });

  it("does nothing when the staging tree is already gone", () => {
    expect(existsSync(claudeConfigDir(SUBAGENT_ID))).toBe(false);

    expect(() => removeClaudeStaging(SUBAGENT_ID)).not.toThrow();
  });
});

describe("prepare", () => {
  /** A task file under a path with a space, so the launcher's quoting is asserted, not assumed. */
  let taskFile: string;

  beforeEach(() => {
    mkdirSync(join(tmpRoot, "my tasks"), { recursive: true });
    taskFile = inTmpRoot(join("my tasks", "prompt.md"));
    writeFileSync(taskFile, "do the thing\n\nand the second thing\n");
  });

  /** Prepare one claude launch into a pane. */
  function prepareClaude(paneId = "w1:p9"): Promise<void> {
    return harnessFor("claude").prepare({
      pi: PI,
      paneId,
      cwd: tmpRoot,
      launch: launchInputs({ taskFile }),
    });
  }

  it("stages the config directory and plants the launcher that points claude at it", async () => {
    await prepareClaude();

    const configDir = claudeConfigDir(SUBAGENT_ID);
    expect(runInPaneMock).toHaveBeenNthCalledWith(
      1,
      PI,
      "w1:p9",
      `claude() { : "CLAUDE_LAUNCHER_3f7a1d"; export CLAUDE_CONFIG_DIR='${configDir}'; export CLAUDE_CODE_DISABLE_CLAUDE_MDS=1; command claude "$@" -- "$(cat '${taskFile}')"; }`,
    );
    expect(runInPaneMock).toHaveBeenNthCalledWith(
      2,
      PI,
      "w1:p9",
      'typeset -f claude 2>/dev/null | grep -q "CLAUDE_LAUNCHER_3f7a1d" && echo CLAUDE_""VERIFIED',
    );
    expect(waitForPaneOutputMock).toHaveBeenCalledWith(
      PI,
      "w1:p9",
      "CLAUDE_VERIFIED",
      expect.any(Number),
    );

    // The tree the launcher names is really there.
    expect(existsSync(join(configDir, "settings.json"))).toBe(true);
    expect(existsSync(join(configDir, ".claude.json"))).toBe(true);
  });

  it("ends option parsing before the task so variadic tool flags cannot swallow it", async () => {
    await harnessFor("claude").prepare({
      pi: PI,
      paneId: "w1:p9",
      cwd: tmpRoot,
      launch: launchInputs({
        taskFile,
        toolSelection: { kind: "include", names: ["Bash", "Read"] },
      }),
    });

    // `--tools` / `--disallowedTools` take `<tools...>`: without the `--`, the
    // task appended after them would parse as another tool name and the TUI
    // would start with no initial prompt.
    const definition = runInPaneMock.mock.calls[0]?.[2] as string;
    expect(definition).toContain(`-- "$(cat '${taskFile}')"`);
  });

  it("proves the pane sees the staged files and resolves the binary", async () => {
    await prepareClaude();

    const configDir = claudeConfigDir(SUBAGENT_ID);
    expect(runInPaneMock).toHaveBeenNthCalledWith(
      3,
      PI,
      "w1:p9",
      `test -r '${configDir}/settings.json' && test -r '${taskFile}' && command -v claude >/dev/null && echo CLAUDE_""STAGED`,
    );
    expect(waitForPaneOutputMock).toHaveBeenCalledWith(
      PI,
      "w1:p9",
      "CLAUDE_STAGED",
      expect.any(Number),
    );
  });

  it("fails loud when the pane never proves the staged state", async () => {
    waitForPaneOutputMock.mockImplementation(async (_pi, _pane, match) => {
      // The launcher's own verification still passes; only the staged proof fails.
      if (match === "CLAUDE_STAGED") {
        throw new Error("timed out waiting for pane output");
      }
    });

    await expect(prepareClaude()).rejects.toThrow(
      /never proved it can see the staged claude state.*did not start/s,
    );
  });

  it("stages and installs again when prepare is called twice", async () => {
    await prepareClaude();
    await expect(prepareClaude()).resolves.toBeUndefined();

    expect(
      existsSync(join(claudeConfigDir(SUBAGENT_ID), "settings.json")),
    ).toBe(true);
    // Two installs, each verified with its proof: no state accumulates behind
    // the second.
    expect(runInPaneMock).toHaveBeenCalledTimes(6);
  });
});

describe("buildArgs", () => {
  const BASE = [
    "--system-prompt-file",
    "/spawn/esp02hpw/system.md",
    "--append-system-prompt",
    "cowboy-subagent-esp02hpw",
    "-n",
    "esp02hpw",
    "--dangerously-skip-permissions",
    "--setting-sources",
    "user",
    "--strict-mcp-config",
  ];

  it("launches the interactive CLI with the staged prompt and the spawn identity", () => {
    expect(harnessFor("claude").buildArgs(launchInputs())).toEqual(BASE);
  });

  it("carries no task text: the launcher appends it past herdr's argv", () => {
    const args = harnessFor("claude").buildArgs(launchInputs());

    expect(args).not.toContain("/spawn/esp02hpw/task.md");
    expect(args.some((arg) => arg.includes("do the thing"))).toBe(false);
  });

  it("emits no argument herdr would refuse", () => {
    const launches = [
      launchInputs(),
      launchInputs({ subagentId: "another-id" }),
    ];
    const multiline = launches
      .flatMap((launch) => harnessFor("claude").buildArgs(launch))
      .filter((arg) => /[\r\n]/.test(arg));

    expect(multiline).toEqual([]);
  });

  it("derives the report token from the subagent id, never a second field", () => {
    const args = harnessFor("claude").buildArgs(
      launchInputs({ subagentId: "another-id" }),
    );

    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(
      "cowboy-subagent-another-id",
    );
    expect(args[args.indexOf("-n") + 1]).toBe("another-id");
  });

  it("carries the model only when one was resolved, as the bare name the CLI takes", () => {
    expect(
      harnessFor("claude").buildArgs(
        launchInputs({ modelKey: "anthropic/sonnet" }),
      ),
    ).toEqual([...BASE, "--model", "sonnet"]);

    expect(
      harnessFor("claude").buildArgs(launchInputs({ modelKey: null })),
    ).not.toContain("--model");
  });

  it("strips only the anthropic prefix: any other key rides as written", () => {
    const args = harnessFor("claude").buildArgs(
      launchInputs({ modelKey: "openai/gpt-5" }),
    );

    expect(args).toEqual(expect.arrayContaining(["--model", "openai/gpt-5"]));
  });

  it("maps the tool selection union onto claude's own tool flags, untranslated", () => {
    expect(
      harnessFor("claude").buildArgs(
        launchInputs({ toolSelection: { kind: "none" } }),
      ),
    ).toEqual([...BASE, "--tools", ""]);

    expect(
      harnessFor("claude").buildArgs(
        launchInputs({
          toolSelection: { kind: "include", names: ["Bash", "Read"] },
        }),
      ),
    ).toEqual([...BASE, "--tools", "Bash,Read"]);

    expect(
      harnessFor("claude").buildArgs(
        launchInputs({ toolSelection: { kind: "exclude", names: ["Bash"] } }),
      ),
    ).toEqual([...BASE, "--disallowedTools", "Bash"]);

    // The default case emits no tool flag: claude's own discovery stands.
    expect(harnessFor("claude").buildArgs(launchInputs())).not.toContain(
      "--tools",
    );
  });
});

describe("listModels", () => {
  it("answers the curated aliases, keyed anthropic/<alias>", async () => {
    const entries = await harnessFor("claude").listModels({
      pi: PI,
      modelCatalog: { getAvailable: () => [] },
    });

    expect(entries).toEqual([
      { key: "anthropic/haiku", label: "haiku" },
      { key: "anthropic/sonnet", label: "sonnet" },
      { key: "anthropic/opus", label: "opus" },
    ]);
  });

  it("warms nothing: the list is a constant, not a fetch", () => {
    expect(() => harnessFor("claude").prefetchModels(PI)).not.toThrow();
  });
});

describe("teardown", () => {
  it("removes the staging tree the launch read", async () => {
    const configDir = writeClaudeStaging({
      subagentId: SUBAGENT_ID,
      cwd: tmpRoot,
    });
    expect(existsSync(configDir)).toBe(true);

    await expect(
      harnessFor("claude").teardown({
        pi: PI,
        paneId: "w1:p1",
        cwd: "/repo",
        subagentId: SUBAGENT_ID,
      }),
    ).resolves.toBeUndefined();

    expect(existsSync(configDir)).toBe(false);
  });

  it("tolerates a teardown with nothing to remove", async () => {
    await expect(
      harnessFor("claude").teardown({
        pi: PI,
        paneId: null,
        cwd: null,
        subagentId: "never-staged",
      }),
    ).resolves.toBeUndefined();
  });
});
