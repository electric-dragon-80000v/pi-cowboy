/**
 * codex-harness.integration.test.ts — the codex launch flags against the real
 * codex binary.
 *
 * Unit tests pin the argv `buildArgs` emits; this proves the real CLI still
 * reads it. codex's config-override parsing and its project-docs suppression
 * are both undocumented implementation details of someone else's binary, so
 * nothing in `src/` can assert them — only a run against the installed CLI
 * can. The argv is assembled by the committed module (`codexHarness.buildArgs`
 * for a request the test builds the way `buildLaunchPlan` does), then a real
 * `codex` runs it with the environment a spawn gives it.
 *
 * The binary is resolved with `commandPath("codex")` — the same seam the
 * harness's own `available()` probe uses — so the test runs against whatever
 * codex the machine actually launches, never a path baked in here. CODEX_HOME
 * is a temp dir: a developer's own auth, skills, hooks and project trust must
 * not be able to leak into the assertions, and no probe here needs them —
 * every command below either renders locally or fails before any network use.
 * The working directory carries an AGENTS.md with a marker, so the
 * suppression case asserts against a file the CLI would otherwise read.
 *
 * A machine without codex skips this file, so the suite still runs there. CI
 * sets `PI_COWBOY_REQUIRE_CODEX=1`, which turns the missing binary into a
 * failing test instead of a silent skip: a job that dropped the install can
 * never pass by not running these tests.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  modelListEntries,
  modelListNotice,
  type CodexLaunchRequest,
} from "../src/agents/harness.js";
import { codexHarness } from "../src/agents/harness/codex.js";
import { commandPath } from "../src/infrastructure/exec-path.js";

const execFileAsync = promisify(execFile);

/** The subagent these tests launch for; the shape a spawn id has. */
const SUBAGENT_ID = "c0d3e4f5";

/** Marker the staged system prompt carries, so a test can tell whose file rode. */
const SYSTEM_MARKER = "CODEX_SYSTEM_MARKER_9b2d77";

/** Marker the working directory's AGENTS.md carries. */
const AGENTS_MARKER = "CODEX_AGENTS_MARKER_51e0ac";

/**
 * Set to `1` in CI: without a codex binary on PATH the tests fail instead of
 * skipping, so a broken install cannot pass the job by not running them.
 */
const REQUIRE_ENV_VAR = "PI_COWBOY_REQUIRE_CODEX";

/** Whether the machine has a codex to run against. */
const codexMissing = commandPath("codex") === undefined;

/** Whether a missing binary must fail this file rather than skip it. */
const codexRequired = process.env[REQUIRE_ENV_VAR] === "1";

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
function codexBinary(): string {
  const bin = commandPath("codex");
  if (bin === undefined) {
    throw new Error(
      `no codex binary on PATH; set ${REQUIRE_ENV_VAR}=1 to fail on this instead of skipping`,
    );
  }
  return bin;
}

/** Temporary roots this file made; removed after every test, pass or fail. */
const madeRoots: string[] = [];

/** The real TMPDIR, put back after every test that redirects it. */
let realTmpdir: string | undefined;

/** The isolated CODEX_HOME for the current test. */
let home: string;

/** The working directory for the current test, carrying an AGENTS.md marker. */
let workdir: string;

/** The staged system prompt file for the current test. */
let systemFile: string;

beforeEach(() => {
  realTmpdir = process.env.TMPDIR;
  const root = fs.mkdtempSync(path.join(tmpdir(), "cowboy-codex-cli-"));
  madeRoots.push(root);
  process.env.TMPDIR = root;
  home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  workdir = path.join(root, "work");
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(
    path.join(workdir, "AGENTS.md"),
    `# Repo guidance\n${AGENTS_MARKER}\n`,
  );
  systemFile = path.join(root, "system.md");
  fs.writeFileSync(systemFile, `${SYSTEM_MARKER}\nYou answer briefly.\n`);
});

