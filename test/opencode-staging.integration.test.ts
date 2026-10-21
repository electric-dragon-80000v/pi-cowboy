/**
 * opencode-staging.integration.test.ts — the staging module and the launch argv
 * against the real opencode binary.
 *
 * Unit tests pin the files `writeOpencodeStaging` emits; this proves the real
 * CLI still reads them, and that the argv `buildArgs` assembles is one the real
 * CLI accepts. opencode's agent-file format and its flag surface are both
 * undocumented implementation details of someone else's binary, so nothing in
 * `src/` can assert them — only a run against the installed CLI can. The tree is
 * staged by the committed module (`writeOpencodeStaging`, `removeOpencodeStaging`,
 * `opencodeConfigDir`), then a real `opencode` is pointed at it with the
 * environment a spawn gives it.
 *
 * Every run is `--standalone`. opencode keeps its configuration in a shared
 * background server, and a client that is not standalone reads that server's
 * config directory instead of the one in its own environment — so a staged
 * definition is only visible under a private server, and a shared server started
 * elsewhere answers for another directory entirely. That server also holds one
 * fixed port per user, so a shared-server run here would collide with a
 * developer's own opencode. `--standalone` avoids both, and it is the flag the
 * harness itself launches with.
 *
 * Nothing here reads the resolved definition back over the CLI. The commands
 * that print one (`debug agents`, `debug agent`) are served by the shared
 * background server rather than by a private one, and the first request after
 * that server starts answers with an empty agent list — so they are neither
 * hermetic nor reliable here. The staged definition's contents are pinned by the
 * unit test instead, and this file proves the two things only a real CLI can:
 * that it resolves the staged definition at all, and that it does not resolve
 * one that was never staged.
 *
 * Resolution is observed through a model that cannot resolve. opencode resolves
 * the agent before the model, so `Model unavailable` is the error a staged agent
 * produces and `Agent not found` is the error a missing one produces. No model
 * is ever called.
 *
 * The binary is resolved with `commandPath("opencode")` — the same seam the
 * harness's own `available()` probe uses — so the test runs against whatever
 * opencode the machine actually launches, never a path baked in here. HOME is a
 * temp dir: opencode reads `~/.config/opencode` and keeps its state under `$HOME`
 * unconditionally, and a developer's own providers, plugins and models must not
 * be able to leak into the assertions. XDG_CONFIG_HOME/XDG_DATA_HOME ride under
 * the same temp HOME for the same reason.
 *
 * A machine without opencode skips this file, so the suite still runs there. CI
 * sets `PI_COWBOY_REQUIRE_OPENCODE=1`, which turns the missing binary into a
 * failing test instead of a silent skip: a job that dropped the install can
 * never pass by not running these tests.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { modelListEntries, type ToolSelection } from "../src/agents/harness.js";
import type { OpencodeConfigRoot } from "../src/agents/harness/opencode/config.js";
import { opencodeHarness } from "../src/agents/harness/opencode/index.js";
import {
  opencodeConfigDir,
  removeOpencodeStaging,
  writeOpencodeStaging,
  type OpencodeStaging,
} from "../src/agents/harness/opencode/staging.js";
import { commandPath } from "../src/infrastructure/exec-path.js";

/** The subagent these tests stage; the shape a spawn id has. */
const SUBAGENT_ID = "a1b2c3d4";

/** An id no test ever stages, for the negative control. */
const UNSTAGED_ID = "zzzzzzzz";

/**
 * The system prompt, ending on a non-whitespace character: opencode trims the
 * prompt's trailing whitespace, so a trailing newline would make the resolved
 * prompt differ from this body for a reason that is not the staging's.
 */
const PROMPT = "You review one diff.\n\nReport defects only.";

/** The reasoning-effort variant a launch carries onto its model reference. */
const VARIANT = "high";

/**
 * A model key that cannot resolve, under a provider opencode knows. An agent
 * that resolved is reported by the failure of this key; a key under an unknown
 * provider would report the provider instead.
 */
const PROBE_MODEL = "opencode/nonexistent-model-pi-cowboy";

/** The message the probe submits; it is never sent, because the model is not. */
const PROBE_MESSAGE = "definition probe";

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

