/**
 * paths.ts — extension-level directory and staging resolution.
 * A directory resolves per call rather than into a module-scope constant: the
 * agent dir can be redirected per process, so a snapshot would freeze the
 * wrong one. Resolving a directory must not pull pi's library barrel into the
 * boot-time import graph.
 */
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };

export const EXTENSION_NAME = pkg.name;

const AGENT_DIR_ENV_VAR = "PI_CODING_AGENT_DIR";

/**
 * pi's agent dir, resolved locally so boot never imports pi's barrel.
 * Semantics match pi's own `getAgentDir`: the env override wins (with tilde
 * expansion), otherwise `~/.pi/agent`.
 */
export function agentDir(): string {
  const override = process.env[AGENT_DIR_ENV_VAR];
  if (override) return expandTilde(override);
  return path.join(homedir(), ".pi", "agent");
}

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

/**
 * The one spelling the filesystem agrees this location has, or `undefined` when
 * it has none. A directory has as many names as there are routes to it — a
 * symlinked home, a bind mount, `/tmp` on macOS — and comparing those spellings
 * as text reports one place as several. Anything that compares or keys on a
 * path canonicalizes first.
 *
 * `undefined` rather than a fallback: a path that does not exist yet has no
 * real spelling, and only the caller knows what to compare it with then.
 */
export function canonicalPath(value: string): string | undefined {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return undefined;
  }
}

export function defaultExtensionDir(): string {
  return path.join(agentDir(), EXTENSION_NAME);
}

export function defaultWorktreeRoot(): string {
  return path.join(defaultExtensionDir(), "worktrees");
}

/**
 * Staging root for a spawn's briefing, prompt and result files:
 * `<tmpdir>/pi-cowboy/`. Resolved per call, like every directory here, so a
 * `TMPDIR` override moves the whole staging area with it.
 */
export function subagentResultDir(): string {
  return path.join(tmpdir(), "pi-cowboy");
}

/**
 * Canonical staging directory for a subagent id. Parent and child derive the
 * same path independently, so no path ever travels between them.
 */
export function subagentResultDirFor(agentId: string): string {
  return path.join(subagentResultDir(), agentId);
}

/** Canonical result.md for a subagent id. */
export function subagentResultFileFor(agentId: string): string {
  return path.join(subagentResultDirFor(agentId), "result.md");
}

/**
 * pi reads a file whenever `--system-prompt`'s value is an existing path, so
 * multi-line instructions ride out of herdr's single-line argv. The staging
 * file name is fixed here, beside the path that joins it.
 */
const SUBAGENT_SYSTEM_FILE_NAME = "system.md";

/** The pane's `@<file>` initial message; holds the task text and nothing else. */
const SUBAGENT_TASK_FILE_NAME = "prompt.md";

/** pi reads a file from `--system-prompt` when the value names an existing path. */
export function subagentSystemFileFor(agentId: string): string {
  return path.join(subagentResultDirFor(agentId), SUBAGENT_SYSTEM_FILE_NAME);
}

/** Canonical task file for a subagent id — the `@<file>` initial message. */
export function subagentTaskFileFor(agentId: string): string {
  return path.join(subagentResultDirFor(agentId), SUBAGENT_TASK_FILE_NAME);
}

/**
 * Marker prefix a spawn injects into the child's argv so the child can tell it
 * is a subagent. The shape is shell-inert on purpose: herdr types the launch
 * arguments into the pane's shell, and `[...]` would be a glob there — zsh
 * aborts the whole line with "no matches found" before pi ever runs.
 */
export const SUBAGENT_TOKEN_PREFIX = "cowboy-subagent-";

/** The marker a spawn injects into the child's argv; see `detectSubagentSpawn`. */
export function subagentTokenFor(agentId: string): string {
  return `${SUBAGENT_TOKEN_PREFIX}${agentId}`;
}

export const EXTENSION_AGENTS_DIR = fileURLToPath(
  new URL("../agents/", import.meta.url),
);

export const EXTENSION_ORCHESTRATORS_DIR = fileURLToPath(
  new URL("../orchestrators/", import.meta.url),
);
