/**
 * opencode-session-export.integration.test.ts — handover record reads against
 * the real opencode binary.
 *
 * The unit tests pin selection and record classification against fixtures this
 * repo invented; this file proves the two things only the real CLI can answer: that
 * `opencode api GET /api/session` reports a session the harness can find, and
 * that `opencode session export` returns the transfer JSON the parser reads.
 * Both reads travel through `pi.exec`, so the fake here is only the process
 * boundary: it spawns the installed binary with the same environment a spawn
 * gets.
 *
 * The store is a temp HOME. Sessions are created by importing a crafted
 * transfer document with the real `opencode session import`, never by writing
 * opencode's database: the database is someone else's format, and an import is
 * the CLI's own public way in. The fixture carries a reasoning part and a tool
 * part, so record classification that leaked either would fail on data the real
 * importer accepted.
 *
 * A definition proof opens a session under the same agent name in the same
 * directory, and its model is the sentinel this harness launches only for the
 * proof. The proof is imported last, so it is the newest session the list
 * reports; selecting the run anyway is the behavior this test exists to pin.
 *
 * A machine without opencode skips this file. CI sets
 * `PI_COWBOY_REQUIRE_OPENCODE=1`, which turns the missing binary into a failing
 * test instead of a silent skip.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HarnessExportRequest } from "../src/agents/harness.js";
import { completeHandoverExport } from "../src/agents/handover.js";
import { opencodeHarness } from "../src/agents/harness/opencode/index.js";
import { subagentEnvFileFor } from "../src/paths.js";
import { commandPath } from "../src/infrastructure/exec-path.js";

/** The agent name a spawn stages; the run's session is filed under it. */
const SUBAGENT_ID = "a1b2c3d4";

/** The model the definition proof runs under; it names no run. */
const PROOF_MODEL = {
  id: "opencode-definition-proof",
  providerID: "pi-cowboy",
};

/** Set to `1` in CI: without an opencode binary the tests fail instead of skipping. */
const REQUIRE_ENV_VAR = "PI_COWBOY_REQUIRE_OPENCODE";

/** Whether the machine has an opencode to run against. */
const opencodeMissing = commandPath("opencode") === undefined;

/** Text only the run's transcript may contain, and text it must not. */
const USER_TEXT = "Summarize the failing test.";
const ASSISTANT_TEXT = "The suite passes after the fix.";
const REASONING_TEXT = "SECRET-REASONING-MARKER";
const TOOL_TEXT = "SECRET-TOOL-MARKER";
const PROOF_TEXT = "SECRET-PROOF-MARKER";

/** One finished CLI run. */
interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Temporary roots this file made; removed after every test, pass or fail. */
const madeRoots: string[] = [];

/** The temp root this test made. */
let root: string;

/** The isolated HOME for the current test. */
let home: string;

/** The project directory the imported sessions belong to. */
let project: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), "cowboy-opencode-export-"));
  madeRoots.push(root);
  home = path.join(root, "home");
  project = path.join(root, "project");
  fs.mkdirSync(path.join(home, ".config"), { recursive: true });
  fs.mkdirSync(path.join(home, ".local", "share"), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
});

