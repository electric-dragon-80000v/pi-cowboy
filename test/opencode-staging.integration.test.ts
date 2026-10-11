/**
 * opencode-staging.integration.test.ts — the staging module against the real
 * opencode binary.
 *
 * Unit tests pin the files `writeOpencodeStaging` emits; this proves the real
 * CLI still reads them. opencode's dependency check and its agent-file format
 * are both undocumented implementation details of someone else's binary, so
 * nothing in `src/` can assert them — only a run against the installed CLI can.
 * The tree is staged by the committed module (`writeOpencodeStaging`,
 * `removeOpencodeStaging`, `opencodeConfigDir`), then a real `opencode` is
 * pointed at it with the environment a spawn gives it.
 *
 * The binary is resolved with `commandPath("opencode")` — the same seam the
 * harness's own `available()` probe uses — so the test runs against whatever
 * opencode the machine actually launches, never a path baked in here. HOME is a
 * temp dir: opencode also scans `$HOME/.opencode` and `~/.config/opencode`
 * unconditionally, and a developer's own providers, plugins and models must not
 * be able to leak into the assertions. XDG_CONFIG_HOME/XDG_DATA_HOME ride under
 * the same temp HOME for the same reason.
 *
 * Every assertion reads config and needs no network: `agent list` and
 * `debug agent` resolve the staged definition, and the no-install canary holds a
 * `debug wait` session open. opencode runs its dependency check during config
 * load but forks the install detached, so a command that exits immediately
 * (such as `agent list`) ends before the install could run — the held-open
 * session is what gives a would-be install the time to appear.
 *
 * A machine without opencode skips this file, so the suite still runs there. CI
 * sets `PI_COWBOY_REQUIRE_OPENCODE=1`, which turns the missing binary into a
 * failing test instead of a silent skip: a job that dropped the install can
 * never pass by not running these tests.
 */

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolSelection } from "../src/agents/harness.js";
import { opencodeHarness } from "../src/agents/harness/opencode/index.js";
import {
  opencodeConfigDir,
  removeOpencodeStaging,
  writeOpencodeStaging,
} from "../src/agents/harness/opencode/staging.js";
import { commandPath } from "../src/infrastructure/exec-path.js";
import { subagentTokenFor } from "../src/paths.js";

const execFileAsync = promisify(execFile);

/** The subagent these tests stage; the shape a spawn id has. */
const SUBAGENT_ID = "a1b2c3d4";

/**
 * The system prompt, ending on a non-whitespace character: opencode trims the
 * prompt's trailing whitespace, so a trailing newline would make the verbatim
 * assertion compare against opencode's normalization rather than our body.
 */
const PROMPT = "You review one diff.\n\nReport defects only.";

/**
 * A variant that forces an emitter style: the colon, the quotes and the comment
 * marker rule out a bare scalar, and the backslash pins the escaping.
 */
const VARIANT = 'needs: "quotes" # and a backslash \\';

/**
 * Set to `1` in CI: without an opencode binary on PATH the tests fail instead of
 * skipping, so a broken install cannot pass the job by not running them.
 */
const REQUIRE_ENV_VAR = "PI_COWBOY_REQUIRE_OPENCODE";

/** Whether the machine has an opencode to run against. */
const opencodeMissing = commandPath("opencode") === undefined;

/** Whether a missing binary must fail this file rather than skip it. */
const opencodeRequired = process.env[REQUIRE_ENV_VAR] === "1";

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

/** The binary every run uses, or an error naming how to make its absence fatal. */
function opencodeBinary(): string {
  const bin = commandPath("opencode");
  if (bin === undefined) {
    throw new Error(
      `no opencode binary on PATH; set ${REQUIRE_ENV_VAR}=1 to fail on this instead of skipping`,
    );
  }
  return bin;
}

/** Temporary roots this file made; removed after every test, pass or fail. */
const madeRoots: string[] = [];

/** The real TMPDIR, put back after every test that redirects it. */
let realTmpdir: string | undefined;

/** The isolated HOME for the current test. */
let home: string;

beforeEach(() => {
  realTmpdir = process.env.TMPDIR;
  const root = fs.mkdtempSync(path.join(tmpdir(), "cowboy-opencode-cli-"));
  madeRoots.push(root);
  process.env.TMPDIR = root;
  home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".config"), { recursive: true });
  fs.mkdirSync(path.join(home, ".local", "share"), { recursive: true });
});

