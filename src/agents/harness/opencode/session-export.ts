/**
 * session-export.ts — reading one run's opencode session back for a handover.
 *
 * The handover hook runs while the run's process is still alive, so the session
 * is read from opencode's own store through its CLI, never from a file written
 * at exit. A spawn's worktree and staged definition are both its own: the
 * session list is scoped by the run's directory and the stage's agent name (the
 * spawn id), and the export is opencode's own transfer JSON for that session.
 *
 * The reader classifies native messages into the shared handover vocabulary.
 * Every complete native message becomes a turn, a deliberate omission, or an
 * unparseable record; shared handover code renders the surviving turns and
 * applies the loss policy.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SessionExportError,
  type HandoverRecord,
  type HandoverRecordSource,
} from "../../harness.js";
import { canonicalPath, subagentEnvFileFor } from "../../../paths.js";
import { launchEnvBody } from "../pane-launcher.js";

/** Budget for the session list; a hung CLI must not hold the handover open. */
const SESSION_LIST_TIMEOUT_MS = 15_000;

/** Budget for one session export; a long transcript is read from local storage. */
const SESSION_EXPORT_TIMEOUT_MS = 30_000;

/**
 * The most sessions one directory may return. A worktree holds one run per
 * spawn plus an earlier run per handover; the run being exported is the newest
 * of them, so this only bounds an absurd history.
 */
const SESSION_LIST_LIMIT = 100;

/**
 * The CLI body a shell runs once the run's environment is sourced. `command`
 * bypasses a shell function of the same name, exactly as the pane launcher
 * does, so a pane's `opencode` function can never answer a handover read.
 */
const OPENCODE_BODY = 'command opencode "$@"';

/** One session as the list reports it: its identity, its run, and its place. */
const OpencodeSessionSummarySchema = z.object({
  id: z.string().min(1),
  agent: z.string().optional(),
  model: z
    .object({
      id: z.string().min(1),
      providerID: z.string().min(1),
    })
    .optional(),
  time: z.object({ updated: z.number() }),
  location: z.object({ directory: z.string().min(1) }),
});

export type OpencodeSessionSummary = z.infer<
  typeof OpencodeSessionSummarySchema
>;

/** The list envelope: the sessions of one directory, newest first. */
const OpencodeSessionListSchema = z.object({
  data: z.array(OpencodeSessionSummarySchema),
});

/** One assistant content part; only the `text` arm is conversation. */
const OpencodePartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
});

/** One message; the types this renderer does not read carry no `text`. */
const OpencodeMessageSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  content: z.array(OpencodePartSchema).optional(),
});

/** opencode's transfer JSON: the session, and its messages in order. */
const OpencodeSessionExportSchema = z.object({
  info: z.object({ id: z.string().min(1) }),
  messages: z.array(z.unknown()),
});

export interface OpencodeSessionExport {
  readonly sessionId: string;
  readonly messages: readonly unknown[];
}

/**
 * What an opencode export reads: the run's own address in opencode's store.
 * `subagentId` is the staged definition's name (the spawn id), `cwd` is the
 * worktree opencode keyed the session by, and `proofModel` names the model the
 * definition proof runs under so its session is not mistaken for a run.
 */
export interface OpencodeSessionExportRequest {
  readonly pi: ExtensionAPI;
  readonly subagentId: string;
  readonly cwd: string;
  readonly proofModel: string;
}

/**
 * The list request, scoped to one directory. The directory rides the query
 * because the list endpoint pages globally otherwise, and a session that has
 * been idle for a while would fall off the page.
 */
export function opencodeSessionListPath(cwd: string): string {
  return `/api/session?directory=${encodeURIComponent(cwd)}&limit=${SESSION_LIST_LIMIT}`;
}

