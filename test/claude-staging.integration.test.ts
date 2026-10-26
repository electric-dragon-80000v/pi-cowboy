/**
 * claude-staging.integration.test.ts — the staging module against the real
 * claude binary.
 *
 * Unit tests pin the files `writeClaudeStaging` emits and the argv
 * `buildArgs` assembles; this proves the real CLI still accepts both. The
 * tree is staged by the committed module, then a real `claude` is pointed at
 * it with the environment a spawn gives it (`CLAUDE_CONFIG_DIR` plus the
 * launcher's memory suppression) and run with the task riding positionally
 * last — the exact shape the pane launcher produces. Stdout here is not a
 * TTY, so the run answers and exits rather than idling as a TUI; a shape the
 * CLI stopped reading fails here rather than in a pane.
 *
 * The binary is resolved with `commandPath("claude")` — the same seam the
 * harness's own `available()` probe uses — so the test runs against whatever
 * claude the machine actually launches, never a path baked in here.
 * Authentication rides the launching environment untouched: the harness
 * neither sets nor reads credentials, and neither does this file beyond
 * requiring an API key to be present. No credential value appears here, in
 * any assertion, or in any failure output (see `redactKeys`).
 *
 * A machine without claude — or without credentials — skips this file, so
 * the suite still runs there. CI sets `PI_COWBOY_REQUIRE_CLAUDE=1`, which
 * turns the missing binary into a failing test instead of a silent skip: a
 * job that dropped the install can never pass by not running these tests. A
 * present binary without credentials still skips even under the requirement,
 * because there is no run that could answer.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnCredentialStore } from "../src/agents/harness/claude/index.js";
import { createHarnessRegistry } from "../src/agents/harness/harness-registry.js";
import {
  claudeConfigDir,
  removeClaudeStaging,
  writeClaudeStaging,
} from "../src/agents/harness/claude/staging.js";
import { commandPath } from "../src/infrastructure/exec-path.js";

const execFileAsync = promisify(execFile);

/** The subagent these tests stage; the shape a spawn id has. */
const SUBAGENT_ID = "c1d2e3f4";
const harnesses = createHarnessRegistry();
const harnessFor = harnesses.require.bind(harnesses);

/** The marker the model is asked to echo; the whole of the assertions. */
const MARKER = "CLAUDE_STAGING_OK";

/** The system prompt the staged run launches under. */
const SYSTEM_PROMPT = "You are a probe. Reply with exactly what is asked.\n";

/**
 * Set to `1` in CI: without a claude binary on PATH the tests fail instead of
 * skipping, so a broken install cannot pass the job by not running them.
 */
const REQUIRE_ENV_VAR = "PI_COWBOY_REQUIRE_CLAUDE";

/** Whether the machine has a claude to run against. */
const claudeMissing = commandPath("claude") === undefined;

/**
 * Whether the launching environment carries credentials a real run can
 * answer with. Named, never read beyond presence: the value must not reach
 * any assertion or log (see `redactKeys`).
 */
const credentialsMissing = (process.env.ANTHROPIC_API_KEY ?? "") === "";

/** Whether a missing binary must fail this file rather than skip it. */
const claudeRequired = process.env[REQUIRE_ENV_VAR] === "1";

/** This file runs only where the binary and the credentials both exist. */
const canRunRealClaude = !claudeMissing && !credentialsMissing;

/** This negative case needs only the binary: a keyless run answers nothing. */
const canRunKeylessClaude = !claudeMissing;

/** One finished CLI run; the exit code is part of the evidence, never thrown away. */
interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The fields `execFile` rejects with, before they are narrowed. */
interface ExecRejection {
  readonly code?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

/** The rejection's fields when it carries any; an empty record otherwise. */
function rejectionFields(err: unknown): ExecRejection {
  return typeof err === "object" && err !== null ? err : {};
}

/**
 * Failure output with any key-like material removed. A stalled consent
 * dialog echoes the key it asks about in masked form, so a raw log tail
 * would carry credential material into the test output.
 */
function redactKeys(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9._-]+/g, "[redacted-key]");
}

/** The binary every run uses, or an error naming how to make its absence fatal. */
function claudeBinary(): string {
  const bin = commandPath("claude");
  if (bin === undefined) {
    throw new Error(
      `no claude binary on PATH; set ${REQUIRE_ENV_VAR}=1 to fail on this instead of skipping`,
    );
  }
  return bin;
}

/** Temporary roots this file made; removed after every test, pass or fail. */
const madeRoots: string[] = [];

/** The real TMPDIR, put back after every test that redirects it. */
let realTmpdir: string | undefined;

/**
 * The real HOME, put back after every test. The staged store links into
 * `$HOME/.claude/projects`, so a test redirects it rather than writing a real
 * run's transcript into the developer's own store.
 */
let realHome: string | undefined;

/** The spawn working directory for the current test (trust is seeded for it). */
let cwd: string;