afterEach(() => {
  if (realTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmpdir;
  for (const root of madeRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** The environment a spawn gives codex, with CODEX_HOME moved to a temp dir. */
function launchEnv(): NodeJS.ProcessEnv {
  return { ...process.env, CODEX_HOME: home };
}

/** The launch request the harness builds its argv from, as `buildLaunchPlan` builds it. */
function launchRequest(): CodexLaunchRequest {
  return {
    family: "codex",
    subagentId: SUBAGENT_ID,
    systemPromptFile: systemFile,
    taskFile: path.join(workdir, "prompt.md"),
    resultFile: path.join(workdir, "result.md"),
    modelKey: null,
    thinking: null,
    toolSelection: { kind: "default" },
    envFile: null,
    projectTrusted: true,
  };
}

/** Run the real CLI with the harness's own argv, resolving the exit code either way. */
async function runCodex(args: readonly string[]): Promise<CliRun> {
  const bin = codexBinary();
  try {
    const { stdout, stderr } = await execFileAsync(bin, [...args], {
      env: launchEnv(),
      cwd: workdir,
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

/** The model-visible prompt inputs for config overrides, parsed as JSON. */
function promptInputs(stdout: string): { role: string; text: string }[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("`codex debug prompt-input` did not print a JSON array");
  }
  return parsed.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("`codex debug prompt-input` printed a malformed item");
    }
    const record: { role?: unknown; content?: unknown } = item as Record<
      string,
      unknown
    >;
    const content = Array.isArray(record.content) ? record.content : [];
    const text = content
      .map((part) => {
        if (typeof part !== "object" || part === null) return "";
        const textValue = (part as { text?: unknown }).text;
        return typeof textValue === "string" ? textValue : "";
      })
      .join("");
    return {
      role: typeof record.role === "string" ? record.role : "",
      text,
    };
  });
}

describe.skipIf(codexMissing)("codex launch flags against the real CLI", () => {
  it("points the instructions override at the staged system prompt file", () => {
    const args = codexHarness.buildArgs(launchRequest());

    // The argv the pane runs names exactly the file the launch staged — the
    // CLI resolves the rest, and the cases below prove it does.
    expect(args).toEqual(
      expect.arrayContaining([
        "-c",
        `model_instructions_file=${JSON.stringify(systemFile)}`,
      ]),
    );
  });

  it("hard-errors before any model turn when the instructions file is missing", async () => {
    const missing = path.join(workdir, "gone.md");
    const request: CodexLaunchRequest = {
      ...launchRequest(),
      systemPromptFile: missing,
    };

    const result = await runCodex([
      ...codexHarness.buildArgs(request),
      "exec",
      "say hi",
      "--skip-git-repo-check",
    ]);

    // A launch that cannot read its instructions must never reach the model:
    // the error names the file the argv pointed at.
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `failed to read model instructions file ${missing}`,
    );
  });

  it("hard-errors when the instructions file is empty", async () => {
    const empty = path.join(workdir, "empty.md");
    fs.writeFileSync(empty, "");
    const request: CodexLaunchRequest = {
      ...launchRequest(),
      systemPromptFile: empty,
    };

    const result = await runCodex([
      ...codexHarness.buildArgs(request),
      "exec",
      "say hi",
      "--skip-git-repo-check",
    ]);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `model instructions file is empty: ${empty}`,
    );
  });

  it("keeps the repo's AGENTS.md out of the model-visible inputs", async () => {
    const args = codexHarness.buildArgs(launchRequest());
    // The `-c` pairs ride in the global position here: `-s` and `-a` belong
    // to the top-level command the pane runs, not to this debug subcommand.
    const overrides: string[] = [];
    for (let i = 0; i + 1 < args.length; i += 1) {
      if (args[i] === "-c") overrides.push("-c", args[i + 1] as string);
    }
    expect(overrides.length).toBeGreaterThan(0);

    const result = await runCodex([
      ...overrides,
      "debug",
      "prompt-input",
      "hello",
    ]);

    expect(result.code, result.stderr).toBe(0);
    const inputs = promptInputs(result.stdout);
    expect(inputs.length).toBeGreaterThan(0);
    // The marker sits in the working directory's AGENTS.md, which the CLI
    // would otherwise concatenate into the first turn's inputs.
    expect(inputs.some(({ text }) => text.includes(AGENTS_MARKER))).toBe(false);
  });

  it("parses the real bundled catalog into openai keys for listed models alone", async () => {
    const bin = codexBinary();
    const { stdout } = await execFileAsync(
      bin,
      ["debug", "models", "--bundled"],
      { env: launchEnv(), cwd: workdir },
    );
    // A minimal exec-capable stub: the model list reads only stdout and the
    // exit code. The stub keeps the exact stdout the parser saw, so the
    // assertions below compare against that run rather than a second one.
    const runs: CliRun[] = [];
    const pi = {
      exec: async (): Promise<CliRun> => {
        runs.push({ code: 0, stdout, stderr: "" });
        return { code: 0, stdout, stderr: "" };
      },
    } as unknown as ExtensionAPI;

    const list = await codexHarness.listModels({
      pi,
      modelCatalog: { getAvailable: () => [] },
    });
    // A CLI that answered is the harness's own catalogue, with nothing to tell.
    expect(list.kind).toBe("listed");
    const models = modelListEntries(list);

    expect(runs).toHaveLength(1);
    const catalog: unknown = JSON.parse(stdout);
    if (typeof catalog !== "object" || catalog === null) {
      throw new Error("`codex debug models --bundled` printed no object");
    }
    const listed = (
      (catalog as { models?: unknown }).models as {
        slug?: unknown;
        visibility?: unknown;
        supported_reasoning_levels?: { effort?: unknown }[];
      }[]
    ).filter((model) => model.visibility === "list");
    expect(listed.length).toBeGreaterThan(0);
    // Every listed entry is one `openai/<slug>` key: the slug carries no
    // whitespace that would make the key ambiguous, and nothing hidden is
    // offered.
    expect(models.map((entry) => entry.key)).toEqual(
      listed.map((model) => `openai/${String(model.slug)}`),
    );
    expect(models.every((entry) => /^openai\/\S+$/.test(entry.key))).toBe(true);
    // Each entry carries the levels the bundled catalog declares for it, as the
    // closed list codex enforces.
    expect(models.map((entry) => entry.thinkingLevels)).toEqual(
      listed.map((model) => ({
        kind: "closed",
        levels: (model.supported_reasoning_levels ?? []).map((level) =>
          String(level.effort),
        ),
      })),
    );
  });

  it("falls back to a built-in catalogue the live CLI still names, with its levels", async () => {
    const bin = codexBinary();
    const { stdout } = await execFileAsync(
      bin,
      ["debug", "models", "--bundled"],
      { env: launchEnv(), cwd: workdir },
    );
    const live = modelListEntries(
      await codexHarness.listModels({
        pi: {
          exec: async () => ({ code: 0, stdout, stderr: "" }),
        } as unknown as ExtensionAPI,
        modelCatalog: { getAvailable: () => [] },
      }),
    );

    // A CLI that cannot answer is the only way the fallback is read.
    const answer = await codexHarness.listModels({
      pi: {
        exec: async () => ({ code: 1, stdout: "", stderr: "boom" }),
      } as unknown as ExtensionAPI,
      modelCatalog: { getAvailable: () => [] },
    });

    expect(answer.kind).toBe("fallback");
    expect(modelListNotice(answer)).toContain("boom");
    const fallback = modelListEntries(answer);
    expect(fallback.length).toBeGreaterThan(0);
    // A stale fallback is worse than none: every key it offers, at the levels it
    // claims, must still be one this CLI names. A CLI release that dropped a
    // model or a level fails here instead of offering a spawn that cannot run.
    const liveKeys = new Set(live.map((entry) => entry.key));
    expect(
      fallback.map((entry) => entry.key).filter((key) => !liveKeys.has(key)),
    ).toEqual([]);
    const liveLevels = new Map(
      live.map((entry) => [entry.key, entry.thinkingLevels]),
    );
    expect(fallback.map((entry) => [entry.key, entry.thinkingLevels])).toEqual(
      fallback.map((entry) => [entry.key, liveLevels.get(entry.key)]),
    );
  });
});

describe.runIf(codexMissing && codexRequired)(
  "codex launch flags require the binary",
  () => {
    it("fails instead of skipping", () => {
      expect.fail(
        `no codex binary on PATH while ${REQUIRE_ENV_VAR}=1; CI must install codex`,
      );
    });
  },
);
