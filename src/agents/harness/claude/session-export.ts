/**
 * claude/session-export.ts — reading one claude run's transcript for a
 * handover.
 *
 * The harness launches claude with `CLAUDE_CONFIG_DIR` naming a staging
 * directory that belongs to one spawn (`claudeConfigDir`), and links that
 * directory's `projects/` to the store the user's own sessions live in. So a
 * run's store is `<configDir>/projects/<slugged-cwd>/` — durable, shared with
 * every other session in that directory. claude writes one main conversation
 * per run there as `<session-id>.jsonl`, appending one JSON record per event;
 * subagent sidechains are separate `agent-*.jsonl` files beside it. The main
 * file's name is the id `--resume` takes, and every record repeats it as
 * `sessionId`.
 *
 * The export is a lookup, not a search: the config directory comes from the
 * spawn id, the project directory from the canonical cwd, and the file's name
 * from the id staging minted and pinned on the run's command line. The
 * directory holds the user's own conversations and other runs' as well, so
 * nothing is chosen by position or recency. A session that started while this
 * run was live — `/clear` and a fork both start one — means the run moved on,
 * and the export refuses rather than returning the conversation it left
 * behind.
 *
 * The record set carries thinking, tool calls, tool results, system prompts,
 * attachments, command wrappers, and transport errors. Every complete native
 * entry is classified into the shared vocabulary: a user or assistant turn,
 * thinking, tool traffic, a compaction summary, another native type, or an
 * unparseable record. Shared handover code alone decides which kinds enter the
 * transcript and applies the loss policy.
 *
 * A compaction is the synthetic `user` record claude writes with
 * `isCompactSummary: true`; its message content is the summary that replaced
 * the earlier history. The `system`/`compact_boundary` record that precedes it
 * carries only `compactMetadata` (trigger and token counts), and a
 * `type: "summary"` record with `leafUuid` is the legacy session title, so
 * neither is a compaction summary.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  SessionExportError,
  otherRecord,
  type HandoverRecord,
  type HandoverRecordSource,
} from "../../harness.js";
import { claudeProjectDir, claudeSessionRecordFile } from "./staging.js";

/** What one export reads: the run's config directory and the tree it ran in. */
export interface ClaudeSessionExportRequest {
  readonly configDir: string;
  readonly cwd: string;
}

/** The run record staging wrote: the session id the launcher pinned. */
const ClaudeRunRecordSchema = z.object({
  sessionId: z.string(),
});

/** The session id claude names a file and resumes by. */
const SESSION_FILE_NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** The same shape, for an id read out of a record rather than a filename. */
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The line the extension owns; an export must never write one. */
const HANDOVER_MARKER = "<<pi-cowboy-handover";

/**
 * One content part. A `text` part carries conversation prose and a `thinking`
 * part the model's reasoning; every other type (tool call, tool result, image)
 * is structure the artifact does not keep.
 */
const ClaudeContentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
});

/**
 * A conversation record's message: the content is either the whole message as
 * a string or an array of typed parts. A record that carries neither cannot be
 * read as a turn, and refusing it is how a half-read transcript is never
 * presented as success.
 */
const ClaudeMessageSchema = z.object({
  content: z.union([z.string(), z.array(z.unknown())]),
  model: z.string().optional(),
});

/**
 * The fields this reader places a record by. Everything else claude writes —
 * parent pointers, timestamps, cwd, usage, tool payloads — is dropped here: a
 * record that cannot carry these fields is not one the reader can put in a
 * conversation, and guessing at it would be a misread rather than a skip.
 */
