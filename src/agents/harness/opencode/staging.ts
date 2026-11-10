/**
 * opencode/staging.ts — the config directory a spawn is pointed at: its path,
 * its assembly, and its removal.
 *
 * opencode launches with `OPENCODE_CONFIG_DIR` naming this directory and with
 * project config disabled, so everything the spawn gets is what lands here: the
 * definition its prompt is read from (definition.ts). Nothing here launches
 * anything or knows which pane the process will live in.
 *
 * The redirect also shadows the user's own `opencode.json` / `opencode.jsonc`,
 * which is where the providers live; a spawn without them has no provider and
 * fails ("User not found"). So the staging copies the user's own config in,
 * filtered by the extension's excluded roots (config.ts) through
 * user-config.ts. Auth needs no copy:
 * `auth.json` lives in the XDG data directory, which `OPENCODE_CONFIG_DIR` does
 * not redirect.
 *
 * The run's session id is minted here rather than read back afterwards: the
 * store is shared with the user's own sessions and every other run's, so "the
 * newest session in this directory" is a guess. The id is written to
 * `session.json` for the export, and the launcher pins it on the command line
 * with `--session`, so the run writes exactly one session and the export knows
 * its id. It is minted in opencode's own shape (`mintSessionId`), so the store
 * holds no session that looks like anything but opencode's.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import * as path from "node:path";
import { subagentResultDirFor } from "../../../paths.js";
import type { ToolSelection } from "../../harness.js";
import {
  ensureResultDir,
  writeResultFile,
} from "../../result-file-permissions.js";
import type { OpencodeConfigRoot } from "./config.js";
import { removeAgentDefinition, writeAgentDefinition } from "./definition.js";
import { writeUserOpencodeConfig } from "./user-config.js";

/** The config directory's name inside a spawn's staging directory. */
const CONFIG_DIR_NAME = "opencode";

/** The run record this harness writes beside opencode's own staged config. */
const SESSION_RECORD_NAME = "session.json";

/** opencode's id prefix, and the alphabet its random characters are drawn from. */
const SESSION_ID_PREFIX = "ses_";
const SESSION_ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** The packed-time head of an id: six bytes written as twelve hex characters. */
const SESSION_ID_TIME_CHARS = 12;

/** The random tail: what an id has left of its 26 characters. */
const SESSION_ID_RANDOM_CHARS = 14;

/** The packed counter opencode gives the first session of a millisecond. */
const SESSION_ID_COUNTER = 1n;

/**
 * What staging wrote: the config directory, the explicit config copy if any,
 * and the session id the launcher pins on its command line.
 */
export interface OpencodeStaging {
  /** The config directory `OPENCODE_CONFIG_DIR` names. */
  readonly configDir: string;
  /** The staged copy of the parent's `OPENCODE_CONFIG` file, when staging made one. */
  readonly explicitConfigFile?: string;
  /** The session id this run is launched with, minted here and recorded for the export. */
  readonly sessionId: string;
}

/**
 * `<subagentResultDirFor(id)>/opencode` — the config dir opencode is pointed at.
 */
export function opencodeConfigDir(subagentId: string): string {
  return path.join(subagentResultDirFor(subagentId), CONFIG_DIR_NAME);
}

/**
 * The run record naming this launch's session inside a config directory.
 */
export function opencodeSessionRecordFile(configDir: string): string {
  return path.join(configDir, SESSION_RECORD_NAME);
}

/**
 * The id opencode itself would mint for a new session.
 *
 * opencode's sessions are `ses_` plus 26 characters, made by
 * `Identifier.descending()` in `packages/schema/src/identifier.ts`: it packs
 * `Date.now() * 4096 + counter` into 48 bits, complements them so a newer id
 * sorts first, writes the six bytes as hex, then appends fourteen characters
 * drawn from a 62-character alphabet. Minting a UUID-shaped id is not an
 * option: opencode refuses to create under anything that does not start with
 * `ses` (`Expected a string starting with "ses"`), and an id of any other shape
 * is the one entry in the store that is not opencode's own.
 *
 * The two departures from opencode's generator are both about who mints. It
 * increments `counter` as the low twelve bits of per-millisecond uniqueness
 * because one process mints every session it hosts; a spawn is minted one id,
 * so the counter keeps the value a real id carries. And the random tail is one
 * `randomBytes` draw folded through `%` exactly as opencode folds its own
 * `crypto.getRandomValues` bytes — the bias in that fold is opencode's, and
 * reproducing it is what keeps the tail's character mix indistinguishable.
 */
function mintSessionId(now = Date.now()): string {
  const packed = BigInt(now) * 0x1000n + SESSION_ID_COUNTER;
  const descending = ~packed;
  const time = Array.from({ length: SESSION_ID_TIME_CHARS / 2 }, (_, index) =>
    Number((descending >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
  const random = Array.from(randomBytes(SESSION_ID_RANDOM_CHARS), (byte) =>
    SESSION_ID_ALPHABET.charAt(byte % SESSION_ID_ALPHABET.length),
  ).join("");
  return `${SESSION_ID_PREFIX}${time}${random}`;
}

/** The run record: the id the launcher pins, and nothing else. */
function sessionJson(sessionId: string): string {
  return `${JSON.stringify({ sessionId }, null, 2)}\n`;
}

/**
 * Write the whole staging tree.
 *
 * The system prompt is read before anything is created, so an unreadable prompt
 * file fails the spawn without leaving a half-built tree behind. A definition
 * file already in place is overwritten. The user config copy is best-effort: a
 * user with neither file has no providers to carry.
 */
export function writeOpencodeStaging(input: {
  subagentId: string;
  systemPromptFile: string;
  toolSelection: ToolSelection;
  configInclude: readonly OpencodeConfigRoot[];
}): OpencodeStaging {
  const systemPrompt = fs.readFileSync(input.systemPromptFile, "utf-8");
  const configDir = opencodeConfigDir(input.subagentId);
  const sessionId = mintSessionId();
  writeAgentDefinition(configDir, {
    subagentId: input.subagentId,
    systemPrompt,
    toolSelection: input.toolSelection,
  });
  ensureResultDir(configDir);
  writeResultFile(opencodeSessionRecordFile(configDir), sessionJson(sessionId));
  const explicitConfigFile = writeUserOpencodeConfig({
    configDir,
    configInclude: input.configInclude,
  });
  return { configDir, explicitConfigFile, sessionId };
}

/**
 * Remove the staging tree: the files each module staged, then the directory that
 * held them. Best effort and idempotent — every step is a no-op when its target
 * is already gone.
 */
export function removeOpencodeStaging(subagentId: string): void {
  const configDir = opencodeConfigDir(subagentId);
  removeAgentDefinition(configDir, subagentId);
  removeConfigDir(configDir);
}

/** Remove the directory the staged files lived in. Best effort. */
function removeConfigDir(configDir: string): void {
  try {
    fs.rmSync(configDir, { recursive: true, force: true });
  } catch {
    // Best effort: the config directory is a temp-dir artifact, like the rest of
    // the spawn's staging files.
  }
}
