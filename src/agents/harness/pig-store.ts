/**
 * pig-store.ts — pig's session store.
 *
 * pig is a drop-in reimplementation of pi, so it writes pi's format (see
 * pi-session.ts) but keeps its state in its own root: `$PIG_HOME`, else
 * `$XDG_CONFIG_HOME/pig`, else `~/.pig`, with the agent directory
 * `$PIG_CODING_AGENT_DIR` or `<root>/agent`. Its shared mode
 * (`PIG_USE_PI_DIRS=1`) is pi's store exactly — pi's agent directory, pi's
 * project directory, pi's session override — so that mode resolves through
 * piStore rather than restating it here.
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
import { inheritedPiStoreEnv, resolvePiSessionDir } from "./pi-store.js";

/** pig's configuration root: its home, else the XDG subdirectory, else pig's own. */
const PIG_HOME_ENV_VAR = "PIG_HOME";

/** pig's agent directory, the default sessions directory under it. */
const PIG_AGENT_DIR_ENV_VAR = "PIG_CODING_AGENT_DIR";

/** pig's own spelling of the whole-sessions-directory override. */
const PIG_SESSION_DIR_ENV_VAR = "PIG_CODING_AGENT_SESSION_DIR";

/** The mode flag: pig reads pi's directories and pi's names instead of its own. */
const PIG_USE_PI_DIRS_ENV_VAR = "PIG_USE_PI_DIRS";

/** The XDG configuration home, which moves pig's root but no other harness's. */
const XDG_CONFIG_HOME_ENV_VAR = "XDG_CONFIG_HOME";

/** The exact value that selects pi's directories over pig's own. */
const SHARED_DIRECTORIES = "1";

/** pig's project directory, where its own settings and resources are read from. */
const PIG_PROJECT_DIR = ".pig";

/**
 * The env names this store's launch owns: any of them moves where the child
 * writes, and none is in the pi family's table, so a configured entry for one
 * would silently move the run off the store this export reads. `XDG_CONFIG_HOME`
 * is pig's root whenever `PIG_HOME` is unset, so it belongs here even though it
 * is not pig's alone: the reservation is scoped to pig's launches, and a value
 * naming a different root is exactly what would strand a handover.
 */
const PIG_RESERVED_NAMES: readonly string[] = [
  PIG_HOME_ENV_VAR,
  XDG_CONFIG_HOME_ENV_VAR,
  PIG_AGENT_DIR_ENV_VAR,
  PIG_SESSION_DIR_ENV_VAR,
  PIG_USE_PI_DIRS_ENV_VAR,
];

/** Whether pig is configured to read pi's directories instead of its own. */
export function pigUsesPiDirectories(env: SessionStoreEnv): boolean {
  return nonEmpty(env[PIG_USE_PI_DIRS_ENV_VAR]) === SHARED_DIRECTORIES;
}

/** pig's configuration root, which moves settings, sessions and state together. */
export function pigConfigurationRoot(env: SessionStoreEnv): string {
  const home = nonEmpty(env[PIG_HOME_ENV_VAR]);
  if (home !== undefined) return expandTilde(home);
  const xdg = nonEmpty(env[XDG_CONFIG_HOME_ENV_VAR]);
  if (xdg !== undefined) return path.join(expandTilde(xdg), "pig");
  return path.join(homedir(), ".pig");
}

/**
 * pig's agent directory. pig expands a `~` in its own override as it does in
 * every other path variable here: `PIG_CODING_AGENT_DIR='~/pig-agent'` writes
 * under `$HOME/pig-agent/sessions/`.
 */
export function pigAgentDirectory(env: SessionStoreEnv): string {
  const override = nonEmpty(env[PIG_AGENT_DIR_ENV_VAR]);
  if (override !== undefined) return expandTilde(override);
  return path.join(pigConfigurationRoot(env), "agent");
}

/**
 * The directory holding this cwd's sessions: pig's session override (the whole
 * directory, resolved against the run's cwd), then the merged `sessionDir`
 * setting, then the default under the agent dir. In shared mode every step of
 * that is pi's, so pi's resolver answers.
 */
export async function resolvePigSessionDir(
  cwd: string,
  env: SessionStoreEnv = process.env,
): Promise<string> {
  if (pigUsesPiDirectories(env)) return resolvePiSessionDir(cwd, env);

  const envDir = nonEmpty(env[PIG_SESSION_DIR_ENV_VAR]);
  if (envDir !== undefined) return path.resolve(cwd, expandTilde(envDir));

  const agent = pigAgentDirectory(env);
  const setting =
    (await readSessionDirSetting(path.join(cwd, PIG_PROJECT_DIR))) ??
    (await readSessionDirSetting(agent));
  if (setting !== undefined) return path.resolve(cwd, expandTilde(setting));

  return path.join(agent, "sessions", sessionBucketName(cwd));
}

/**
 * The store variables this process carries, for a child pig to inherit — the
 * store's `inheritedEnv` declaration, so the child writes where the export
 * reads.
 *
 * The mode rides always: a child left in the other mode would resolve pi's
 * directories while this process resolves pig's. Then the names that decide the
 * store *in that mode*: pig's own, or pi's, which shared mode reads and pi's
 * store already answers for. An unset or empty variable is omitted.
 */
export function inheritedPigStoreEnv(
  env: SessionStoreEnv = process.env,
): Record<string, string> {
  const mode = nonEmpty(env[PIG_USE_PI_DIRS_ENV_VAR]);
  const inherited: Record<string, string> =
    mode === undefined ? {} : { [PIG_USE_PI_DIRS_ENV_VAR]: mode };

  if (pigUsesPiDirectories(env))
    return { ...inherited, ...inheritedPiStoreEnv(env) };

  for (const name of pigOwnStoreNames(env)) {
    const value = nonEmpty(env[name]);
    if (value === undefined) continue;
    inherited[name] = inheritedStoreValue(name, value);
  }
  return inherited;
}

/**
 * The names that decide this store in pig's own mode: the root that answered,
 * then the agent directory and the session override. The root that lost is not
 * carried: with `PIG_HOME` set, `XDG_CONFIG_HOME` names no directory pig reads
 * a session from.
 */
function pigOwnStoreNames(env: SessionStoreEnv): readonly string[] {
  if (nonEmpty(env[PIG_HOME_ENV_VAR]) !== undefined) {
    return [PIG_HOME_ENV_VAR, PIG_AGENT_DIR_ENV_VAR, PIG_SESSION_DIR_ENV_VAR];
  }
  return [
    XDG_CONFIG_HOME_ENV_VAR,
    PIG_HOME_ENV_VAR,
    PIG_AGENT_DIR_ENV_VAR,
    PIG_SESSION_DIR_ENV_VAR,
  ];
}

/**
 * One value as the export will read it, which is the only way the child's write
 * lands where the export looks. The session override travels as written,
 * because the export resolves it against the run's cwd and the child runs in
 * that cwd; every other name is resolved against this process instead — from
 * this process's home for a `~`, from its cwd for a relative path — and is
 * therefore handed over absolute.
 */
function inheritedStoreValue(name: string, value: string): string {
  if (name === PIG_SESSION_DIR_ENV_VAR) return value;
  return path.resolve(expandTilde(value));
}

/** pig's store: its own directories, or pi's under `PIG_USE_PI_DIRS=1`. */
export const pigStore: SessionStore = {
  reservedNames: PIG_RESERVED_NAMES,
  sessionDir: resolvePigSessionDir,
  inheritedEnv: inheritedPigStoreEnv,
};