const ClaudeSessionRecordSchema = z.object({
  type: z.string().optional(),
  sessionId: z.string().optional(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  isVisibleInTranscriptOnly: z.boolean().optional(),
  isApiErrorMessage: z.boolean().optional(),
  message: z.unknown().optional(),
});

/** One record as the reader sees it, with every unread field stripped. */
type ClaudeSessionRecord = z.infer<typeof ClaudeSessionRecordSchema>;

/** One native line preserved with its parsed record, when it has one. */
type ClaudeLine =
  | {
      readonly kind: "record";
      readonly content: string;
      readonly record: ClaudeSessionRecord;
    }
  | { readonly kind: "unparseable"; readonly content: string };

/**
 * Read the records one run wrote. The pinned id names the only file this run
 * may have written; synchronous local reads fit the harness hook's promise.
 */
export function readClaudeSessionRecords(
  request: ClaudeSessionExportRequest,
): HandoverRecordSource {
  const projectDir = claudeProjectDir(request.configDir, request.cwd);
  const sessionId = runSessionIdOf(request.configDir);
  return readClaudeSession(
    runSessionFile(projectDir, sessionId, request.cwd),
    sessionId,
  );
}

/**
 * The id the run was launched with, from the record staging wrote beside
 * claude's own state. A missing record means the staging tree is gone — a
 * cleared spawn, or a run that never launched — and without it there is no
 * file to name.
 */
function runSessionIdOf(configDir: string): string {
  const recordFile = claudeSessionRecordFile(configDir);
  let text: string;
  try {
    text = fs.readFileSync(recordFile, "utf8");
  } catch (error) {
    throw new SessionExportError(
      "session-not-found",
      `no claude run record under ${recordFile} (${errorMessage(error)}). The spawn's staging directory is gone, so the session id its run was launched with is unknown.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SessionExportError(
      "malformed-record",
      `malformed claude run record ${recordFile}: not valid JSON (${errorMessage(error)})`,
    );
  }
  const record = ClaudeRunRecordSchema.safeParse(parsed);
  if (!record.success || !SESSION_ID.test(record.data.sessionId)) {
    throw new SessionExportError(
      "malformed-record",
      `malformed claude run record ${recordFile}: no valid sessionId`,
    );
  }
  return record.data.sessionId;
}

/**
 * The file the run was launched to write, if the run is still the end of its
 * conversation there.
 *
 * The store is shared, so another session file that was created after this
 * run's, or written after it, is the run having moved on: `/clear` and a fork
 * both start a new session id in the same directory, and handing over the
 * abandoned file would silently drop everything said after it. Creation time
 * is checked beside the write time because claude can append bookkeeping to an
 * abandoned file after the conversation moved on. Another session started in
 * that directory while this run was live looks the same from here, and
 * refusing is still the answer — the export cannot tell whose it is.
 */
function runSessionFile(
  projectDir: string,
  sessionId: string,
  cwd: string,
): string {
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  let written: fs.Stats;
  try {
    written = fs.statSync(file);
  } catch (error) {
    throw new SessionExportError(
      "session-not-found",
      `no claude session ${sessionId} under ${projectDir} for ${cwd} (${errorMessage(error)}). The run wrote no session, or it was launched without this id.`,
    );
  }

  const successors = sessionFilesIn(projectDir).filter((name) => {
    if (name === `${sessionId}.jsonl`) return false;
    try {
      const other = fs.statSync(path.join(projectDir, name));
      return (
        other.mtimeMs > written.mtimeMs ||
        other.birthtimeMs > written.birthtimeMs
      );
    } catch {
      return false;
    }
  });

  if (successors.length > 0) {
    throw new SessionExportError(
      "ambiguous-session",
      `claude wrote ${successors.join(", ")} under ${projectDir} after this run's session ${sessionId}. A /clear or a fork inside the run, or another session started in that directory while the run was live, leaves the run's conversation continuing in a file this export does not have. Refusing to hand over a transcript that may not be where the run ended.`,
    );
  }
  return file;
}

/** Every session file in a project directory, by name. */
function sessionFilesIn(projectDir: string): readonly string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && SESSION_FILE_NAME.test(entry.name))
    .map((entry) => entry.name);
}

/** Read one pinned session file into native records for shared handover. */
export function readClaudeSession(
  file: string,
  sessionId: string,
): HandoverRecordSource {
  const lines = readRecords(file);
  if (!SESSION_ID.test(sessionId)) {
    throw new SessionExportError(
      "malformed-record",
      `claude session file ${file} has no UUID session id`,
    );
  }
  return {
    sessionId,
    records: (function* () {
      for (const line of lines) yield classifyRecord(line, sessionId);
    })(),
  };
}

/**
 * Parse a JSONL file, tolerating only a partial final line. Every other line
 * that cannot be read stays in the source as an unparseable record, so the
 * shared policy decides whether the loss permits handover.
 */
function readRecords(file: string): readonly ClaudeLine[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new SessionExportError(
      "unreadable-record",
      `could not read claude session ${file} (${errorMessage(error)})`,
    );
  }

  const lines = text.split("\n");
  const tail = text.endsWith("\n") ? -1 : lastNonEmptyLine(lines);
  const records: ClaudeLine[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const content = lines[index]!;
    if (content.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      if (index !== tail) records.push({ kind: "unparseable", content });
      continue;
    }
    const record = ClaudeSessionRecordSchema.safeParse(parsed);
    records.push(
      record.success
        ? { kind: "record", content, record: record.data }
        : { kind: "unparseable", content },
    );
  }
  return records;
}

/** The index of the final non-empty line, so a partial tail is recognised. */
function lastNonEmptyLine(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] as string).trim() !== "") return index;
  }
  return -1;
}

/** One complete native line in the shared record vocabulary. */
function classifyRecord(line: ClaudeLine, sessionId: string): HandoverRecord {
  if (line.kind === "unparseable") {
    return { kind: "unparseable", content: line.content };
  }

  const record = line.record;
  if (record.isSidechain === true) {
    return otherRecord(record.type, line.content);
  }
  if (record.type !== "user" && record.type !== "assistant") {
    return otherRecord(record.type, line.content);
  }
  if (
    record.sessionId === undefined ||
    !SESSION_ID.test(record.sessionId) ||
    record.sessionId !== sessionId
  ) {
    return { kind: "unparseable", content: line.content };
  }

  if (record.type === "user") {
    if (record.isCompactSummary === true) {
      const message = messageOf(record.message);
      if (message === undefined) {
        return { kind: "unparseable", content: line.content };
      }
      return { kind: "compaction", content: cleanText(message.text) };
    }
    if (record.isMeta === true || record.isVisibleInTranscriptOnly === true) {
      return otherRecord(record.type, line.content);
    }
    const message = messageOf(record.message);
    if (message === undefined) {
      return { kind: "unparseable", content: line.content };
    }
    const text = cleanText(message.text);
    if (text !== "") {
      return isLocalCommand(text)
        ? otherRecord(record.type, line.content)
        : { kind: "user", content: text };
    }
    const results = partsOfType(message.parts, "tool_result");
    return results.length > 0
      ? { kind: "tool-call", content: JSON.stringify(results) }
      : otherRecord(record.type, line.content);
  }

  if (record.isApiErrorMessage === true) {
    return otherRecord(record.type, line.content);
  }
  const message = messageOf(record.message);
  if (message === undefined) {
    return { kind: "unparseable", content: line.content };
  }
  if (message.model === "<synthetic>") {
    return otherRecord(record.type, line.content);
  }
  const text = cleanText(message.text);
  if (text !== "") return { kind: "assistant", content: text };

  const thinking = partsText(message.parts, "thinking");
  if (thinking !== "") return { kind: "thinking", content: thinking };

  const calls = partsOfType(message.parts, "tool_use");
  return calls.length > 0
    ? { kind: "tool-call", content: JSON.stringify(calls) }
    : otherRecord(record.type, line.content);
}

/**
 * One message's surviving text, the parts it was written as, and its optional
 * model, when its shape is valid.
 */
function messageOf(message: unknown):
  | {
      readonly text: string;
      readonly parts: readonly unknown[];
      readonly model: string | undefined;
    }
  | undefined {
  const body = ClaudeMessageSchema.safeParse(message);
  if (!body.success) return undefined;
  return {
    text: textOfContent(body.data.content),
    parts: typeof body.data.content === "string" ? [] : body.data.content,
    model: body.data.model,
  };
}

/** A thinking part's text, joined across the message with a blank line. */
function partsText(parts: readonly unknown[], type: string): string {
  const kept: string[] = [];
  for (const candidate of parts) {
    const part = ClaudeContentPartSchema.safeParse(candidate);
    if (!part.success || part.data.type !== type) continue;
    const raw = part.data.thinking ?? part.data.text;
    if (raw === undefined) continue;
    const text = cleanText(raw);
    if (text !== "") kept.push(text);
  }
  return kept.join("\n\n");
}

/** Every content part of one native type, kept whole for a tool payload. */
function partsOfType(
  parts: readonly unknown[],
  type: string,
): readonly unknown[] {
  return parts.filter((candidate) => {
    const part = ClaudeContentPartSchema.safeParse(candidate);
    return part.success && part.data.type === type;
  });
}

/** The text blocks of a message's content, joined in order. */
function textOfContent(content: string | unknown[]): string {
  if (typeof content === "string") return content;

  const parts: string[] = [];
  for (const candidate of content) {
    const part = ClaudeContentPartSchema.safeParse(candidate);
    if (!part.success) continue;
    if (part.data.type !== "text" || part.data.text === undefined) continue;
    parts.push(part.data.text);
  }
  return parts.join("\n");
}

/**
 * Remove what §1 forbids from a surviving message: injected
 * `<system-reminder>` blocks, the extension's own marker line, and trailing
 * whitespace. The prose itself is left exactly as written.
 */
function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith(HANDOVER_MARKER) && trimmed.endsWith(">>"));
    })
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "");
}

/**
 * A user record that is a slash command or a local shell result rather than
 * something the human said. claude writes these as ordinary user records with
 * no `isMeta` flag, so the wrapper tag is what identifies them; the caveat
 * record is also matched here, though claude marks that one meta. A message the
 * human typed that happens to start with one of these tags is indistinguishable
 * from the wrapper and is dropped.
 */
function isLocalCommand(text: string): boolean {
  return /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/.test(
    text.trim(),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