afterEach(() => {
  for (const root of madeRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** The environment every real CLI run gets: opencode's whole world under the temp HOME. */
function cliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    OPENCODE_CONFIG_DIR: path.join(home, ".config", "opencode"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    ...overrides,
  };
  delete env.OPENCODE_CONFIG;
  return env;
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

/** Run one command, collecting both streams and the exit code. */
function runCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = cliEnv(),
): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      env,
      cwd: project,
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

/** Run the real CLI, collecting both streams and the exit code. */
function runOpencode(
  args: readonly string[],
  env: NodeJS.ProcessEnv = cliEnv(),
): Promise<CliRun> {
  return runCommand(opencodeBinary(), args, env);
}

/**
 * The `pi.exec` a spawn gives its harness: the command the exporter asks for,
 * run as the real process it names. A read that sources the run's env.sh runs
 * through `sh`, so this boundary has to honour the command, not just its args.
 */
function execThroughCli(): ExtensionAPI["exec"] {
  return (async (command: string, args: string[]) => {
    const run = await runCommand(command, args);
    return {
      code: run.code,
      stdout: run.stdout,
      stderr: run.stderr,
      killed: false,
    };
  }) satisfies ExtensionAPI["exec"];
}

/** The request one ended run hands to its harness. */
function request(): HarnessExportRequest {
  return {
    pi: { exec: execThroughCli() } as unknown as ExtensionAPI,
    subagentId: SUBAGENT_ID,
    paneId: "w1:p1",
    cwd: project,
  };
}

/** A message opencode's importer accepts: user turns carry text, nothing else. */
function userMessage(id: string, text: string): unknown {
  return { id, time: { created: 1001 }, type: "user", text };
}

/**
 * An assistant message as opencode's own export writes one. `snapshot`,
 * `finish`, `cost`, and `tokens` are present because the importer rejects a
 * message without them; a fixture missing one proves nothing about the
 * renderer.
 */
function assistantMessage(
  id: string,
  model: { id: string; providerID: string },
  content: readonly unknown[],
): unknown {
  return {
    id,
    time: { created: 1002, completed: 1006 },
    type: "assistant",
    agent: SUBAGENT_ID,
    model: { ...model, variant: "default" },
    content,
    snapshot: { start: "0".repeat(40), end: "0".repeat(40), files: [] },
    finish: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

/** Import one crafted session through the real CLI, under `--directory project`. */
async function importSession(
  input: {
    id: string;
    model: { id: string; providerID: string };
    messages: readonly unknown[];
  },
  env: NodeJS.ProcessEnv = cliEnv(),
): Promise<void> {
  const file = path.join(home, `${input.id}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      info: {
        id: input.id,
        projectID: "fixture-project",
        agent: SUBAGENT_ID,
        model: input.model,
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        time: { created: 1000, updated: 2000 },
        location: { directory: project },
      },
      messages: input.messages,
    }),
  );
  const run = await runOpencode(
    ["session", "import", "--standalone", "--directory", project, file],
    env,
  );
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
}

/** The run's transcript: one visible turn per role, plus traffic that must not travel. */
async function importRun(env: NodeJS.ProcessEnv = cliEnv()): Promise<string> {
  const id = "ses_run0001";
  await importSession(
    {
      id,
      model: { id: "test-model", providerID: "test-provider" },
      messages: [
        userMessage("msg_user", USER_TEXT),
        assistantMessage(
          "msg_run",
          { id: "test-model", providerID: "test-provider" },
          [
            { type: "reasoning", text: REASONING_TEXT },
            {
              type: "tool",
              id: "call_1",
              name: "bash",
              executed: false,
              state: {
                status: "completed",
                input: { command: "echo secret" },
                content: [{ type: "text", text: TOOL_TEXT }],
              },
              time: { created: 1003, ran: 1004, completed: 1005 },
            },
            { type: "text", text: ASSISTANT_TEXT },
          ],
        ),
      ],
    },
    env,
  );
  return id;
}

/** The definition proof's session, imported last so it is the newest one listed. */
async function importProof(): Promise<void> {
  await importSession({
    id: "ses_proof001",
    model: PROOF_MODEL,
    messages: [
      userMessage("msg_proof_user", "confirm the definition"),
      assistantMessage("msg_proof", PROOF_MODEL, [
        { type: "text", text: PROOF_TEXT },
      ]),
    ],
  });
}

describe.skipIf(opencodeMissing)(
  "opencode session export against the real CLI",
  () => {
    it("exports the run's session and skips the newer definition proof", async () => {
      const runId = await importRun();
      await importProof();

      const exported = completeHandoverExport(
        await opencodeHarness.readHandoverRecords!(request()),
      );

      expect(exported.sessionId).toBe(runId);
      expect(exported.session).toBe(
        `## User\n\n${USER_TEXT}\n\n## Assistant\n\n${ASSISTANT_TEXT}\n`,
      );
      expect(exported.session).not.toContain(REASONING_TEXT);
      expect(exported.session).not.toContain(TOOL_TEXT);
      expect(exported.session).not.toContain(PROOF_TEXT);
    });

    it("reports a run that wrote no session", async () => {
      await importProof();

      await expect(
        opencodeHarness.readHandoverRecords!(request()),
      ).rejects.toThrow(
        `no opencode session for agent ${SUBAGENT_ID} in ${project}`,
      );
    });

    it("reads the store the run's staged environment selects", async () => {
      // The run selected a store of its own; the environment this test's
      // process boundary hands the CLI points at the default store, where the
      // run wrote nothing.
      const runStore = path.join(root, "run-store");
      fs.mkdirSync(runStore, { recursive: true });
      const runId = await importRun({ ...cliEnv(), XDG_DATA_HOME: runStore });

      // The staging root is this test's, so the exporter resolves the spawn's
      // env file under it rather than under the machine's temp directory.
      const previousTmpdir = process.env.TMPDIR;
      process.env.TMPDIR = root;
      try {
        const envFile = subagentEnvFileFor(SUBAGENT_ID);
        fs.mkdirSync(path.dirname(envFile), { recursive: true });
        fs.writeFileSync(envFile, `export XDG_DATA_HOME='${runStore}'\n`);

        const exported = completeHandoverExport(
          await opencodeHarness.readHandoverRecords!(request()),
        );

        expect(exported.sessionId).toBe(runId);
        expect(exported.session).toBe(
          `## User\n\n${USER_TEXT}\n\n## Assistant\n\n${ASSISTANT_TEXT}\n`,
        );

        // Without the staged file the read is the parent's environment, which
        // selects the store the run never wrote to.
        fs.rmSync(envFile, { force: true });
        await expect(
          opencodeHarness.readHandoverRecords!(request()),
        ).rejects.toThrow(`no opencode session for agent ${SUBAGENT_ID}`);
      } finally {
        if (previousTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpdir;
      }
    });
  },
);
