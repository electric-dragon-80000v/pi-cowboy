/**
 * git-runner.ts — Layer 1: the git transport.
 *
 * The only place that shells out through `pi.exec` and the only place that
 * knows a git failure's shape: `run` reports it as data, `exec` throws a
 * `GitError`. Layers above compose these primitives and never touch `pi.exec`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GIT_EXEC_TIMEOUT_MS } from "../../utils.js";

// --- Constants ---

/** Probe budget (ms) — status/rev-parse on big checkouts. */
const PROBE_TIMEOUT_MS = 30_000;

/** Worktree add/remove and checkout-completion budget (ms). */
export const GIT_WORKTREE_TIMEOUT_MS = 60_000;

// --- Error type ---

/** A failed git step. */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

// --- Types ---

/** Outcome of one git invocation. */
export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Per-call `probe` overrides. */
export interface GitProbeOptions {
  /** Timeout in ms; defaults to the probe budget. */
  timeoutMs?: number;
}

/** Bundled-helper invocation options. */
export interface HelperOptions {
  /** Timeout in ms. */
  timeoutMs: number;
  /** Working directory; omitted inherits the parent's. */
  cwd?: string;
}

// --- Transport ---

/** Raw git process I/O, bound to one `pi` instance. */
export class GitCommandRunner {
  constructor(private readonly pi: ExtensionAPI) {}

  /** Run git; `undefined` when `pi.exec` itself fails (transport/timeout). */
  async run(
    args: readonly string[],
    cwd: string,
    timeoutMs: number = GIT_EXEC_TIMEOUT_MS,
  ): Promise<GitRunResult | undefined> {
    try {
      const result = await this.pi.exec("git", [...args], {
        cwd,
        timeout: timeoutMs,
      });
      return {
        code: result.code,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      };
    } catch {
      return undefined;
    }
  }

  /** Trimmed stdout, or `undefined` when the question could not be answered. */
  async probe(
    args: readonly string[],
    cwd: string,
    options: GitProbeOptions = {},
  ): Promise<string | undefined> {
    const result = await this.run(
      args,
      cwd,
      options.timeoutMs ?? PROBE_TIMEOUT_MS,
    );
    if (result === undefined || result.code !== 0) return undefined;
    return result.stdout;
  }

  /** Trimmed stdout; throws `GitError` on any failure. */
  async exec(
    args: readonly string[],
    cwd: string,
    timeoutMs?: number,
  ): Promise<string> {
    const result = await this.run(args, cwd, timeoutMs);
    if (result === undefined) {
      throw new GitError(
        `git ${args.join(" ")} failed in ${cwd}: the command could not be run`,
      );
    }
    if (result.code !== 0) {
      throw new GitError(
        `git ${args.join(" ")} failed in ${cwd} (exit ${result.code}): ${(
          result.stderr ||
          result.stdout ||
          `exit code ${result.code}`
        )
          .trim()
          .slice(0, 500)}`,
      );
    }
    return result.stdout;
  }

  /** Whether git exits zero; "could not run" is no. */
  async test(
    args: readonly string[],
    cwd: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    const result = await this.run(args, cwd, timeoutMs);
    return result !== undefined && result.code === 0;
  }

  /**
   * Non-empty output lines; `undefined` when the probe failed, so a transport
   * error is never mistaken for "no lines".
   */
  async lines(
    args: readonly string[],
    cwd: string,
    delimiter: string = "\n",
  ): Promise<string[] | undefined> {
    const output = await this.probe(args, cwd);
    if (output === undefined) return undefined;
    return output.split(delimiter).filter((line) => line !== "");
  }

  /**
   * Run a bundled helper program through `pi.exec`. A helper that never started
   * reports exit 1 with the transport error in `stderr` — one failure path.
   */
  async helper(
    command: string,
    args: readonly string[],
    options: HelperOptions,
  ): Promise<GitRunResult> {
    try {
      const result = await this.pi.exec(command, [...args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        timeout: options.timeoutMs,
      });
      return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (err) {
      return {
        code: 1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// --- Free-function facade ---

/** `run` for callers holding a pi instance rather than a runner. */
export async function gitRun(
  pi: ExtensionAPI,
  args: string[],
  cwd: string,
  timeoutMs: number = GIT_EXEC_TIMEOUT_MS,
): Promise<GitRunResult | undefined> {
  return new GitCommandRunner(pi).run(args, cwd, timeoutMs);
}

/** `probe` for callers holding a pi instance rather than a runner. */
export async function gitProbe(
  pi: ExtensionAPI,
  args: string[],
  cwd: string,
): Promise<string | undefined> {
  return new GitCommandRunner(pi).probe(args, cwd);
}

// --- Repo layout plumbing ---

/** A repo's common git dir and its main checkout. */
export interface MainCheckoutLocation {
  /** The repo's shared `.git` directory. */
  readonly commonDir: string;
  /** The main checkout root — the parent of `commonDir`. */
  readonly mainRoot: string;
}

/**
 * Repo layout from `git rev-parse --git-common-dir` output. A relative answer
 * resolves against the probed cwd; the main root is the common dir's parent.
 */
export function locateMainCheckout(
  commonDirOutput: string,
  cwd: string,
): MainCheckoutLocation {
  const commonDir = path.isAbsolute(commonDirOutput)
    ? commonDirOutput
    : path.resolve(cwd, commonDirOutput);
  return { commonDir, mainRoot: path.dirname(commonDir) };
}

/**
 * Main checkout root for any in-repo cwd. Herdr rejects a linked worktree as an
 * adoption source, and the caller may itself sit in one — hence the common-dir
 * resolution. Throws GitError outside a git repository.
 */
export async function resolveMainCheckout(
  pi: ExtensionAPI,
  repoCwd: string,
): Promise<string> {
  const runner = new GitCommandRunner(pi);
  const common = await runner.probe(["rev-parse", "--git-common-dir"], repoCwd);
  if (common === undefined) {
    throw new GitError(
      `cannot create worktree: ${repoCwd} is not inside a git repository`,
    );
  }
  const { mainRoot } = locateMainCheckout(common, repoCwd);
  if (!fs.existsSync(path.join(mainRoot, ".git"))) {
    throw new GitError(
      `cannot create worktree: main checkout not found for ${repoCwd}`,
    );
  }
  return mainRoot;
}