afterEach(() => {
  if (realTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmpdir;
  for (const root of madeRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** The environment a spawn gives opencode, with HOME moved to a temp dir. */
function launchEnv(configDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
  };
}

/** Write a system prompt file in this test's root and return its path. */
function promptFile(text: string): string {
  const file = path.join(home, "system.md");
  fs.writeFileSync(file, text);
  return file;
}

/** Stage a spawn's config directory through the committed module. */
function stage(variant: string | null, toolSelection: ToolSelection): string {
  const configDir = writeOpencodeStaging({
    subagentId: SUBAGENT_ID,
    systemPromptFile: promptFile(PROMPT),
    variant,
    toolSelection,
  });
  // The resolver's own path, so every run below points at the directory the
  // module names rather than a path this file retyped.
  expect(configDir).toBe(opencodeConfigDir(SUBAGENT_ID));
  return configDir;
}

/** Run the real CLI against a staged directory, resolving the exit code either way. */
async function runOpencode(
  configDir: string,
  args: readonly string[],
): Promise<CliRun> {
  const bin = opencodeBinary();
  try {
    const { stdout, stderr } = await execFileAsync(bin, [...args], {
      env: launchEnv(configDir),
      cwd: path.dirname(configDir),
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

/** One permission rule in `debug agent`'s resolved list. */
interface PermissionRule {
  readonly permission: string;
  readonly action: string;
  readonly pattern: string;
}

/** The `debug agent` resolution, narrowed to the fields these tests read. */
interface ResolvedAgent {
  readonly mode: string;
  readonly description: string;
  readonly prompt: string;
  readonly variant?: string;
  readonly permission: readonly PermissionRule[];
}

/** Parse `debug agent`'s JSON, failing loudly when it is not the expected shape. */
function parseResolvedAgent(stdout: string): ResolvedAgent {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("`opencode debug agent` did not print a JSON object");
  }
  return parsed as ResolvedAgent;
}

/** The index of the last rule for `permission`, or -1 when no rule names it. */
function lastRuleIndex(rules: readonly PermissionRule[], name: string): number {
  return rules.map((rule) => rule.permission).lastIndexOf(name);
}

/** The last rule's action for `permission`, or undefined when no rule names it. */
function lastAction(
  rules: readonly PermissionRule[],
  name: string,
): string | undefined {
  const index = lastRuleIndex(rules, name);
  return index === -1 ? undefined : rules[index]?.action;
}

/** Every file's byte size under `dir`, recursively. */
function directorySize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(entryPath);
    else total += fs.statSync(entryPath).size;
  }
  return total;
}

/**
 * How long a held-open session is watched for a would-be plugin install. The
 * install appears within a few seconds on a fast link; the budget is generous
 * so a slow runner still catches it rather than passing on a slow install.
 */
const INSTALL_WATCH_MS = 30_000;

/** How often the watch polls. */
const WATCH_POLL_MS = 200;

/** Poll `predicate` until it is true or the budget runs out; the last answer. */
async function waitUntil(
  predicate: () => boolean,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, WATCH_POLL_MS));
  }
}

/**
 * Hold a `debug wait` session open against the staged directory and fail if the
 * plugin install appears in it.
 *
 * opencode runs its dependency check while loading config but forks the install
 * detached, so a command that exits right after loading (`agent list`) would
 * pass this check whether or not the seed works. `debug wait` loads the same
 * config and then idles, so the install has time to materialize if the check
 * did not short-circuit. A process that dies before the window ends is a
 * failure, not a quiet pass: the watch must have had a live opencode to watch.
 */
async function expectNoPluginInstallWhileOpen(
  configDir: string,
): Promise<void> {
  const bin = opencodeBinary();
  const nodeModules = path.join(configDir, "node_modules");
  const child = spawn(bin, ["debug", "wait"], {
    env: launchEnv(configDir),
    cwd: path.dirname(configDir),
    stdio: "ignore",
  });
  let spawnError: Error | undefined;
  child.on("error", (err) => {
    spawnError = err;
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  try {
    const installed = await waitUntil(() => {
      if (spawnError !== undefined) {
        throw new Error(
          `opencode debug wait could not start: ${spawnError.message}`,
        );
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `opencode debug wait exited (code ${child.exitCode}, signal ${child.signalCode}) before the install window ended`,
        );
      }
      return fs.readdirSync(nodeModules).length > 0;
    }, INSTALL_WATCH_MS);
    if (installed) {
      expect.fail(
        `opencode installed its plugin into ${configDir}; the npm seed no longer satisfies its dependency check`,
      );
    }
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
}

describe.skipIf(opencodeMissing)(
  "opencode staging against the real CLI",
  () => {
    it("lists the staged agent as a primary agent", async () => {
      const configDir = stage(null, { kind: "default" });

      const result = await runOpencode(configDir, ["agent", "list"]);

      expect(result.code, result.stderr).toBe(0);
      // A definition opencode could not read would leave the spawn pointed at the
      // promptless default agent instead; the primary marker is what says it did not.
      expect(result.stdout).toContain(`${SUBAGENT_ID} (primary)`);
    });

    it("reports the mode, token, prompt and permission order opencode resolved", async () => {
      const configDir = stage(null, {
        kind: "include",
        names: ["read", "bash"],
      });

      const result = await runOpencode(configDir, [
        "debug",
        "agent",
        SUBAGENT_ID,
      ]);
      expect(result.code, result.stderr).toBe(0);
      const agent = parseResolvedAgent(result.stdout);

      expect(agent.mode).toBe("primary");
      expect(agent.description).toBe(subagentTokenFor(SUBAGENT_ID));
      expect(agent.prompt).toBe(PROMPT);

      // opencode takes the last matching rule, so a catch-all deny only permits
      // the specific names when they follow it in the resolved list.
      const catchAll = lastRuleIndex(agent.permission, "*");
      expect(catchAll).toBeGreaterThanOrEqual(0);
      const specificIndices = ["read", "bash"].map((name) =>
        lastRuleIndex(agent.permission, name),
      );
      expect(Math.min(...specificIndices)).toBeGreaterThan(catchAll);
      expect(
        ["read", "bash"].map((name) => lastAction(agent.permission, name)),
      ).toEqual(["allow", "allow"]);
      expect(lastAction(agent.permission, "*")).toBe("deny");
    });

    it("round-trips a variant that needs a YAML style choice", async () => {
      const configDir = stage(VARIANT, { kind: "default" });

      const result = await runOpencode(configDir, [
        "debug",
        "agent",
        SUBAGENT_ID,
      ]);
      expect(result.code, result.stderr).toBe(0);
      const agent = parseResolvedAgent(result.stdout);

      expect(agent.variant).toBe(VARIANT);
      expect(agent.prompt).toBe(PROMPT);
    });

    it("does not make opencode install its plugin into the config directory", async () => {
      const configDir = stage(null, { kind: "default" });

      // The canary for opencode's dependency check: a seed that no longer
      // satisfies it makes opencode install its plugin into the directory while a
      // session is open, which the held-open run catches. The check runs before
      // any other opencode against this directory, because a completed check
      // leaves a dependency lock in the isolated state dir that suppresses the
      // next run's install.
      await expectNoPluginInstallWhileOpen(configDir);

      expect(fs.readdirSync(path.join(configDir, "node_modules"))).toEqual([]);
      expect(directorySize(configDir)).toBeLessThan(1024 * 1024);
    });

    it("removes everything it staged", async () => {
      const configDir = stage(null, { kind: "default" });
      const result = await runOpencode(configDir, ["agent", "list"]);
      expect(result.code, result.stderr).toBe(0);
      expect(fs.existsSync(configDir)).toBe(true);

      removeOpencodeStaging(SUBAGENT_ID);

      expect(fs.existsSync(configDir)).toBe(false);
    });

    it("parses the real `opencode models` output into provider/model keys", async () => {
      const configDir = stage(null, { kind: "default" });
      // A minimal exec-capable stub: the model list reads only stdout and the exit
      // code, and the child runs with the same isolated HOME as every other run.
      // The stub keeps the exact stdout the parser saw, so the assertion below
      // compares against that run rather than a second one.
      const runs: CliRun[] = [];
      const pi = {
        exec: async (): Promise<CliRun> => {
          const result = await runOpencode(configDir, ["models"]);
          runs.push(result);
          return result;
        },
      } as unknown as ExtensionAPI;

      const models = await opencodeHarness.listModels({
        pi,
        modelCatalog: { getAvailable: () => [] },
      });

      expect(runs).toHaveLength(1);
      const run = runs[0];
      expect(run.code, run.stderr).toBe(0);
      // Every non-empty, non-comment line is one bare `provider/model-id`. A
      // decoration after the key (a marker column, a trailing note) would leave
      // the parsed key shorter than its line; an unparseable line would leave the
      // list short or empty.
      const lines = run.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"));
      expect(lines.length).toBeGreaterThan(0);
      expect(models.map((entry) => entry.key)).toEqual(lines);
      // `parseModelKey` splits at the first slash, so the provider carries none
      // and the model id may (a real id such as `groq/canopylabs/orpheus-…` does).
      expect(models.every((entry) => /^[^/\s]+\/\S+$/.test(entry.key))).toBe(
        true,
      );
      expect(models.map((entry) => entry.label)).toEqual(
        models.map((entry) => entry.key.slice(entry.key.indexOf("/") + 1)),
      );
    });
  },
);

describe.runIf(opencodeMissing && opencodeRequired)(
  "opencode staging requires the binary",
  () => {
    it("fails instead of skipping", () => {
      expect.fail(
        `no opencode binary on PATH while ${REQUIRE_ENV_VAR}=1; CI must install the latest opencode`,
      );
    });
  },
);
