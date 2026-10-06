/**
 * paths.ts — extension-level directory resolution.
 * Everything here is a FUNCTION, not a module-scope constant: the agent dir
 * can be redirected per process, so a snapshot would freeze the wrong
 * directory — and resolving it must not pull pi's library barrel into the
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
 * `<tmpdir>/pi-cowboy/<agentId>/`. Resolved per call, like every directory
 * here, so a `TMPDIR` override moves the whole staging area with it.
 */
export function subagentResultDir(): string {
  return path.join(tmpdir(), "pi-cowboy");
}

export const EXTENSION_AGENTS_DIR = fileURLToPath(
  new URL("../agents/", import.meta.url),
);

export const EXTENSION_ORCHESTRATORS_DIR = fileURLToPath(
  new URL("../orchestrators/", import.meta.url),
);