beforeEach(() => {
  realTmpdir = process.env.TMPDIR;
  const root = fs.mkdtempSync(path.join(tmpdir(), "cowboy-claude-cli-"));
  madeRoots.push(root);
  process.env.TMPDIR = root;
  realHome = process.env.HOME;
  process.env.HOME = path.join(root, "home");
  cwd = path.join(root, "work");
  fs.mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  if (realTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmpdir;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  for (const root of madeRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The environment a spawn gives claude: the staged config dir, and the parent's
 * credential store pinned independently of it.
 */
function launchEnv(configDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: spawnCredentialStore(process.platform),
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  };
}

/**
 * The pane's exact wiring for a key-carrying run: the launcher renames the
 * ambient key out of `ANTHROPIC_API_KEY` — the variable the consent predicate
 * reads — into `COWBOY_API_KEY`, which only the staged helper reads. Reading
 * the value here forwards the launching environment the way the pane inherits
 * it; no value reaches any assertion or log (see `redactKeys`).
 */
function keyCarryingEnv(configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...launchEnv(configDir),
    COWBOY_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

/**
 * A run with no key anywhere: every variable a key could ride in on is
 * removed, so the only auth answer is the staged helper's (or its failure).
 */
function keylessEnv(configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...launchEnv(configDir) };
  // Derive the credential store from the staged config dir, so this run cannot
  // reach the developer's real store through the launcher's pinned value.
  delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  delete env.ANTHROPIC_API_KEY;
  delete env.COWBOY_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/** Write a system prompt file in this test's root and return its path. */
function promptFile(text: string): string {
  const file = path.join(cwd, "system.md");
  fs.writeFileSync(file, text);
  return file;
}

/** Write a task file in this test's root and return its path. */
function taskFile(text: string): string {
  const file = path.join(cwd, "prompt.md");
  fs.writeFileSync(file, text);
  return file;
}

/** Budget for one model answer; the CLI boots before the model is reached. */
const MODEL_RUN_TIMEOUT_MS = 100_000;

/** Run the real CLI against a staged directory, resolving the exit code either way. */
async function runClaude(
  configDir: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CliRun> {
  const bin = claudeBinary();
  try {
    const { stdout, stderr } = await execFileAsync(bin, [...args], {
      env,
      cwd,
      timeout: MODEL_RUN_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const fields = rejectionFields(err);
    return {
      code: typeof fields.code === "number" ? fields.code : 1,
      stdout: typeof fields.stdout === "string" ? fields.stdout : "",
      stderr:
        typeof fields.stderr === "string"
          ? fields.stderr
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }
}

describe.skipIf(!canRunRealClaude)(
  "claude staging against the real CLI",
  () => {
    it("answers through the staged directory with the harness's own argv", async () => {
      const { configDir, sessionId } = writeClaudeStaging({
        subagentId: SUBAGENT_ID,
        cwd,
      });
      // The resolver's own path, so every run below points at the directory the
      // module names rather than a path this file retyped.
      expect(configDir).toBe(claudeConfigDir(SUBAGENT_ID));

      // The argv the harness builds, with the task riding positionally last
      // the way the pane launcher appends it: every flag below is one
      // `buildArgs` emits, so a flag the CLI stopped accepting fails here.
      // The tool filter is load-bearing, not incidental: `--tools` /
      // `--disallowedTools` are variadic, so only a `--`-terminated tail
      // keeps them from swallowing the task as another tool name.
      const args = harnessFor("claude").buildArgs({
        family: "claude",
        subagentId: SUBAGENT_ID,
        systemPromptFile: promptFile(SYSTEM_PROMPT),
        taskFile: taskFile("answer the prompt\n"),
        resultFile: path.join(cwd, "result.md"),
        modelKey: "anthropic/sonnet",
        toolSelection: { kind: "include", names: ["Bash"] },
        thinking: null,
        envFile: null,
      });
      const result = await runClaude(
        configDir,
        [
          // What the launcher pins before `"$@"`: the id staging recorded, so
          // the run writes one transcript whose name the export knows.
          "--session-id",
          sessionId,
          ...args,
          // What the pane launcher appends after `"$@"`: the `--` ends option
          // parsing before the task, and the task rides as one positional word.
          "--",
          `reply with exactly: ${MARKER}`,
        ],
        // The key reaches claude only through the staged helper: the consent
        // predicate cannot fire on a variable that is not set.
        keyCarryingEnv(configDir),
      );

      expect(result.code, redactKeys(result.stderr)).toBe(0);
      expect(redactKeys(result.stdout)).toContain(MARKER);
    });

    it("removes everything it staged", async () => {
      const { configDir } = writeClaudeStaging({
        subagentId: SUBAGENT_ID,
        cwd,
      });
      expect(fs.existsSync(configDir)).toBe(true);

      removeClaudeStaging(SUBAGENT_ID);

      expect(fs.existsSync(configDir)).toBe(false);
    });
  },
);

describe.skipIf(!canRunKeylessClaude)(
  "claude staging without credentials",
  () => {
    it("fails loudly on the helper when no key reaches it, instead of falling through", async () => {
      const { configDir } = writeClaudeStaging({
        subagentId: SUBAGENT_ID,
        cwd,
      });

      // The no-key launch the pane performs after trimming nothing: the
      // staged helper is still configured, so it — not some silent fallback —
      // must be what answers for the missing key. Only the failure text is
      // pinned, never the exit shape.
      const result = await runClaude(
        configDir,
        [
          "--system-prompt-file",
          promptFile(SYSTEM_PROMPT),
          "--dangerously-skip-permissions",
          "--setting-sources",
          "user",
          "--strict-mcp-config",
          "-p",
          MARKER,
        ],
        keylessEnv(configDir),
      );

      expect(redactKeys(`${result.stdout}\n${result.stderr}`)).toContain(
        "apiKeyHelper",
      );
    });
  },
);

describe.runIf(claudeMissing && claudeRequired)(
  "claude staging requires the binary",
  () => {
    it("fails instead of skipping", () => {
      expect.fail(
        `no claude binary on PATH while ${REQUIRE_ENV_VAR}=1; CI must install claude`,
      );
    });
  },
);
