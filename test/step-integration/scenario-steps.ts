/**
 * scenario-steps.ts — the FACTORED APPLICATION STEPS of the step integration
 * tests. Only application steps are extracted here; verification steps and
 * script stay inline in the test body (see WRITING-TESTS.md).
 *
 * Criterion: hide what's derivable, show what's arbitrary. A delegation also
 * needs a herdr world of its own — not a step; see herdr-fake.ts.
 *
 * Future steps (names only; no harness yet): `awaitAgentSettled`,
 * `mergeBranch`, `cleanupAgent`.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import type { FakeOpenAI } from "./fake-openai-server.js";
import {
  PI_RUN_TIMEOUT_MS,
  piIsolatedEnv,
  piModelArgs,
  REPO_ROOT,
  runPiHeadless,
  type PiProcessHandle,
  type PiRunResult,
  writeModelsJson,
} from "./pi-headless.js";

/** Cosmetic link name under `extensions/`; pi reads the manifest inside. */
const LOCAL_EXTENSION_DIR_NAME = "pi-cowboy";

/**
 * One step integration test's isolated world: its temp agent dir (holding
 * `models.json`, and the extension link once `installLocalExtension` ran),
 * its temp cwd, and the stub URL/baseUrl pair for its own route prefix.
 */
export interface ScenarioContext {
  agentDir: string;
  workDir: string;
  baseUrl: string;
  chatPath: string;
  /** Extra environment every run inherits; steps add to it (e.g. HERDR_ENV). */
  /** Environment overlay for the spawned pi: a key exists only once a step set it. */
  runEnv: Record<string, string | undefined>;
}

function removeTempDirs(dirs: { agentDir: string; workDir: string }): void {
  rmSync(dirs.agentDir, { recursive: true, force: true });
  rmSync(dirs.workDir, { recursive: true, force: true });
}

/**
 * Give the calling test an isolated world against the stub: temp dirs plus a
 * `models.json` whose baseUrl carries this test's route prefix. Teardown is
 * registered here via `onTestFinished`, so the body needs no `try`/`finally`.
 */
export function initialize(stub: FakeOpenAI, testId: string): ScenarioContext {
  const agentDir = mkdtempSync(join(tmpdir(), "step-integration-agent-"));
  const workDir = mkdtempSync(join(tmpdir(), "step-integration-work-"));
  mkdirSync(join(workDir, "sessions"), { recursive: true });

  const prefix = `/${encodeURIComponent(testId)}`;
  const ctx: ScenarioContext = {
    agentDir,
    workDir,
    baseUrl: stub.origin + prefix,
    chatPath: `${prefix}/chat/completions`,
    runEnv: {},
  };
  writeModelsJson(ctx.agentDir, ctx.baseUrl);
  onTestFinished(() => {
    removeTempDirs(ctx);
  });
  return ctx;
}

/**
 * The built entry the manifest names, so a forgotten build is reported here
 * rather than later as an extension that silently never loaded.
 */
const BUILT_EXTENSION_ENTRY = join(REPO_ROOT, "dist", "index.js");

/**
 * Make this test's `pi` runs load THIS repo's extension: the repo root is
 * linked into the agent dir's `extensions/`, so pi reads the same manifest and
 * the same built entry an installed copy would.
 *
 * Checking the built entry is load-bearing — pi drops a manifest extension
 * whose file is missing instead of failing, so a forgotten build would surface
 * as an extension that never loaded rather than as this error.
 *
 * The run is still marked herdr-shaped (`HERDR_ENV=1`): the extension activates
 * only inside a herdr pane, and this temp run has no herdr. Loadability is
 * verified inline in the test body, not here.
 */
export function installLocalExtension(ctx: ScenarioContext): void {
  if (!existsSync(BUILT_EXTENSION_ENTRY)) {
    throw new Error(
      `installLocalExtension: built extension entry missing at ${BUILT_EXTENSION_ENTRY} — run npm run build (or npm run test:integration, which builds first) before the step-integration tests`,
    );
  }
  const extensionsDir = join(ctx.agentDir, "extensions");
  mkdirSync(extensionsDir, { recursive: true });
  symlinkSync(REPO_ROOT, join(extensionsDir, LOCAL_EXTENSION_DIR_NAME), "dir");
  ctx.runEnv.HERDR_ENV = "1";
}

/** A live orchestrator: the parent `pi` process and the run it ends with. */
interface LiveOrchestrator {
  handle: PiProcessHandle;
  /** Resolves once `handle.endInput()` shut the run down. */
  result: Promise<PiRunResult>;
}

const ORCHESTRATOR_PROMPT_ID = "engage-1";

/**
 * Engage a LIVE orchestrator — the real `pi` binary in rpc mode. A `--print`
 * run exits with its turn and takes the delegation's background launch with it
 * (measured), so the parent must stay up; rpc mode answers the prompt and keeps
 * serving until stdin closes. The prompt travels as an rpc command, sent at spawn.
 */
export function engageOrchestrator(
  ctx: ScenarioContext,
  prompt: string,
): LiveOrchestrator {
  let handle: PiProcessHandle | undefined;

  const result = runPiHeadless(
    [...piModelArgs(), "--mode", "rpc", "--no-session"],
    {
      cwd: ctx.workDir,
      timeoutMs: PI_RUN_TIMEOUT_MS,
      env: {
        ...piIsolatedEnv(ctx.agentDir, join(ctx.workDir, "sessions")),
        ...ctx.runEnv,
      },
      stdin: "pipe",
      onSpawn: (spawned) => {
        handle = spawned;
        spawned.send({
          id: ORCHESTRATOR_PROMPT_ID,
          type: "prompt",
          message: prompt,
        });
      },
    },
  );

  if (handle === undefined) {
    throw new Error("engageOrchestrator: pi never started (no process handle)");
  }

  // endInput() is idempotent with the test's own shutdown, so this teardown is
  // safe always; swallowing the rejection keeps an un-awaited `result` from
  // masking the test's own failure.
  onTestFinished(() => {
    handle?.endInput();
  });
  void result.catch(() => undefined);

  return { handle, result };
}
