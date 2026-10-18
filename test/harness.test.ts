/**
 * harness.test.ts — the harness contract: its id vocabulary, the model list
 * every harness answers, and the pane preparation each harness performs (the
 * shell tricks that point the pane's `pi` at pig or pi-bolt, and the launcher
 * that points opencode at its staged config directory).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  type CodexLaunchRequest,
  type HarnessId,
  type HarnessPrepareRequest,
  type LaunchRequestFor,
  type OpencodeLaunchRequest,
  type PiFamilyLaunchRequest,
  type SubagentLaunchInputs,
} from "../src/agents/harness.js";
import {
  harnessFor,
  listHarnessModelOptions,
  mergeHarnessModelOptions,
  resolveHarness,
  runnableHarnessIds,
} from "../src/agents/harness/registry.js";
import {
  opencodeConfigDir,
  removeOpencodeStaging,
  writeOpencodeStaging,
} from "../src/agents/harness/opencode/staging.js";
import { probed, unprobed } from "../src/availability.js";
import type { PaneControl } from "../src/agents/agent-host.js";

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

/** The pane surface a harness prepares through: the herdr calls this file mocks. */
const PANE: PaneControl = {
  kind: "herdr",
  run: (paneId, command) => runInPaneMock(PI, paneId, command),
  waitForOutput: (paneId, output, timeoutMs) =>
    waitForPaneOutputMock(PI, paneId, output, timeoutMs),
};

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

/** A staged system prompt file, in this test's redirected TMPDIR. */
function stagedPrompt(text = "You review one diff.\n"): string {
  const file = inTmpRoot("system.md");
  writeFileSync(file, text);
  return file;
}

/** The launch inputs every family's request shares. */
function sharedInputs(): SubagentLaunchInputs {
  return {
    subagentId: "esp02hpw",
    systemPromptFile: "/spawn/esp02hpw/system.md",
    taskFile: "/spawn/esp02hpw/task.md",
    resultFile: "/spawn/esp02hpw/result.md",
    modelKey: null,
    toolSelection: { kind: "default" },
  };
}

/** The pi family's launch request, with every optional arm absent. */
const PI_FAMILY_LAUNCH: PiFamilyLaunchRequest = {
  ...sharedInputs(),
  family: "pi",
  thinkingLevel: null,
  forkSessionFile: null,
  skills: { kind: "default" },
  extensions: { kind: "default" },
  projectTrusted: true,
};

/**
 * The launch each harness is handed: its own family's request. Keyed like the
 * registry, so a prepare is handed the member its family reads.
 */
const LAUNCHES: { [K in HarnessId]: LaunchRequestFor<K> } = {
  pi: PI_FAMILY_LAUNCH,
  pig: PI_FAMILY_LAUNCH,
  "pi-bolt": PI_FAMILY_LAUNCH,
  opencode: { ...sharedInputs(), family: "opencode", variant: null },
  codex: { ...sharedInputs(), family: "codex", projectTrusted: true },
  claude: { ...sharedInputs(), family: "claude" },
};

/**
 * A prepare for one harness: the pi-compatible launcher reads the pane, not the
 * launch, so its inputs only have to be present, not meaningful.
 */
function prepareRequest<K extends HarnessId>(
  id: K,
  paneId: string,
): HarnessPrepareRequest<LaunchRequestFor<K>> {
  return { pi: PI, pane: PANE, paneId, cwd: "/repo", launch: LAUNCHES[id] };
}

beforeEach(() => {
  realTmpdir = process.env.TMPDIR;
  tmpRoot = mkdtempSync(join(tmpdir(), "cowboy-harness-"));
  madeRoots.push(tmpRoot);
  process.env.TMPDIR = tmpRoot;
});

