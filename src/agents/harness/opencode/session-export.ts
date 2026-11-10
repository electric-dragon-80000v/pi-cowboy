/**
 * session-export.ts — reading one run's opencode session back for a handover.
 *
 * The handover hook runs while the run's process is still alive, so the session
 * is read from opencode's own store through its CLI, never from a file written
 * at exit. The export is a lookup, not a search: the id is the one staging
 * minted and pinned on the run's command line (`--session`), and opencode's
 * transfer JSON for that id is the transcript. The store is shared with the
 * user's own sessions and every other run's, so nothing is chosen by position,
 * by agent name, or by recency — a run whose agent was switched in the pane
 * still exports by the id it launched with.
 *
 * The reader classifies native messages into the shared handover vocabulary.
 * Every complete native message becomes a user or assistant record, thinking,
 * tool traffic, a compaction summary, another native type, or an unparseable
 * record; shared handover code decides which kinds enter the transcript and
 * applies the loss policy.
 */

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SessionExportError,
  otherRecord,
  type HandoverRecord,
  type HandoverRecordSource,
} from "../../harness.js";
import { subagentEnvFileFor } from "../../../paths.js";
import { errorMessage } from "../../../utils.js";
import { launchEnvBody } from "../pane-launcher.js";
import { opencodeConfigDir, opencodeSessionRecordFile } from "./staging.js";

/** Budget for one session export; a long transcript is read from local storage. */
const SESSION_EXPORT_TIMEOUT_MS = 30_000;

/**
 * The CLI body a shell runs once the run's environment is sourced. `command`
 * bypasses a shell function of the same name, exactly as the pane launcher
 * does, so a pane's `opencode` function can never answer a handover read.
 */
const OPENCODE_BODY = 'command opencode "$@"';

/** The run record staging wrote: the session id the launcher pinned. */
const OpencodeRunRecordSchema = z.object({
  sessionId: z.string(),
});

/**
 * The id shape opencode accepts on `--session`: its `ses_` prefix and no
 * whitespace. Its own ids are that prefix plus 26 base62 characters; the length
 * is not pinned here because the export resolves any id opencode created.
 */
const SESSION_ID = /^ses_[0-9A-Za-z]+$/;

/**
 * One content part: `text` is prose, `reasoning` the model's thinking, and
 * `tool` a tool call. Every other field travels with the part, because a tool
 * payload's own fields are the call.
 */
const OpencodePartSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
  })
  .passthrough();

/**
 * One message; the types this renderer does not read carry no `text`. A
 * session-level compaction is its own record type: `status` says whether it
 * finished, and only the `completed` arm carries the `summary` it produced.
 */
const OpencodeMessageSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  content: z.array(OpencodePartSchema).optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
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
 * What an opencode export reads: the spawn whose staged record names the run's
 * session. The staging directory carries both the record and the run's store
 * selector, so nothing else has to be located.
 */
export interface OpencodeSessionExportRequest {
  readonly pi: ExtensionAPI;
  readonly subagentId: string;
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
export function* classifyOpencodeMessages(
  messages: readonly unknown[],
): Iterable<HandoverRecord> {
  for (const message of messages) yield readOpencodeMessage(message);
}

/** Classify one native message, keeping the raw payload for records left out. */
function readOpencodeMessage(message: unknown): HandoverRecord {
  const parsed = OpencodeMessageSchema.safeParse(message);
  if (!parsed.success) {
    return { kind: "unparseable", content: JSON.stringify(message) };
  }

  if (parsed.data.type === "compaction") {
    return readCompaction(parsed.data);
  }
  if (parsed.data.type === "user") {
    const text = normalizeText(parsed.data.text);
    return text === undefined
      ? otherRecord(parsed.data.type, JSON.stringify(message))
      : { kind: "user", content: text };
  }
  if (parsed.data.type !== "assistant") {
    return otherRecord(parsed.data.type, JSON.stringify(message));
  }

  const content = parsed.data.content ?? [];
  const prose = partTexts(content, "text");
  if (prose.length > 0) {
    return { kind: "assistant", content: prose.join("\n\n") };
  }

  const thinking = partTexts(content, "reasoning");
  if (thinking.length > 0) {
    return { kind: "thinking", content: thinking.join("\n\n") };
  }

  const calls = content.filter((part) => part.type === "tool");
  return calls.length > 0
    ? { kind: "tool-call", content: JSON.stringify(calls) }
    : otherRecord(parsed.data.type, JSON.stringify(message));
}

/** The non-blank text of every part of one type, in order. */
function partTexts(
  parts: readonly { readonly type: string; readonly text?: string }[],
  type: string,
): readonly string[] {
  return parts
    .filter((part) => part.type === type)
    .map((part) => normalizeText(part.text))
    .filter((part): part is string => part !== undefined);
}

/**
 * A session-level compaction, which replaced the history before it with the
 * summary it carries. Only a completed compaction produced prose: a failed one
 * carries an error and no summary, so its `content` is blank and shared handover
 * code starts nothing from it. A `compaction` part nested in an assistant
 * message is provider state rather than a session boundary, so it never reaches
 * here.
 */
function readCompaction(message: {
  readonly status?: string;
  readonly summary?: string;
}): HandoverRecord {
  const summary =
    message.status === "completed" ? normalizeText(message.summary) : undefined;
  return { kind: "compaction", content: summary ?? "" };
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
 * Export the run's session for the next harness: the pinned id names it, and
 * opencode's transfer JSON for that id is the transcript. Both are reads
 * through the CLI; a refusal is a `SessionExportError` naming its fault, so the
 * handover reports it without knowing this harness.
 */
export async function readOpencodeSessionRecords(
  request: OpencodeSessionExportRequest,
): Promise<HandoverRecordSource> {
  const { pi, subagentId } = request;
  const envFile = stagedEnvFile(subagentId);
  const sessionId = runSessionIdOf(opencodeConfigDir(subagentId));
  const exported = await run(
    pi,
    envFile,
    ["session", "export", "--standalone", sessionId],
    SESSION_EXPORT_TIMEOUT_MS,
    `export opencode session ${sessionId}`,
  );
  const parsed = parseOpencodeSessionExport(exported);
  if (parsed === undefined) {
    throw new SessionExportError(
      "malformed-record",
      `\`opencode session export ${sessionId}\` returned a shape this harness does not recognize.`,
    );
  }
  return {
    sessionId: parsed.sessionId,
    records: classifyOpencodeMessages(parsed.messages),
  };
}

/**
 * The id the run was launched with, from the record staging wrote beside
 * opencode's staged config. A missing record means this spawn pinned no id —
 * its staging tree is gone, or the launch predates the pin — and without it
 * there is no session to name.
 */
function runSessionIdOf(configDir: string): string {
  const recordFile = opencodeSessionRecordFile(configDir);
  let text: string;
  try {
    text = readFileSync(recordFile, "utf8");
  } catch (error) {
    throw new SessionExportError(
      "session-not-found",
      `no opencode run record under ${recordFile} (${errorMessage(error)}). This spawn pinned no session id, so the run's session cannot be named.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SessionExportError(
      "malformed-record",
      `malformed opencode run record ${recordFile}: not valid JSON (${errorMessage(error)})`,
    );
  }
  const record = OpencodeRunRecordSchema.safeParse(parsed);
  if (!record.success || !SESSION_ID.test(record.data.sessionId)) {
    throw new SessionExportError(
      "malformed-record",
      `malformed opencode run record ${recordFile}: no valid sessionId`,
    );
  }
  return record.data.sessionId;
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