/** The sessions the API returned, or undefined when the output is another shape. */
export function parseOpencodeSessionList(
  stdout: string,
): readonly OpencodeSessionSummary[] | undefined {
  const parsed = parseJson(stdout);
  const list = OpencodeSessionListSchema.safeParse(parsed);
  return list.success ? list.data.data : undefined;
}

/**
 * The session this run wrote.
 *
 * The run's agent is the staged definition's name, which is its spawn id — a
 * spawn id is never reused, so the agent alone identifies the run. The
 * definition proof also opens a session under that name in the same directory
 * before the launch, and its model is the sentinel this harness launches only
 * for that proof; it is not a run, so it is skipped. The newest remaining
 * session is the live one.
 */
export function selectOpencodeRunSession(
  sessions: readonly OpencodeSessionSummary[],
  input: {
    readonly cwd: string;
    readonly subagentId: string;
    /** The model key the definition proof runs under; it names no run. */
    readonly proofModel: string;
  },
): OpencodeSessionSummary | undefined {
  let newest: OpencodeSessionSummary | undefined;
  for (const session of sessions) {
    if (session.agent !== input.subagentId) continue;
    if (!sameDirectory(session.location.directory, input.cwd)) continue;
    if (
      session.model !== undefined &&
      modelKey(session.model) === input.proofModel
    )
      continue;
    if (newest === undefined || session.time.updated > newest.time.updated) {
      newest = session;
    }
  }
  return newest;
}

/**
 * Whether two spellings name one directory. opencode records the directory it
 * was launched in, which is the worktree path this request carries; a symlinked
 * home or `/tmp` on macOS gives one place two names, and text comparison would
 * report the run's own session as another directory's. A path that does not
 * resolve falls back to its resolved spelling, which is all a directory that no
 * longer exists can be compared by.
 */
function sameDirectory(left: string, right: string): boolean {
  return (
    (canonicalPath(left) ?? path.resolve(left)) ===
    (canonicalPath(right) ?? path.resolve(right))
  );
}

/** `provider/model`, the key every layer stores and every flag carries. */
function modelKey(model: {
  readonly providerID: string;
  readonly id: string;
}): string {
  return `${model.providerID}/${model.id}`;
}

/** The exported session, or undefined when the output is another shape. */
export function parseOpencodeSessionExport(
  stdout: string,
): OpencodeSessionExport | undefined {
  const parsed = parseJson(stdout);
  const exported = OpencodeSessionExportSchema.safeParse(parsed);
  if (!exported.success) return undefined;
  return {
    sessionId: exported.data.info.id,
    messages: exported.data.messages,
  };
}

/** JSON, or undefined when the CLI wrote something else. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Classify every complete native message, preserving its raw payload. */
export function classifyOpencodeMessages(
  messages: readonly unknown[],
): readonly HandoverRecord[] {
  return messages.map(readOpencodeMessage);
}

/** Classify one native message, preserving its raw payload only when it is lost. */
function readOpencodeMessage(message: unknown): HandoverRecord {
  const parsed = OpencodeMessageSchema.safeParse(message);
  if (!parsed.success) {
    return { kind: "unparseable", content: JSON.stringify(message) };
  }

  if (parsed.data.type === "user") {
    const text = normalizeText(parsed.data.text);
    return text === undefined
      ? { kind: "dont-export", content: JSON.stringify(message) }
      : { kind: "export", turn: { role: "User", text } };
  }
  if (parsed.data.type !== "assistant") {
    return { kind: "dont-export", content: JSON.stringify(message) };
  }

  const parts = (parsed.data.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => normalizeText(part.text))
    .filter((part): part is string => part !== undefined);
  return parts.length === 0
    ? { kind: "dont-export", content: JSON.stringify(message) }
    : {
        kind: "export",
        turn: { role: "Assistant", text: parts.join("\n\n") },
      };
}

/**
 * One text part with its blank margin removed and no trailing whitespace on any
 * line; undefined when nothing but whitespace survives. A part keeps its own
 * interior layout, including indentation, because the run wrote it as markdown.
 */