afterEach(() => {
  vi.useRealTimers();
  // Remove through the module, with the redirected TMPDIR still in place.
  removeOpencodeStaging("esp02hpw");
  if (realTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmpdir;
  for (const root of madeRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("harness ids", () => {
  it("offers pi, pig, pi-bolt, opencode, codex, and claude, defaulting to pi", () => {
    expect([...HARNESS_IDS]).toEqual([
      "pi",
      "pig",
      "pi-bolt",
      "opencode",
      "codex",
      "claude",
    ]);
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

describe("availability", () => {
  /** Whether the harness answered as launchable. */
  function launchable(id: HarnessId): boolean {
    return harnessFor(id).availability().status === "available";
  }

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
  function executable(dir: string, name: string, stdout = ""): void {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\n`, {
      mode: 0o755,
    });
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

    expect(launchable("pi")).toBe(true);
  });

  it("finds each pi-compatible harness by its own binary name", () => {
    const dir = freshPath();
    expect(launchable("pig")).toBe(false);
    expect(launchable("pi-bolt")).toBe(false);

    executable(dir, "pig");
    expect(launchable("pig")).toBe(true);
    expect(launchable("pi-bolt")).toBe(false);

    executable(dir, "pi-bolt");
    expect(launchable("pi-bolt")).toBe(true);
  });

  it("finds opencode by its binary name and the version it speaks", () => {
    const dir = freshPath();
    expect(launchable("opencode")).toBe(false);

    executable(dir, "opencode", "opencode v2.0.28");
    expect(launchable("opencode")).toBe(true);
  });

  it("refuses an opencode of another major, carrying the version it found", () => {
    const dir = freshPath();
    executable(dir, "opencode", "opencode v1.19.0");

    expect(harnessFor("opencode").availability()).toEqual({
      status: "unavailable",
      notice:
        "You seem to have opencode version 1.19.0 installed, pi-cowboy only supports v2.x.x.",
    });
  });

  it("refuses an opencode whose version it cannot parse, and says so", () => {
    const dir = freshPath();
    executable(dir, "opencode", "1.0.114");

    expect(harnessFor("opencode").availability()).toEqual({
      status: "unavailable",
      notice:
        "Could not parse the version the opencode on your PATH reports, pi-cowboy only supports v2.x.x.",
    });
  });

  it("finds codex by its binary name", () => {
    const dir = freshPath();
    expect(launchable("codex")).toBe(false);

    executable(dir, "codex");
    expect(launchable("codex")).toBe(true);
  });

  it("follows a symlink to the binary, as a shell would", () => {
    const dir = freshPath();
    const real = join(dir, "real-pig");
    writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(real, join(dir, "pig"));

    expect(launchable("pig")).toBe(true);
  });

  it("is not fooled by a file that cannot be executed", () => {
    const dir = freshPath();
    writeFileSync(join(dir, "pig"), "#!/bin/sh\n", { mode: 0o644 });

    expect(launchable("pig")).toBe(false);
  });

  it("is not fooled by a directory named after the binary", () => {
    const dir = freshPath();
    mkdirSync(join(dir, "pig"));

    expect(launchable("pig")).toBe(false);
  });

  it("is not fooled by a broken symlink", () => {
    const dir = freshPath();
    symlinkSync(join(dir, "gone"), join(dir, "pig"));

    expect(launchable("pig")).toBe(false);
  });

  it("does not look in a directory that is not on PATH", () => {
    const dir = freshPath();
    const elsewhere = mkdtempSync(join(tmpdir(), "harness-elsewhere-"));
    tmpDirs.push(elsewhere);
    executable(elsewhere, "pig");

    expect(dir).not.toBe(elsewhere);
    expect(launchable("pig")).toBe(false);
  });
});

describe("prepare", () => {
  beforeEach(() => {
    runInPaneMock.mockReset().mockResolvedValue(undefined);
    waitForPaneOutputMock.mockReset().mockResolvedValue(undefined);
  });

  it("does nothing for pi: real pi is already the pane's `pi`", async () => {
    await harnessFor("pi").prepare(prepareRequest("pi", "w1:p1"));
    expect(runInPaneMock).not.toHaveBeenCalled();
    expect(waitForPaneOutputMock).not.toHaveBeenCalled();
  });

  it("plants the pi launcher in the pane for pig and confirms its body landed", async () => {
    await harnessFor("pig").prepare(prepareRequest("pig", "w1:p9"));
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
    await harnessFor("pi-bolt").prepare(prepareRequest("pi-bolt", "w1:p9"));
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
    await harnessFor("pig").prepare(prepareRequest("pig", "w1:p1"));
    const pigVerify = runInPaneMock.mock.calls[1][2];
    runInPaneMock.mockClear();

    await harnessFor("pi-bolt").prepare(prepareRequest("pi-bolt", "w1:p2"));
    const boltVerify = runInPaneMock.mock.calls[1][2];

    expect(pigVerify).toContain("PIG_LAUNCHER_8f9a2b");
    expect(boltVerify).toContain("PI_BOLT_LAUNCHER_5e1c7a");
    expect(boltVerify).not.toContain("PIG_LAUNCHER_8f9a2b");
  });

  it("retries a lost `pane run` and fails loud when the launcher never lands", async () => {
    vi.useFakeTimers();
    waitForPaneOutputMock.mockRejectedValue(new Error("timed out waiting"));

    const promise = harnessFor("pi-bolt").prepare(
      prepareRequest("pi-bolt", "w1:p9"),
    );
    const assertion = expect(promise).rejects.toThrow(
      /the pi launcher never landed/,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    // One define + one verify per attempt.
    expect(runInPaneMock.mock.calls.length).toBe(10);
  });
});

/**
 * The opencode launch: staging and the launcher read real files and write a real
 * config directory, so these cases redirect `TMPDIR` and stage for the harness
 * rather than stubbing the staging module out.
 */
describe("prepare: opencode", () => {
  let taskFile: string;

  beforeEach(() => {
    runInPaneMock.mockReset().mockResolvedValue(undefined);
    waitForPaneOutputMock.mockReset().mockResolvedValue(undefined);
    taskFile = inTmpRoot("prompt.md");
    writeFileSync(taskFile, "do the thing\n\nand the second thing\n");
  });

  /** The launch this file stages for opencode. */
  function opencodeLaunch(): OpencodeLaunchRequest {
    return {
      ...sharedInputs(),
      family: "opencode",
      variant: "high",
      systemPromptFile: stagedPrompt(),
      taskFile,
    };
  }

  /** Prepare one opencode launch into a pane. */
  function prepareOpencode(paneId = "w1:p9"): Promise<void> {
    return harnessFor("opencode").prepare({
      pi: PI,
      pane: PANE,
      paneId,
      cwd: "/repo",
      launch: opencodeLaunch(),
    });
  }

  it("stages the definition and plants the launcher that points opencode at it", async () => {
    await prepareOpencode();

    const configDir = opencodeConfigDir("esp02hpw");
    expect(runInPaneMock).toHaveBeenNthCalledWith(
      1,
      PI,
      "w1:p9",
      `opencode() { : "OPENCODE_LAUNCHER_7d3e91"; export OPENCODE_CONFIG_DIR='${configDir}'; export OPENCODE_DISABLE_PROJECT_CONFIG=1; command opencode "$@" < '${taskFile}'; }`,
    );
    expect(runInPaneMock).toHaveBeenNthCalledWith(
      2,
      PI,
      "w1:p9",
      'typeset -f opencode 2>/dev/null | grep -q "OPENCODE_LAUNCHER_7d3e91" && echo OPENCODE_""VERIFIED',
    );
    expect(waitForPaneOutputMock).toHaveBeenCalledWith(
      PI,
      "w1:p9",
      "OPENCODE_VERIFIED",
      expect.any(Number),
    );

    // The tree the launcher names is really there, and carries the prompt the
    // launch handed over.
    const definition = readFileSync(
      join(configDir, "agent", "esp02hpw.md"),
      "utf-8",
    );
    expect(definition).toContain("You review one diff.");
  });

  it("reads the definition back through a private server and requires the staged agent", async () => {
    await prepareOpencode();

    expect(runInPaneMock).toHaveBeenNthCalledWith(
      3,
      PI,
      "w1:p9",
      "opencode run --standalone --agent 'esp02hpw' --model 'pi-cowboy/opencode-definition-proof' 'definition probe' 2>&1 | grep -q 'Model unavailable' && echo OPENCODE_\"\"DEFINITION_VERIFIED",
    );
    // The marker is waited for unbroken: the pane echoes the command line it is
    // typed, so the command carries it split.
    expect(waitForPaneOutputMock).toHaveBeenCalledWith(
      PI,
      "w1:p9",
      "OPENCODE_DEFINITION_VERIFIED",
      expect.any(Number),
    );
  });

  it("fails loud when the pane never confirms the staged definition", async () => {
    waitForPaneOutputMock.mockImplementation(async (_pi, _pane, match) => {
      // The launcher's own verification still passes; only the proof fails.
      if (match === "OPENCODE_DEFINITION_VERIFIED") {
        throw new Error("timed out waiting for pane output");
      }
    });

    await expect(prepareOpencode()).rejects.toThrow(
      /never reported the staged definition.*did not start/s,
    );
  });

  it("stages and installs again when prepare is called twice", async () => {
    await prepareOpencode();
    await expect(prepareOpencode()).resolves.toBeUndefined();

    expect(
      existsSync(join(opencodeConfigDir("esp02hpw"), "agent", "esp02hpw.md")),
    ).toBe(true);
    // Two installs, each verified: no state accumulates behind the second.
    expect(runInPaneMock).toHaveBeenCalledTimes(6);
  });

  it("fails before touching the pane when the system prompt cannot be read", async () => {
    const launch = opencodeLaunch();

    await expect(
      harnessFor("opencode").prepare({
        pi: PI,
        pane: PANE,
        paneId: "w1:p9",
        cwd: "/repo",
        launch: { ...launch, systemPromptFile: join(tmpdir(), "gone.md") },
      }),
    ).rejects.toThrow(/ENOENT/);
    expect(runInPaneMock).not.toHaveBeenCalled();
  });
});

/**
 * The codex launch: the task cannot ride the argv, so the launcher appends it
 * as the TUI's positional prompt. These cases hand the harness a real task
 * file and read the launcher back, rather than stubbing anything out.
 */
describe("prepare: codex", () => {
  let taskFile: string;

  beforeEach(() => {
    runInPaneMock.mockReset().mockResolvedValue(undefined);
    waitForPaneOutputMock.mockReset().mockResolvedValue(undefined);
    taskFile = inTmpRoot("prompt.md");
    writeFileSync(taskFile, "do the thing\n\nand the second thing\n");
  });

  /** The launch this file prepares codex for. */
  function codexLaunch(): CodexLaunchRequest {
    return {
      ...sharedInputs(),
      family: "codex",
      projectTrusted: true,
      taskFile,
    };
  }

  /** Prepare one codex launch into a pane. */
  function prepareCodex(paneId = "w1:p9"): Promise<void> {
    return harnessFor("codex").prepare({
      pi: PI,
      pane: PANE,
      paneId,
      cwd: "/repo",
      launch: codexLaunch(),
    });
  }

  it("plants the launcher that appends the task as the positional prompt", async () => {
    await prepareCodex();

    expect(runInPaneMock).toHaveBeenNthCalledWith(
      1,
      PI,
      "w1:p9",
      `codex() { : "CODEX_LAUNCHER_3f8a1c"; command codex "$@" "$(cat '${taskFile}')"; }`,
    );
    expect(runInPaneMock).toHaveBeenNthCalledWith(
      2,
      PI,
      "w1:p9",
      'typeset -f codex 2>/dev/null | grep -q "CODEX_LAUNCHER_3f8a1c" && echo CODEX_""VERIFIED',
    );
    expect(waitForPaneOutputMock).toHaveBeenCalledWith(
      PI,
      "w1:p9",
      "CODEX_VERIFIED",
      expect.any(Number),
    );
  });

  it("proves nothing past the launcher: the function is the whole of the pane state", async () => {
    await prepareCodex();

    // One define plus one verify; codex stages nothing to read back.
    expect(runInPaneMock).toHaveBeenCalledTimes(2);
  });
});

describe("buildArgs", () => {
  /** A pi-family launch request with every optional arm absent. */
  function request(
    overrides: Partial<PiFamilyLaunchRequest> = {},
  ): PiFamilyLaunchRequest {
    return {
      ...sharedInputs(),
      family: "pi",
      thinkingLevel: null,
      forkSessionFile: null,
      skills: { kind: "default" },
      extensions: { kind: "default" },
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

  it("starts opencode's minimal interactive UI with the staged agent", () => {
    expect(
      harnessFor("opencode").buildArgs({
        ...sharedInputs(),
        family: "opencode",
        variant: null,
      }),
    ).toEqual(["mini", "--standalone", "--agent", "esp02hpw"]);
  });

  it("carries opencode's model only when one was resolved", () => {
    expect(
      harnessFor("opencode").buildArgs({
        ...sharedInputs(),
        family: "opencode",
        variant: null,
        modelKey: "anthropic/claude-opus-4",
      }),
    ).toEqual([
      "mini",
      "--standalone",
      "--agent",
      "esp02hpw",
      "--model",
      "anthropic/claude-opus-4",
    ]);

    expect(
      harnessFor("opencode").buildArgs({
        ...sharedInputs(),
        family: "opencode",
        variant: null,
      }),
    ).not.toContain("--model");
  });

  it("joins opencode's variant to the model reference", () => {
    const args = harnessFor("opencode").buildArgs({
      ...sharedInputs(),
      family: "opencode",
      variant: "high",
      modelKey: "anthropic/claude-opus-4",
    });

    expect(args).not.toContain("--variant");
    expect(args[args.indexOf("--model") + 1]).toBe(
      "anthropic/claude-opus-4#high",
    );
  });

  it("refuses opencode's variant when the launch resolved no model", () => {
    // A variant names a member of one model's catalogue, so with no model it
    // names nothing: opencode would run the session's model and drop the request.
    expect(() =>
      harnessFor("opencode").buildArgs({
        ...sharedInputs(),
        family: "opencode",
        variant: "high",
      }),
    ).toThrow(/variant/);
  });

  /** A codex launch request with every optional arm absent. */
  function codexRequest(
    overrides: Partial<CodexLaunchRequest> = {},
  ): CodexLaunchRequest {
    return {
      ...sharedInputs(),
      family: "codex",
      projectTrusted: true,
      ...overrides,
    };
  }

  it("starts codex's interactive CLI with the staged instructions and no project docs", () => {
    expect(harnessFor("codex").buildArgs(codexRequest())).toEqual([
      "-c",
      'model_instructions_file="/spawn/esp02hpw/system.md"',
      "-c",
      "project_doc_max_bytes=0",
      "-s",
      "workspace-write",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  it("quotes the instructions path as a TOML string, so a staging path with spaces survives", () => {
    const args = harnessFor("codex").buildArgs(
      codexRequest({ systemPromptFile: "/tmp/dir with space/system.md" }),
    );

    expect(args).toEqual(
      expect.arrayContaining([
        "-c",
        'model_instructions_file="/tmp/dir with space/system.md"',
      ]),
    );
  });

  it.each([false, true])(
    "bypasses approvals whatever the trust (trusted=%s): the pane cannot answer a prompt",
    (projectTrusted) => {
      const args = harnessFor("codex").buildArgs(
        codexRequest({ projectTrusted }),
      );
      expect(args).toEqual(
        expect.arrayContaining(["--dangerously-bypass-approvals-and-sandbox"]),
      );
      expect(args).not.toContain("-a");
    },
  );

  it.each([true, false])(
    "keeps the workspace writable when trusted=%s: the report file lives outside it",
    (projectTrusted) => {
      expect(
        harnessFor("codex").buildArgs(codexRequest({ projectTrusted })),
      ).toEqual(expect.arrayContaining(["-s", "workspace-write"]));
    },
  );

  it("carries codex's model as its bare slug only when one was resolved", () => {
    expect(
      harnessFor("codex").buildArgs(
        codexRequest({ modelKey: "openai/gpt-6-sol" }),
      ),
    ).toEqual(expect.arrayContaining(["-m", "gpt-6-sol"]));

    expect(harnessFor("codex").buildArgs(codexRequest())).not.toContain("-m");
  });

  it("carries a key outside codex's own catalogue as written rather than refusing it", () => {
    expect(
      harnessFor("codex").buildArgs(codexRequest({ modelKey: "other/model" })),
    ).toEqual(expect.arrayContaining(["-m", "other/model"]));
  });

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

describe("listModels", () => {
  /** A pi registry: the catalog the family's list reads, in its own order. */
  const CATALOG = {
    getAvailable: () => [
      { provider: "anthropic", id: "claude-3" },
      { provider: "openai", id: "gpt-4o" },
    ],
  };

  it.each(["pi", "pig", "pi-bolt"] as const)(
    "%s lists the pi catalog's models in the catalog's order",
    async (id) => {
      const entries = await harnessFor(id).listModels({
        pi: PI,
        modelCatalog: CATALOG,
      });

      expect(entries).toEqual([
        { key: "anthropic/claude-3" },
        { key: "openai/gpt-4o" },
      ]);
    },
  );

  /** The opencode harness's own list, over a `pi.exec` the test supplies. */
  function opencodeListModels(
    exec: unknown,
  ): Promise<readonly { key: string; label?: string }[]> {
    return harnessFor("opencode").listModels({
      pi: { exec } as unknown as ExtensionAPI,
      modelCatalog: CATALOG,
    });
  }

  /** The codex harness's own list, over a `pi.exec` the test supplies. */
  function codexListModels(
    exec: unknown,
  ): Promise<readonly { key: string; label?: string }[]> {
    return harnessFor("codex").listModels({
      pi: { exec } as unknown as ExtensionAPI,
      modelCatalog: CATALOG,
    });
  }

  it("answers an empty catalog with no entries rather than an error", async () => {
    await expect(
      harnessFor("pi").listModels({
        pi: PI,
        modelCatalog: { getAvailable: () => [] },
      }),
    ).resolves.toEqual([]);
  });

  it("parses opencode's own output into entries", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: "# Models\nanthropic/claude-opus-4\n\nopenai/gpt-4o\n",
      stderr: "",
    }));

    const entries = await opencodeListModels(exec);

    expect(exec).toHaveBeenCalledWith("opencode", ["models", "--standalone"], {
      timeout: expect.any(Number),
    });
    expect(entries).toEqual([
      { key: "anthropic/claude-opus-4", label: "claude-opus-4" },
      { key: "openai/gpt-4o", label: "gpt-4o" },
    ]);
  });

  it("shares one CLI run between reads from the same caller", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: "anthropic/claude-opus-4\n",
      stderr: "",
    }));
    const pi = { exec } as unknown as ExtensionAPI;
    const request = { pi, modelCatalog: CATALOG };

    const [first, second] = await Promise.all([
      harnessFor("opencode").listModels(request),
      harnessFor("opencode").listModels(request),
    ]);

    // One run, and every joiner holds the one shared promise.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first).toEqual([
      { key: "anthropic/claude-opus-4", label: "claude-opus-4" },
    ]);
  });

  it("resolves an empty list and warns when the CLI fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "boom" }));

    await expect(opencodeListModels(exec)).resolves.toEqual([]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("opencode");
    warn.mockRestore();
  });

  it("resolves an empty list and warns on output whose shape is unrecognized", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: "PROVIDER        MODEL\nanthropic       claude-3\n",
      stderr: "",
    }));

    await expect(opencodeListModels(exec)).resolves.toEqual([]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("unrecognized");
    warn.mockRestore();
  });

  it("resolves an empty list and warns when the child could not be started at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exec = vi.fn(async () => {
      throw new Error("ENOENT: opencode not found");
    });

    await expect(opencodeListModels(exec)).resolves.toEqual([]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("ENOENT");
    warn.mockRestore();
  });

  /** One `codex debug models --bundled` answer in the CLI's own shape. */
  function bundledCatalog(models: unknown): string {
    return JSON.stringify({ models });
  }

  it("asks codex for its bundled catalog and parses listed slugs into openai keys", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: bundledCatalog([
        { slug: "gpt-6-sol", visibility: "list", display_name: "GPT-6-Sol" },
        { slug: "gpt-5.6-terra", visibility: "list", display_name: "" },
        { slug: "daybreak-secret", visibility: "hide", display_name: "X" },
      ]),
      stderr: "",
    }));

    const entries = await codexListModels(exec);

    expect(exec).toHaveBeenCalledWith(
      "codex",
      ["debug", "models", "--bundled"],
      { timeout: expect.any(Number) },
    );
    expect(entries).toEqual([
      { key: "openai/gpt-6-sol", label: "GPT-6-Sol" },
      { key: "openai/gpt-5.6-terra", label: "gpt-5.6-terra" },
    ]);
  });

  it("skips unlisted entries before validating, so a misshapen hidden entry costs nothing", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: bundledCatalog([
        { slug: "gpt-6-sol", visibility: "list", display_name: "GPT-6-Sol" },
        { slug: "has spaces", visibility: "hide", display_name: "X" },
        { visibility: "hide" },
      ]),
      stderr: "",
    }));

    await expect(codexListModels(exec)).resolves.toEqual([
      { key: "openai/gpt-6-sol", label: "GPT-6-Sol" },
    ]);
  });

  it("shares one codex CLI run between reads from the same caller", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: bundledCatalog([
        { slug: "gpt-6-sol", visibility: "list", display_name: "GPT-6-Sol" },
      ]),
      stderr: "",
    }));
    const pi = { exec } as unknown as ExtensionAPI;
    const request = { pi, modelCatalog: CATALOG };

    const [first, second] = await Promise.all([
      harnessFor("codex").listModels(request),
      harnessFor("codex").listModels(request),
    ]);

    // One run, and every joiner holds the one shared promise.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first).toEqual([{ key: "openai/gpt-6-sol", label: "GPT-6-Sol" }]);
  });

  it("resolves an empty codex list and warns when the CLI fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "boom" }));

    await expect(codexListModels(exec)).resolves.toEqual([]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("codex");
    warn.mockRestore();
  });

  it("resolves an empty codex list and warns on output whose shape is unrecognized", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: "gpt-6-sol\nopenai/gpt-5.6-terra\n",
      stderr: "",
    }));

    await expect(codexListModels(exec)).resolves.toEqual([]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("unrecognized");
    warn.mockRestore();
  });
});

describe("listHarnessModelOptions", () => {
  /** A pi registry: the catalog the pi family's list reads. */
  const CATALOG = {
    getAvailable: () => [
      { provider: "anthropic", id: "claude-3" },
      { provider: "openai", id: "gpt-4o" },
    ],
  };

  /** An opencode CLI that answers with one model the catalog does not have. */
  function opencodeExec(): ReturnType<typeof vi.fn> {
    return vi.fn(async () => ({
      code: 0,
      stdout: "anthropic/claude-opus-4\nopenai/gpt-4o\n",
      stderr: "",
    }));
  }

  it("keeps one list per runnable harness, each key under its own harness", async () => {
    const lists = await listHarnessModelOptions(
      {
        pi: { exec: opencodeExec() } as unknown as ExtensionAPI,
        modelCatalog: CATALOG,
      },
      probed(["pi", "opencode"]),
    );

    expect([...lists.keys()]).toEqual(["pi", "pig", "pi-bolt", "opencode"]);
    expect(lists.get("pi")).toEqual(["anthropic/claude-3", "openai/gpt-4o"]);
    expect(lists.get("pig")).toEqual(["anthropic/claude-3", "openai/gpt-4o"]);
    expect(lists.get("opencode")).toEqual([
      "anthropic/claude-opus-4",
      "openai/gpt-4o",
    ]);
  });

  it("lists codex's own keys under codex once the probe has confirmed it", async () => {
    const exec = vi.fn(async (bin: string) => {
      if (bin === "codex") {
        return {
          code: 0,
          stdout: JSON.stringify({
            models: [
              { slug: "gpt-6-sol", visibility: "list", display_name: "Sol" },
              { slug: "daybreak-x", visibility: "hide", display_name: "X" },
            ],
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "anthropic/claude-opus-4\n", stderr: "" };
    });

    const lists = await listHarnessModelOptions(
      {
        pi: { exec } as unknown as ExtensionAPI,
        modelCatalog: CATALOG,
      },
      probed(["pi", "opencode", "codex"]),
    );

    expect([...lists.keys()]).toEqual([
      "pi",
      "pig",
      "pi-bolt",
      "opencode",
      "codex",
    ]);
    expect(lists.get("codex")).toEqual(["openai/gpt-6-sol"]);
  });

  it("merges the per-harness lists once per key, in vocabulary order", async () => {
    const lists = await listHarnessModelOptions(
      {
        pi: { exec: opencodeExec() } as unknown as ExtensionAPI,
        modelCatalog: CATALOG,
      },
      probed(["pi", "opencode"]),
    );

    expect(mergeHarnessModelOptions(lists)).toEqual([
      "anthropic/claude-3",
      "openai/gpt-4o",
      "anthropic/claude-opus-4",
    ]);
  });

  it("asks only the harnesses this machine can run", async () => {
    const exec = opencodeExec();

    const lists = await listHarnessModelOptions(
      {
        pi: { exec } as unknown as ExtensionAPI,
        modelCatalog: CATALOG,
      },
      probed(["pi"]),
    );

    expect([...lists.keys()]).toEqual(["pi", "pig", "pi-bolt"]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("answers from pi before any probe has landed", async () => {
    const exec = opencodeExec();

    const lists = await listHarnessModelOptions(
      {
        pi: { exec } as unknown as ExtensionAPI,
        modelCatalog: CATALOG,
      },
      unprobed(),
    );

    expect(lists.get("pi")).toEqual(["anthropic/claude-3", "openai/gpt-4o"]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("resolves every other list when one harness cannot answer", async () => {
    const throwing = {
      getAvailable: () => {
        throw new Error("catalog unavailable");
      },
    };

    const lists = await listHarnessModelOptions(
      {
        pi: { exec: opencodeExec() } as unknown as ExtensionAPI,
        modelCatalog: throwing,
      },
      probed(["pi", "opencode"]),
    );

    // The failing harness keeps its own empty list; opencode's is untouched.
    expect(lists.get("pi")).toEqual([]);
    expect(lists.get("opencode")).toEqual([
      "anthropic/claude-opus-4",
      "openai/gpt-4o",
    ]);
  });

  it("gives a harness whose CLI fails an empty list of its own", async () => {
    const exec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "boom" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const lists = await listHarnessModelOptions(
      {
        pi: { exec } as unknown as ExtensionAPI,
        modelCatalog: CATALOG,
      },
      probed(["pi", "opencode"]),
    );

    expect(lists.get("opencode")).toEqual([]);
    // The failure costs opencode's list alone; pi's catalog is still offered.
    expect(lists.get("pi")).toEqual(["anthropic/claude-3", "openai/gpt-4o"]);
    warn.mockRestore();
  });
});

describe("runnableHarnessIds", () => {
  it("always offers the pi family: it is the binary already running the pane", () => {
    expect(runnableHarnessIds(unprobed())).toEqual(["pi", "pig", "pi-bolt"]);
  });

  it("adds another harness only once the probe has confirmed it", () => {
    expect(runnableHarnessIds(probed(["pi", "opencode"]))).toEqual([
      "pi",
      "pig",
      "pi-bolt",
      "opencode",
    ]);
    expect(runnableHarnessIds(probed(["pi", "codex"]))).toEqual([
      "pi",
      "pig",
      "pi-bolt",
      "codex",
    ]);
    expect(runnableHarnessIds(probed(["pi"]))).toEqual([
      "pi",
      "pig",
      "pi-bolt",
    ]);
  });

  it("keeps the vocabulary's order, never the probe's", () => {
    expect(runnableHarnessIds(probed(["opencode", "pi"]))).toEqual([
      "pi",
      "pig",
      "pi-bolt",
      "opencode",
    ]);
    expect(runnableHarnessIds(probed(["codex", "pi"]))).toEqual([
      "pi",
      "pig",
      "pi-bolt",
      "codex",
    ]);
  });
});

describe("teardown", () => {
  it.each(["pi", "pig", "pi-bolt", "codex"] as const)(
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

  it("removes the staging tree opencode reads its definition from", async () => {
    const configDir = opencodeConfigDir("esp02hpw");
    writeOpencodeStaging({
      subagentId: "esp02hpw",
      systemPromptFile: stagedPrompt(),
      toolSelection: { kind: "default" },
    });
    expect(existsSync(configDir)).toBe(true);

    await expect(
      harnessFor("opencode").teardown({
        pi: PI,
        paneId: "w1:p1",
        cwd: "/repo",
        subagentId: "esp02hpw",
      }),
    ).resolves.toBeUndefined();

    expect(existsSync(configDir)).toBe(false);
  });

  it("tolerates an opencode teardown with nothing to remove", async () => {
    await expect(
      harnessFor("opencode").teardown({
        pi: PI,
        paneId: null,
        cwd: null,
        subagentId: "never-staged",
      }),
    ).resolves.toBeUndefined();
  });

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
