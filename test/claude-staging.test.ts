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
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PaneControl } from "../src/agents/agent-host.js";
import type {
  ClaudeLaunchRequest,
  SubagentLaunchInputs,
} from "../src/agents/harness.js";
import { createHarnessRegistry } from "../src/agents/harness/harness-registry.js";
import { spawnCredentialStore } from "../src/agents/harness/claude/index.js";
import {
  claudeConfigDir,
  claudeProjectDir,
  claudeProjectsDir,
  claudeProjectsStore,
  claudeSessionRecordFile,
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
const harnesses = createHarnessRegistry();
const harnessFor = harnesses.require.bind(harnesses);

/** The pane surface claude's prepare reaches: the herdr calls this file mocks. */
const PANE: PaneControl = {
  kind: "herdr",
  run: (paneId, command) => runInPaneMock(PI, paneId, command),
  waitForOutput: (paneId, output, timeoutMs) =>
    waitForPaneOutputMock(PI, paneId, output, timeoutMs),
};

/** The subagent these tests stage; the shape a spawn id has. */
const SUBAGENT_ID = "esp02hpw";

/**
 * The real TMPDIR, put back after every test. Staging resolves its directory
 * per call, so a test that stages redirects TMPDIR rather than writing into the
 * machine's own staging area.
 */
let realTmpdir: string | undefined;

/** Credential-store variables a test may set; cleared and restored around each test. */
const CREDENTIAL_ENV_VARS = [
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
] as const;

/** The values those variables held before the test, restored afterwards. */
let savedCredentialEnv: Record<string, string | undefined>;

/** Temporary roots this file made; removed after every test, pass or fail. */
const madeRoots: string[] = [];

/** The real HOME, put back after every test: the store resolves under it. */
let realHome: string | undefined;

/** The root this test redirected TMPDIR to. */
let tmpRoot: string;

/** A name inside this test's redirected TMPDIR. */
function inTmpRoot(name: string): string {
  return join(tmpRoot, name);
}

/**
 * Write a transcript the way claude does — through the staged store link — so
 * tests can assert what survives staging and teardown.
 */
function writeTranscript(
  configDir: string,
  sessionId = "9d0f1e42-0a1c-4c2b-9b3e-5f6a7b8c9d0e",
): string {
  const viaLink = claudeProjectDir(configDir, tmpRoot);
  mkdirSync(viaLink, { recursive: true });
  writeFileSync(
    join(viaLink, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: "user", sessionId })}\n`,
  );
  // The durable path the link resolves to, which is where the bytes really are
  // once the config directory is gone.
  return join(claudeProjectsStore(), basename(viaLink), `${sessionId}.jsonl`);
}

/** The run record a staged config directory carries, parsed. */
function sessionRecordOf(configDir: string): unknown {
  return JSON.parse(readFileSync(claudeSessionRecordFile(configDir), "utf-8"));
}

/** The session id the last staging run recorded, read back the way the export reads it. */
function stagedSessionId(subagentId = SUBAGENT_ID): string {
  return (sessionRecordOf(claudeConfigDir(subagentId)) as { sessionId: string })
    .sessionId;
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
    thinking: null,
    toolSelection: { kind: "default" },
    envFile: null,
  };
  return { ...shared, family: "claude", ...overrides };
}

beforeEach(() => {
  realTmpdir = process.env.TMPDIR;
  tmpRoot = mkdtempSync(join(tmpdir(), "cowboy-claude-"));
  madeRoots.push(tmpRoot);
  process.env.TMPDIR = tmpRoot;
  realHome = process.env.HOME;
  process.env.HOME = inTmpRoot("home");
  savedCredentialEnv = {};
  for (const name of CREDENTIAL_ENV_VARS) {
    savedCredentialEnv[name] = process.env[name];
    delete process.env[name];
  }
  runInPaneMock.mockReset().mockResolvedValue(undefined);
  waitForPaneOutputMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  // Remove through the module, with the redirected TMPDIR still in place.
  removeClaudeStaging(SUBAGENT_ID);
  if (realTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmpdir;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  for (const name of CREDENTIAL_ENV_VARS) {
    const value = savedCredentialEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
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
  it("writes the settings, the state file, the run record, and the store link", () => {
    const { configDir: dir } = writeClaudeStaging({
      subagentId: SUBAGENT_ID,
      cwd: tmpRoot,
    });

    expect(dir).toBe(claudeConfigDir(SUBAGENT_ID));
    expect(readdirSync(dir).sort()).toEqual([
      ".claude.json",
      "projects",
      "session.json",
      "settings.json",
    ]);
  });

  it("records the session id it minted, a fresh UUID per launch", () => {
    const first = writeClaudeStaging({ subagentId: SUBAGENT_ID, cwd: tmpRoot });
    // Read before the second launch stages, which overwrites the record.
    expect(sessionRecordOf(first.configDir)).toEqual({
      sessionId: first.sessionId,
    });

    const second = writeClaudeStaging({
      subagentId: SUBAGENT_ID,
      cwd: tmpRoot,
    });

    expect(sessionRecordOf(second.configDir)).toEqual({
      sessionId: second.sessionId,
    });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(first.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("links the project store to the user's own store, so no transcript lives in the staging tree", () => {
    const { configDir } = writeClaudeStaging({
      subagentId: SUBAGENT_ID,
      cwd: tmpRoot,
    });

    const link = claudeProjectsDir(configDir);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(claudeProjectsStore());
    expect(claudeProjectsStore()).toBe(
      join(tmpRoot, "home", ".claude", "projects"),
    );
    expect(statSync(claudeProjectsStore()).isDirectory()).toBe(true);
  });

  it("links to the store the launching session's config dir names", () => {
    const sessionConfigDir = inTmpRoot("session-config");
    process.env.CLAUDE_CONFIG_DIR = sessionConfigDir;

    const { configDir } = writeClaudeStaging({
      subagentId: SUBAGENT_ID,
      cwd: tmpRoot,
    });

    expect(readlinkSync(claudeProjectsDir(configDir))).toBe(
      join(sessionConfigDir, "projects"),
    );
  });

  it("refuses to replace a real directory standing where the link goes", () => {
    mkdirSync(join(claudeConfigDir(SUBAGENT_ID), "projects"), {
      recursive: true,
    });

    expect(() =>
      writeClaudeStaging({ subagentId: SUBAGENT_ID, cwd: tmpRoot }),
    ).toThrow(/is not a link to .*could remove session transcripts/);
  });

  it("stages the answers the TUI's dialogs read", () => {
    const { configDir: dir } = writeClaudeStaging({
      subagentId: SUBAGENT_ID,
      cwd: tmpRoot,
    });

    const settings: unknown = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf-8"),
    );
    // The theme skips the syntax-theme picker; the persisted acceptance is the
    // half of `--dangerously-skip-permissions` the argv cannot carry. The
    // helper carries no key material — only the variable the launcher fills —
    // so the consent predicate, which reads `ANTHROPIC_API_KEY`, never fires
    // once the launcher renames it away.
    expect(settings).toEqual({
      apiKeyHelper: `printf '%s' "$COWBOY_API_KEY"`,
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

  it("keeps the helper on exactly one line, whose removal leaves valid settings", () => {
    const { configDir: dir } = writeClaudeStaging({
      subagentId: SUBAGENT_ID,
      cwd: tmpRoot,
    });
    const text = readFileSync(join(dir, "settings.json"), "utf-8");

    // The pane-side trim deletes the helper's line by key name (see the
    // launcher), so the staged file must keep the helper deletable by line:
    // one line carries it, and everything else parses without it.
    const helperLines = text
      .split("\n")
      .filter((line) => line.includes("apiKeyHelper"));
    expect(helperLines).toEqual([
      `  "apiKeyHelper": "printf '%s' \\"$COWBOY_API_KEY\\"",`,
    ]);
    const withoutHelper = text
      .split("\n")
      .filter((line) => !line.includes("apiKeyHelper"))
      .join("\n");
    expect(JSON.parse(withoutHelper)).toEqual({
      theme: "dark",
      skipDangerousModePermissionPrompt: true,
    });
  });

  it("keys the trust entry by the given path when it has no canonical one", () => {
    const missing = inTmpRoot("never-created");
    expect(existsSync(missing)).toBe(false);

    const { configDir: dir } = writeClaudeStaging({
      subagentId: SUBAGENT_ID,
      cwd: missing,
    });

    const state = JSON.parse(
      readFileSync(join(dir, ".claude.json"), "utf-8"),
    ) as { projects: Record<string, unknown> };
    expect(Object.keys(state.projects)).toEqual([missing]);
  });

  it("seeds no credential-derived state: approval stays the user's to give", () => {
    const { configDir: dir } = writeClaudeStaging({
      subagentId: SUBAGENT_ID,
      cwd: tmpRoot,
    });

    const stateText = readFileSync(join(dir, ".claude.json"), "utf-8");
    expect(stateText).not.toContain("customApiKeyResponses");
    expect(stateText).not.toContain("approved");
  });

  it("stages byte-identical settings: every byte is accounted for, so no key material can hide in it", () => {
    const { configDir: dir } = writeClaudeStaging({
      subagentId: SUBAGENT_ID,
      cwd: tmpRoot,
    });

    expect(readFileSync(join(dir, "settings.json"), "utf-8")).toBe(
      `{\n  "apiKeyHelper": "printf '%s' \\"$COWBOY_API_KEY\\"",\n  "theme": "dark",\n  "skipDangerousModePermissionPrompt": true\n}\n`,
    );
  });

  it("replaces the staging a previous call wrote", () => {
    const first = inTmpRoot("first");
    writeClaudeStaging({ subagentId: SUBAGENT_ID, cwd: first });
    const { configDir: dir } = writeClaudeStaging({
      subagentId: SUBAGENT_ID,
      cwd: tmpRoot,
    });

    const state = JSON.parse(
      readFileSync(join(dir, ".claude.json"), "utf-8"),
    ) as { projects: Record<string, unknown> };
    expect(Object.keys(state.projects)).toEqual([realpathSync.native(tmpRoot)]);
  });

  it("leaves a previous launch's transcript in the store, untouched", () => {
    const first = writeClaudeStaging({ subagentId: SUBAGENT_ID, cwd: tmpRoot });
    const transcript = writeTranscript(first.configDir);

    const second = writeClaudeStaging({
      subagentId: SUBAGENT_ID,
      cwd: tmpRoot,
    });

    // The new run's file is named by the id it pins, so no earlier transcript
    // has to be cleared to keep the store unambiguous.
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(existsSync(transcript)).toBe(true);
  });
});

describe("spawnCredentialStore", () => {
  it("forwards the default store as empty on macOS", () => {
    expect(spawnCredentialStore("darwin")).toBe("");
  });

  it("forwards the parent's config dir verbatim on macOS", () => {
    process.env.CLAUDE_CONFIG_DIR = "/Users/me/.claude-work";

    expect(spawnCredentialStore("darwin")).toBe("/Users/me/.claude-work");
  });

  it("keeps an explicitly empty secure store on macOS", () => {
    process.env.CLAUDE_CONFIG_DIR = "/Users/me/.claude-work";
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "";

    expect(spawnCredentialStore("darwin")).toBe("");
  });

  it("prefers an inherited secure store over the config dir", () => {
    process.env.CLAUDE_CONFIG_DIR = "/Users/me/.claude-work";
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR =
      "/Users/me/.claude-credentials";

    expect(spawnCredentialStore("darwin")).toBe(
      "/Users/me/.claude-credentials",
    );
  });

  it("resolves the default store to ~/.claude on Linux", () => {
    expect(spawnCredentialStore("linux")).toBe(join(homedir(), ".claude"));
  });

  it("expands a tilde config dir on Linux", () => {
    process.env.CLAUDE_CONFIG_DIR = "~/.claude-work";

    expect(spawnCredentialStore("linux")).toBe(join(homedir(), ".claude-work"));
  });

  it("keeps an absolute config dir on Linux", () => {
    process.env.CLAUDE_CONFIG_DIR = "/home/me/.claude-work";

    expect(spawnCredentialStore("linux")).toBe("/home/me/.claude-work");
  });
});

describe("removeClaudeStaging", () => {
  it("removes the staging tree it wrote", () => {
    const { configDir: dir } = writeClaudeStaging({
      subagentId: SUBAGENT_ID,
      cwd: tmpRoot,
    });
    expect(existsSync(dir)).toBe(true);

    removeClaudeStaging(SUBAGENT_ID);

    expect(existsSync(dir)).toBe(false);
  });

  it("removes the staging tree and leaves the transcripts where they are", () => {
    const { configDir } = writeClaudeStaging({
      subagentId: SUBAGENT_ID,
      cwd: tmpRoot,
    });
    const transcript = writeTranscript(configDir);

    removeClaudeStaging(SUBAGENT_ID);

    expect(existsSync(configDir)).toBe(false);
    expect(existsSync(claudeProjectsStore())).toBe(true);
    expect(readFileSync(transcript, "utf-8")).toContain("9d0f1e42");
  });

  it("does nothing when the staging tree is already gone", () => {
    expect(existsSync(claudeConfigDir(SUBAGENT_ID))).toBe(false);

    expect(() => removeClaudeStaging(SUBAGENT_ID)).not.toThrow();
  });
});

describe("prepare", () => {
  /** The parent store the launcher forwards; absolute, so both platforms agree. */
  const PARENT_CREDENTIAL_STORE = "/tmp/cowboy-parent-credentials";

  /** A task file under a path with a space, so the launcher's quoting is asserted, not assumed. */
  let taskFile: string;

  beforeEach(() => {
    mkdirSync(join(tmpRoot, "my tasks"), { recursive: true });
    taskFile = inTmpRoot(join("my tasks", "prompt.md"));
    writeFileSync(taskFile, "do the thing\n\nand the second thing\n");
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = PARENT_CREDENTIAL_STORE;
  });

  /** Prepare one claude launch into a pane. */
  function prepareClaude(paneId = "w1:p9"): Promise<void> {
    return harnessFor("claude").prepare({
      pi: PI,
      pane: PANE,
      paneId,
      cwd: tmpRoot,
      launch: launchInputs({ taskFile }),
      config: undefined,
    });
  }

  it("sources the launch's staged env on the command that runs claude", async () => {
    const envFile = inTmpRoot("env.sh");
    writeFileSync(envFile, "export REVIEW_MODE='fast'\n");
    await harnessFor("claude").prepare({
      pi: PI,
      pane: PANE,
      paneId: "w1:p9",
      cwd: tmpRoot,
      launch: launchInputs({ taskFile, envFile }),
      config: undefined,
    });

    const body = runInPaneMock.mock.calls[0]![2] as string;
    expect(body).toContain(
      `( . '${envFile}' && { command claude --session-id '${stagedSessionId()}' "$@" -- "$(cat '${taskFile}')"; } )`,
    );
    // The value stays in the file: the typed command names only the path.
    expect(body).not.toContain("fast");
  });

  it("stages the config directory and plants the launcher that points claude at it", async () => {
    await prepareClaude();

    const configDir = claudeConfigDir(SUBAGENT_ID);
    expect(runInPaneMock).toHaveBeenNthCalledWith(
      1,
      PI,
      "w1:p9",
      `claude() { : "CLAUDE_LAUNCHER_3f7a1d"; if [ -n "\${ANTHROPIC_API_KEY:-}" ]; then export COWBOY_API_KEY="$ANTHROPIC_API_KEY"; unset ANTHROPIC_API_KEY; else grep -v '"apiKeyHelper"' '${configDir}/settings.json' > '${configDir}/settings.json.tmp' && mv '${configDir}/settings.json.tmp' '${configDir}/settings.json'; fi; export CLAUDE_SECURESTORAGE_CONFIG_DIR='${PARENT_CREDENTIAL_STORE}'; export CLAUDE_CONFIG_DIR='${configDir}'; export CLAUDE_CODE_DISABLE_CLAUDE_MDS=1; command claude --session-id '${stagedSessionId()}' "$@" -- "$(cat '${taskFile}')"; }`,
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

    // The tree the launcher names is really there, and its store is the
    // user's own — not a directory inside the disposable staging tree.
    expect(existsSync(join(configDir, "settings.json"))).toBe(true);
    expect(existsSync(join(configDir, ".claude.json"))).toBe(true);
    expect(lstatSync(claudeProjectsDir(configDir)).isSymbolicLink()).toBe(true);
  });

  it("ends option parsing before the task so variadic tool flags cannot swallow it", async () => {
    await harnessFor("claude").prepare({
      pi: PI,
      pane: PANE,
      paneId: "w1:p9",
      cwd: tmpRoot,
      launch: launchInputs({
        taskFile,
        toolSelection: { kind: "include", names: ["Bash", "Read"] },
      }),
      config: undefined,
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
      `test -r '${configDir}/settings.json' && test -r '${taskFile}' && (unset -f claude; command -v claude >/dev/null) && echo CLAUDE_""STAGED`,
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

  it("carries the effort on --effort only when one was resolved", () => {
    expect(
      harnessFor("claude").buildArgs(launchInputs({ thinking: "xhigh" })),
    ).toEqual([...BASE, "--effort", "xhigh"]);

    expect(harnessFor("claude").buildArgs(launchInputs())).not.toContain(
      "--effort",
    );
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
    const list = await harnessFor("claude").listModels({
      pi: PI,
      modelCatalog: { getAvailable: () => [] },
    });

    // The CLI enumerates no per-model effort, so every alias carries the
    // levels `--effort` accepts — the whole of them, as a closed list.
    const thinkingLevels = {
      kind: "closed",
      levels: ["low", "medium", "high", "xhigh", "max"],
    } as const;
    expect(list).toEqual({
      kind: "listed",
      entries: [
        { key: "anthropic/haiku", label: "haiku", thinkingLevels },
        { key: "anthropic/sonnet", label: "sonnet", thinkingLevels },
        { key: "anthropic/opus", label: "opus", thinkingLevels },
        { key: "anthropic/fable", label: "fable", thinkingLevels },
        { key: "anthropic/mythos", label: "mythos", thinkingLevels },
      ],
    });
  });

  it("warms nothing: the list is a constant, not a fetch", () => {
    expect(() => harnessFor("claude").prefetchModels(PI)).not.toThrow();
  });
});

describe("teardown", () => {
  it("removes the staging tree the launch read", async () => {
    const { configDir } = writeClaudeStaging({
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