/**
 * The real OPENCODE_CONFIG_DIR, put back after every test. Staging runs in this
 * process and copies the parent's user config from the directory this names, so
 * it is pointed under the isolated HOME too: a developer's own providers must
 * not be copied into the tree the real CLI reads.
 */
let realOpencodeConfigDir: string | undefined;

/** The real OPENCODE_CONFIG, put back after every test. */
let realOpencodeConfig: string | undefined;

beforeEach(() => {
  realTmpdir = process.env.TMPDIR;
  const root = fs.mkdtempSync(path.join(tmpdir(), "cowboy-opencode-cli-"));
  madeRoots.push(root);
  process.env.TMPDIR = root;
  home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".config"), { recursive: true });
  fs.mkdirSync(path.join(home, ".local", "share"), { recursive: true });
  realOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  realOpencodeConfig = process.env.OPENCODE_CONFIG;
  process.env.OPENCODE_CONFIG_DIR = path.join(home, ".config", "opencode");
  delete process.env.OPENCODE_CONFIG;
});

afterEach(() => {
  if (realTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmpdir;
  if (realOpencodeConfigDir === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR;
  } else {
    process.env.OPENCODE_CONFIG_DIR = realOpencodeConfigDir;
  }
  if (realOpencodeConfig === undefined) {
    delete process.env.OPENCODE_CONFIG;
  } else {
    process.env.OPENCODE_CONFIG = realOpencodeConfig;
  }
  for (const root of madeRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** The environment a spawn gives opencode, with HOME moved to a temp dir. */
function launchEnv(
  configDir: string,
  explicitConfigFile?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  };
  delete env.OPENCODE_CONFIG;
  if (explicitConfigFile !== undefined) {
    env.OPENCODE_CONFIG = explicitConfigFile;
  }
  return env;
}

/** Write a file inside this test's temp root and return its path. */
function tempFile(name: string, text: string): string {
  const file = path.join(home, name);
  fs.writeFileSync(file, text);
  return file;
}

/** The parent config directory the staging copies from. */
function parentConfigDir(): string {
  return process.env.OPENCODE_CONFIG_DIR as string;
}

/** Write the parent's user config where the staging looks for it. */
function writeParentConfig(config: unknown): void {
  fs.mkdirSync(parentConfigDir(), { recursive: true });
  fs.writeFileSync(
    path.join(parentConfigDir(), "opencode.json"),
    JSON.stringify(config),
  );
}

/** Stage a spawn's config directory through the committed module. */
function stageTree(
  toolSelection: ToolSelection,
  configInclude: readonly OpencodeConfigRoot[] = [],
): OpencodeStaging {
  const staged = writeOpencodeStaging({
    subagentId: SUBAGENT_ID,
    systemPromptFile: tempFile("system.md", PROMPT),
    toolSelection,
    configInclude,
  });
  // The resolver's own path, so every run below points at the directory the
  // module names rather than a path this file retyped.
  expect(staged.configDir).toBe(opencodeConfigDir(SUBAGENT_ID));
  return staged;
}

/** Stage a spawn's config directory and return it. */
function stage(
  toolSelection: ToolSelection,
  configInclude: readonly OpencodeConfigRoot[] = [],
): string {
  return stageTree(toolSelection, configInclude).configDir;
}

/** Run the real CLI against a staged directory, collecting both streams and the exit code. */
function runOpencode(
  configDir: string,
  args: readonly string[],
  explicitConfigFile?: string,
): Promise<CliRun> {
  const bin = opencodeBinary();
  return new Promise((resolve) => {
    const child = spawn(bin, [...args], {
      env: launchEnv(configDir, explicitConfigFile),
      cwd: path.dirname(configDir),
      // A pipe that is never written and never closed makes opencode wait for a
      // prompt that will not come: these runs submit their message on the argv,
      // so their input is end-of-file.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err: Error) => {
      resolve({ code: 1, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on("close", (code: number | null) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Both streams: opencode writes the usage dump and the errors to either one. */
function output(run: CliRun): string {
  return `${run.stdout}\n${run.stderr}`;
}

/**
 * Ask a private server to resolve one agent. The model is what fails, so an
 * agent that was staged is reported by `Model unavailable` and an id that was
 * never staged by `Agent not found`.
 */
function probeAgent(
  configDir: string,
  agentId: string,
  model = PROBE_MODEL,
): Promise<CliRun> {
  return runOpencode(configDir, [
    "run",
    "--standalone",
    "--agent",
    agentId,
    "--model",
    model,
    PROBE_MESSAGE,
  ]);
}

/** Every path under `dir`, relative to it, sorted; directories end in `/`. */
function tree(dir: string): string[] {
  const entries: string[] = [];
  const walk = (base: string, prefix: string): void => {
    for (const entry of fs
      .readdirSync(base, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        entries.push(`${rel}/`);
        walk(path.join(base, entry.name), rel);
      } else {
        entries.push(rel);
      }
    }
  };
  walk(dir, "");
  return entries;
}

describe.skipIf(opencodeMissing)(
  "opencode staging against the real CLI",
  () => {
    it("finds the installed binary launchable at the version it reports", () => {
      // The availability the probe records is a version judgment, so the real
      // binary's own `--version` is what keeps this harness on offer here.
      expect(opencodeHarness.availability()).toEqual({ status: "available" });
    });

    it("stages the definition and nothing else", () => {
      const configDir = stage({ kind: "default" });

      // The config directory is the spawn's whole opencode world: one agent
      // definition, with no user config to copy. A dependency manifest or a
      // `node_modules` here would mean the staging pays for an install check
      // opencode does not perform.
      expect(tree(configDir)).toEqual(["agent/", `agent/${SUBAGENT_ID}.md`]);
    });

    it("carries the parent's custom provider into the spawn", async () => {
      writeParentConfig({
        provider: {
          "cowboy-test": {
            npm: "@ai-sdk/openai-compatible",
            name: "Cowboy Test",
            options: {
              baseURL: "http://127.0.0.1:9/v1",
              apiKey: "test-key",
            },
            models: {
              "test-model": { name: "Test Model" },
            },
          },
        },
      });
      const configDir = stage({ kind: "default" });

      const run = await runOpencode(configDir, ["models", "--standalone"]);

      expect(run.code, run.stderr).toBe(0);
      expect(output(run)).toContain("cowboy-test/test-model");
    });

    it("carries a provider from the file OPENCODE_CONFIG names", async () => {
      const explicitFile = path.join(home, "dotfiles", "config.json");
      fs.mkdirSync(path.dirname(explicitFile), { recursive: true });
      fs.writeFileSync(
        explicitFile,
        JSON.stringify({
          provider: {
            "cowboy-explicit": {
              npm: "@ai-sdk/openai-compatible",
              name: "Cowboy Explicit",
              options: {
                baseURL: "http://127.0.0.1:9/v1",
                apiKey: "test-key",
              },
              models: { "test-model": { name: "Test Model" } },
            },
          },
        }),
      );
      process.env.OPENCODE_CONFIG = explicitFile;
      const { configDir, explicitConfigFile: stagedFile } = stageTree({
        kind: "default",
      });
      expect(stagedFile).toBeDefined();

      const run = await runOpencode(
        configDir,
        ["models", "--standalone"],
        stagedFile,
      );

      expect(run.code, run.stderr).toBe(0);
      expect(output(run)).toContain("cowboy-explicit/test-model");
    });

    it("resolves the staged agent under a private server", async () => {
      const configDir = stage({ kind: "default" });

      const run = await probeAgent(configDir, SUBAGENT_ID);

      // A definition opencode could not read would be reported as a missing
      // agent; reaching the model is what says this one was read.
      expect(output(run)).not.toContain("Agent not found");
      expect(output(run)).toContain(`Model unavailable: ${PROBE_MODEL}`);
    });

    it("resolves no agent that was never staged", async () => {
      const configDir = stage({ kind: "default" });

      const run = await probeAgent(configDir, UNSTAGED_ID);

      // The control for the test above: without it, any failure at all would
      // read as a definition opencode accepted.
      expect(output(run)).toContain(`Agent not found: "${UNSTAGED_ID}"`);
    });

    it("builds an interactive invocation the CLI accepts", async () => {
      const configDir = stage({ kind: "default" });
      const args = opencodeHarness.buildArgs({
        family: "opencode",
        subagentId: SUBAGENT_ID,
        systemPromptFile: tempFile("system.md", PROMPT),
        taskFile: tempFile("task.md", "do the task"),
        resultFile: path.join(home, "result.md"),
        modelKey: PROBE_MODEL,
        toolSelection: { kind: "default" },
        thinking: VARIANT,
      });

      // The private server is what makes the staged definition the one this
      // launch reads; the shared server answers from whatever config directory
      // it was started with, which is not this spawn's.
      expect(args).toContain("mini");
      expect(args).toContain("--standalone");
      // The variant has no flag of its own: it rides the model reference.
      expect(args[args.indexOf("--model") + 1]).toBe(
        `${PROBE_MODEL}#${VARIANT}`,
      );

      const run = await runOpencode(configDir, args);

      // A usage dump means the CLI refused a flag. A mini that reached the
      // terminal check accepted every flag before it.
      expect(output(run)).not.toContain("Unrecognized flag");
      expect(output(run)).not.toContain("Unexpected positional argument");
      expect(output(run)).toContain("requires a TTY");
    });

    it("removes everything it staged", async () => {
      const configDir = stage({ kind: "default" });
      const run = await probeAgent(configDir, SUBAGENT_ID);
      expect(output(run)).toContain(`Model unavailable: ${PROBE_MODEL}`);
      expect(fs.existsSync(configDir)).toBe(true);

      removeOpencodeStaging(SUBAGENT_ID);

      expect(fs.existsSync(configDir)).toBe(false);
    });

    it("parses the real opencode model API answer into entries with variants", async () => {
      const configDir = stage({ kind: "default" });
      // A minimal exec-capable stub: the model list reads only stdout and the exit
      // code, and the child runs with the same isolated HOME as every other run.
      // The stub runs the args the harness asked for, so the list is the one the
      // harness would really read rather than one this file retyped.
      const runs: { args: readonly string[]; run: CliRun }[] = [];
      const pi = {
        exec: async (
          _command: string,
          args: readonly string[],
        ): Promise<CliRun> => {
          const run = await runOpencode(configDir, args);
          runs.push({ args, run });
          return run;
        },
      } as unknown as ExtensionAPI;

      const list = await opencodeHarness.listModels({
        pi,
        modelCatalog: { getAvailable: () => [] },
      });
      // An API that answered is the harness's own catalogue, with nothing to tell.
      expect(list.kind).toBe("listed");
      const models = modelListEntries(list);

      expect(runs).toHaveLength(1);
      const [{ args, run }] = runs;
      // A shared-server read needs the user's background server and its one
      // fixed port; the private server keeps the call hermetic.
      expect(args).toEqual(["api", "--standalone", "GET", "/api/model"]);
      expect(run.code, run.stderr).toBe(0);
      // Every entry is one enabled model, read off the API's own answer rather
      // than retyped here: the key is `provider/model`, the label its name (or
      // its id when unnamed), and every variant id one level a launch may name
      // after `#`.
      const payload = JSON.parse(run.stdout) as {
        data: {
          providerID: string;
          id: string;
          name?: string;
          variants?: { id: string }[];
        }[];
      };
      expect(payload.data.length).toBeGreaterThan(0);
      expect(models.map((entry) => entry.key)).toEqual(
        payload.data.map((model) => `${model.providerID}/${model.id}`),
      );
      expect(models.map((entry) => entry.label)).toEqual(
        payload.data.map((model) =>
          model.name === undefined || model.name === "" ? model.id : model.name,
        ),
      );
      // Variants are advertised, not enforced: the user may define more, so the
      // list is advisory rather than the closed set this harness accepts.
      expect(models.map((entry) => entry.thinkingLevels)).toEqual(
        payload.data.map((model) => ({
          kind: "advisory",
          levels: (model.variants ?? []).map((variant) => variant.id),
        })),
      );
      // The provider carries no slash, so the key splits at its first one; a
      // model id may carry more (a real id such as `groq/canopylabs/orpheus-…` does).
      expect(models.every((entry) => /^[^/\s]+\/\S+$/.test(entry.key))).toBe(
        true,
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