function normalizeText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "")
    lines.pop();
  const normalized = lines.join("\n");
  return normalized === "" ? undefined : normalized;
}

/**
 * Export the run's session for the next harness: find the session this run
 * wrote in its directory, then read opencode's transfer JSON for it. Both are
 * reads through the CLI; a refusal is a `SessionExportError` naming its fault,
 * so the handover reports it without knowing this harness.
 */
export async function readOpencodeSessionRecords(
  request: OpencodeSessionExportRequest,
): Promise<HandoverRecordSource> {
  const { pi, subagentId, cwd } = request;
  const envFile = stagedEnvFile(subagentId);
  const sessions = await readSessionList(pi, envFile, cwd);
  const session = selectOpencodeRunSession(sessions, {
    cwd,
    subagentId,
    proofModel: request.proofModel,
  });
  if (session === undefined) {
    throw new SessionExportError(
      "session-not-found",
      `no opencode session for agent ${subagentId} in ${cwd}: the run wrote no session this harness can find, so there is nothing to hand over.`,
    );
  }
  const exported = await run(
    pi,
    envFile,
    ["session", "export", "--standalone", session.id],
    SESSION_EXPORT_TIMEOUT_MS,
    `export opencode session ${session.id}`,
  );
  const parsed = parseOpencodeSessionExport(exported);
  if (parsed === undefined) {
    throw new SessionExportError(
      "malformed-record",
      `\`opencode session export ${session.id}\` returned a shape this harness does not recognize.`,
    );
  }
  return {
    sessionId: parsed.sessionId,
    records: classifyOpencodeMessages(parsed.messages),
  };
}

/** The sessions in one directory, read through the private server. */
async function readSessionList(
  pi: ExtensionAPI,
  envFile: string | null,
  cwd: string,
): Promise<readonly OpencodeSessionSummary[]> {
  const stdout = await run(
    pi,
    envFile,
    ["api", "--standalone", "GET", opencodeSessionListPath(cwd)],
    SESSION_LIST_TIMEOUT_MS,
    `list the opencode sessions in ${cwd}`,
  );
  const sessions = parseOpencodeSessionList(stdout);
  if (sessions === undefined) {
    throw new SessionExportError(
      "malformed-record",
      `\`opencode api GET /api/session\` for ${cwd} returned a shape this harness does not recognize.`,
    );
  }
  return sessions;
}

/**
 * The staged environment this run launched with, or null when the spawn staged
 * none. `env.sh` is the spawn's own file, owner-only, written by the launch and
 * sourced by the pane's launcher; a store selector such as `XDG_DATA_HOME`
 * lives there, so a read that ignored it would query the parent session's store
 * and find no session at all.
 */
function stagedEnvFile(subagentId: string): string | null {
  const file = subagentEnvFileFor(subagentId);
  return existsSync(file) ? file : null;
}

/**
 * The program and argv one CLI read runs: opencode directly when the spawn
 * staged no environment, and through a shell that sources `env.sh` when it did.
 * Only the file's path joins the command — the values stay in the file, as they
 * do in the pane.
 */
function invocation(
  envFile: string | null,
  args: readonly string[],
): [command: string, args: string[]] {
  if (envFile === null) return ["opencode", [...args]];
  return [
    "sh",
    ["-c", launchEnvBody(envFile, OPENCODE_BODY), "opencode", ...args],
  ];
}

/** One CLI read, with its failure reported as the command that failed. */
async function run(
  pi: ExtensionAPI,
  envFile: string | null,
  args: readonly string[],
  timeout: number,
  action: string,
): Promise<string> {
  const [command, argv] = invocation(envFile, args);
  const result = await pi.exec(command, argv, { timeout });
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new SessionExportError(
      "export-command-failed",
      `could not ${action}: \`opencode ${args.join(" ")}\` exited ${result.code}${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  return result.stdout;
}
