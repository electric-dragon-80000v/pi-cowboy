/**
 * pi-headless.ts — drive the REAL `pi` binary against the fake-openai stub.
 * No real LLM, no API keys, no network beyond 127.0.0.1; the real `~/.pi`
 * is never touched.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Exported so a step can link THIS repo's extension into a temp agent dir.
export const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const PI_CLI = join(
  REPO_ROOT,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);

/** Fake provider/model shared by every step integration test. */
const STUB_PROVIDER_ID = "step-integration-fake";
const STUB_MODEL_ID = "pong-model";
export const STUB_API_KEY = "step-integration-test-key";

export const PI_RUN_TIMEOUT_MS = 90_000;

export interface PiRunResult {
  /** Exit code; -1 when killed by a signal (see `signal`). */
  code: number;
  /** The signal that killed the process, or null when it exited on its own. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * A handle to a `pi` process while it runs, handed to a caller that must act
 * on the process mid-flight (a cancel-during-inference test sends it a
 * signal, an rpc-mode orchestrator is driven through its stdin). Deliberately
 * this small: the child-process object stays inside this module.
 */
export interface PiProcessHandle {
  /** Best effort — signalling an exited process is a no-op. */
  signal(signal: NodeJS.Signals): void;
  /**
   * Write one command to pi's stdin as a JSON line. Only a `stdin: "pipe"` run
   * has a channel; without one this throws rather than dropping the command.
   */
  send(command: Record<string, unknown>): void;
  /** Close pi's stdin; an rpc-mode run shuts down on EOF and exits 0. */
  endInput(): void;
}

/**
 * Run the real pi binary headlessly and collect its output.
 *
 * stdin is "ignore" by default: pi --print reads piped stdin as extra prompt
 * input, so an always-open pipe would hang the child forever. `--mode rpc`
 * passes `stdin: "pipe"` and drives the channel through the handle.
 *
 * `options.onSpawn` is additive: a caller that passes it can signal the run
 * or send commands while it is in flight; otherwise just await the result.
 */
export function runPiHeadless(
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    timeoutMs: number;
    stdin?: "ignore" | "pipe";
    onSpawn?: (handle: PiProcessHandle) => void;
  },
): Promise<PiRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PI_CLI, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
    });
    options.onSpawn?.({
      signal: (signal) => {
        child.kill(signal);
      },
      send: (command) => {
        if (child.stdin === null) {
          throw new Error(
            'send: this pi run has no stdin channel (start it with stdin: "pipe")',
          );
        }
        child.stdin.write(`${JSON.stringify(command)}\n`);
      },
      endInput: () => {
        child.stdin?.end();
      },
    });
    const out = child.stdout;
    const err = child.stderr;
    if (out === null || err === null) {
      throw new Error("runPiHeadless: pi was spawned without piped output");
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    out.on("data", (chunk: Buffer) => stdout.push(chunk));
    err.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `pi timed out after ${options.timeoutMs}ms\nstderr: ${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export function writeModelsJson(agentDir: string, baseUrl: string): void {
  const modelsJson = {
    providers: {
      [STUB_PROVIDER_ID]: {
        baseUrl,
        apiKey: STUB_API_KEY,
        api: "openai-completions",
        models: [{ id: STUB_MODEL_ID }],
      },
    },
  };
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson));
}

/** Isolate `pi` from the developer machine: temp agent/session dirs, temp cwd (no trust prompts or context files), offline mode. */
export function piIsolatedEnv(
  agentDir: string,
  sessionDir: string,
): Record<string, string | undefined> {
  return {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_OFFLINE: "1",
  };
}

export function piModelArgs(): string[] {
  return ["--provider", STUB_PROVIDER_ID, "--model", STUB_MODEL_ID];
}
