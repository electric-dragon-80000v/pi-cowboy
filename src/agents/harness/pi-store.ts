/**
 * pi-store.ts — pi's session store: the variables that decide where pi keeps a
 * session, and the store pi's harnesses publish. The pi family's reserved table
 * in harness.ts restates the two names, which is where a configured value for
 * one is refused before it reaches a launcher.
 */

import { homedir } from "node:os";
import * as path from "node:path";
import { expandTilde } from "../../paths.js";
import { nonEmpty } from "../../predicates.js";
import {
  readSessionDirSetting,
  sessionBucketName,
  type SessionStore,
  type SessionStoreEnv,
} from "./pi-session.js";

/** Environment variable pi uses to replace the whole sessions directory. */
export const PI_SESSION_DIR_ENV_VAR = "PI_CODING_AGENT_SESSION_DIR";

/** Environment variable pi uses to move its agent dir, and the default sessions dir under it. */
export const PI_AGENT_DIR_ENV_VAR = "PI_CODING_AGENT_DIR";

/** Both, in the order a launch carries them. */
export const PI_STORE_ENV_VARS: readonly string[] = [
  PI_AGENT_DIR_ENV_VAR,
  PI_SESSION_DIR_ENV_VAR,
];

/** The project directory pi reads its own settings and resources from. */
const PI_PROJECT_DIR = ".pi";

/** The agent directory pi resolves: its override when set, pi's own otherwise. */
export function piAgentDirectory(env: SessionStoreEnv): string {
  const override = nonEmpty(env[PI_AGENT_DIR_ENV_VAR]);
  if (override !== undefined) return expandTilde(override);
  return path.join(homedir(), ".pi", "agent");
}

/**
 * The directory holding this cwd's sessions: the process-wide session-dir
 * override first, then the merged settings key, then the default under the
 * agent dir. pi's project settings override its global settings for that key.
 */
export async function resolvePiSessionDir(
  cwd: string,
  env: SessionStoreEnv = process.env,
): Promise<string> {
  const envDir = nonEmpty(env[PI_SESSION_DIR_ENV_VAR]);
  if (envDir !== undefined) return path.resolve(expandTilde(envDir));

  const projectDir = await readSessionDirSetting(
    path.join(cwd, PI_PROJECT_DIR),
  );
  if (projectDir !== undefined) {
    return path.resolve(cwd, expandTilde(projectDir));
  }

  const agent = piAgentDirectory(env);
  const globalDir = await readSessionDirSetting(agent);
  if (globalDir !== undefined) return path.resolve(cwd, expandTilde(globalDir));

  return path.join(agent, "sessions", sessionBucketName(cwd));
}

/**
 * The store overrides this process carries, for a child pi to inherit — the pi
 * family's `inheritedEnv` declaration, on every harness that runs a pi binary.
 *
 * A child resolves a store of its own, and the handover export resolves one out
 * of this process's environment: the two agree only when the child is handed the
 * same values. Both names are reserved, so no configured table can supply them —
 * this process's environment is the only source. A set value is made absolute,
 * because the child's cwd is its worktree and a relative path would resolve
 * against that; an unset or empty variable is omitted.
 */
export function inheritedPiStoreEnv(
  env: SessionStoreEnv = process.env,
): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const name of PI_STORE_ENV_VARS) {
    const value = nonEmpty(env[name]);
    if (value === undefined) continue;
    inherited[name] = path.resolve(expandTilde(value));
  }
  return inherited;
}

/**
 * pi's store. It reserves none of its own names: the two it reads are in the pi
 * family's table, which a template is refused against before any id is resolved.
 */
export const piStore: SessionStore = {
  reservedNames: [],
  sessionDir: resolvePiSessionDir,
  inheritedEnv: inheritedPiStoreEnv,
};
