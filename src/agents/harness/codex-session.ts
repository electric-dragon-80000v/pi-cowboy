/**
 * harness/codex-session.ts — reading one codex run's session out of its
 * rollout file, for a handover export.
 *
 * codex writes one append-only JSONL file per thread under
 * `$CODEX_HOME/sessions/YYYY/MM/DD/`. The file is the session: it carries the
 * connection's `session_meta` (its thread id and the cwd the run started in)
 * and every `response_item` the model exchanged. This module resolves the file
 * for a run's cwd and classifies the conversation records it holds into the
 * shared handover vocabulary; rendering the artifact, counting the loss, and
 * applying the exclusion policy all belong to the shared handover layer.
 *
 * The cwd is the lookup key because a run owns one worktree. The newest
 * rollout whose metadata names that cwd belongs to the live (settled) run:
 * its file is opened when the process starts and written on every turn, so no
 * earlier session in the same worktree can be newer. Subagent rollouts share
 * the parent's cwd and must be excluded, and `thread_source` is what marks
 * one.
 *
 * The id is read from `session_meta.payload.id`, never parsed from the
 * filename. A reverted thread's filename appends `_<rollout id>` after its
 * stable thread id, and a fork's `session_id` names the root thread rather
 * than this one.
 *
 * Which home to look in is resolved here too (`codexHomeDirectory`), because
 * the launch hands the child that same value: one resolver, so the store the
 * child writes and the store this reader scans cannot be told apart.
 *
 * The store's shapes are the schema module's (`codex-session-schema.ts`): what a
 * rollout's first line and each following line are is decided there, and this
 * module reads only what those schemas accepted.
 *
 * A rollout line is one of three things to this reader. A conversation record
 * whose prose survived codex's own filtering is a turn. A conversation record
 * that codex emptied or injected — an image-only message, an injected
 * user-role envelope — is still a record of the conversation, so it is reported
 * as deliberately not exported and the shared layer keeps it in the count. A
 * record that should carry a turn and cannot be interpreted is reported as
 * such. Everything else in the store — metadata, reasoning, tool calls and
 * their results, token counts, turn state — was never conversation and yields
 * no record at all, so it cannot be mistaken for loss.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { canonicalPath, expandTilde } from "../../paths.js";
import { SessionExportError, type HandoverRecord } from "../harness.js";
import {
  RolloutLineSchema,
  SessionMetaSchema,
  type RolloutRecord,
  type Turn,
} from "./codex-session-schema.js";

/** The directory holding every rollout, under codex's own home. */
const SESSIONS_SUBDIR = "sessions";

/** A rollout file, not its cold `.jsonl.zst` form. */
const ROLLOUT_FILE = /^rollout-.*\.jsonl$/;

/**
 * How much of a rollout the metadata reader may scan for its first line. The
 * first line carries the base instructions and reached 45 KiB in the largest
 * file here; one mebibyte leaves room without ever reading a whole rollout
 * just to find its cwd.
 */
const FIRST_LINE_LIMIT_BYTES = 1024 * 1024;

/**
 * User-role content codex prepends on the user's behalf. None of it is the
 * human's turn, and the review and command envelopes quote tool output.
 */
const INJECTED_USER_PREFIXES: readonly string[] = [
  "<environment_context>",
  "<turn_aborted>",
  "<user_action>",
  "<recommended_plugins>",
  "<skill>",
  "<user_shell_command>",
  "<codex_internal_context>",
  "<app-context>",
  "# AGENTS.md instructions for",
];

/** An image marker codex writes around an attached image, not user prose. */
const IMAGE_MARKER = /<\/?image\b[^>]*>/g;

/**
 * One rollout line the reader kept: its native text, and the record that text
 * validated as. The text rides along because a record the reader cannot
 * interpret is reported by the line it could not read, and the shared layer
 * counts that as loss.
 */
type RolloutLine =
  | {
      readonly kind: "record";
      readonly content: string;
      readonly record: RolloutRecord;
    }
  | { readonly kind: "unreadable"; readonly content: string };

/** Where a run's session lives and the id the CLI resumes it by. */
export interface CodexSessionRecord {
  readonly file: string;
  readonly sessionId: string;
}

/** What a handover export needs: the run's cwd and the codex home to read. */
export interface CodexSessionExportRequest {
  readonly cwd: string;
  readonly codexHome: string;
}

/** A session as this harness reads it, with the record it came from. */
export interface CodexSessionExport extends CodexSessionRecord {
  readonly records: readonly HandoverRecord[];
}

/**
 * The variable codex resolves its home from. The codex family's reserved table
 * in harness.ts restates the name, which is where a configured value for it is
 * refused before it reaches a launcher.
 */
export const CODEX_HOME_ENV_VAR = "CODEX_HOME";

/**
 * codex's home, resolved the way the CLI resolves it: the variable when it names
 * one, codex's own directory otherwise. Absolute either way, and with a leading
 * `~` expanded, so the home is one directory wherever it is read — a relative
 * value resolves against the child's worktree, but against this process's cwd
 * here, and the two would then name different stores.
 */
export function codexHomeDirectory(): string {
  const configured = process.env[CODEX_HOME_ENV_VAR];
  return configured !== undefined && configured !== ""
    ? path.resolve(expandTilde(configured))
    : path.join(homedir(), ".codex");
}

/** Locate the run's rollout file and read its resume id out of the record. */
export function findCodexSession(
  request: CodexSessionExportRequest,
): CodexSessionRecord {
  const sessionsRoot = path.join(request.codexHome, SESSIONS_SUBDIR);
  if (!existsSync(sessionsRoot)) {
    throw new SessionExportError(
      "session-not-found",
      `no codex session store at ${sessionsRoot}`,
    );
  }

  const canonicalCwd = canonicalSpelling(request.cwd);
  let best: { file: string; sessionId: string; mtimeMs: number } | undefined;
  for (const file of rolloutFiles(sessionsRoot)) {
    const meta = readSessionMeta(file);
    if (meta === undefined) continue;
    // A subagent rollout carries its parent's cwd, so it is dropped before the
    // comparison rather than after it.
    if (meta.subagent) continue;
    if (!samePath(meta.cwd, request.cwd, canonicalCwd)) continue;

    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      // A file removed during the walk cannot be the live run's record.
      continue;
    }
    if (
      best === undefined ||
      mtimeMs > best.mtimeMs ||
      (mtimeMs === best.mtimeMs && file > best.file)
    ) {
      best = { file, sessionId: meta.id, mtimeMs };
    }
  }

  if (best === undefined) {
    throw new SessionExportError(
      "session-not-found",
      `no codex session record under ${sessionsRoot} for ${request.cwd}`,
    );
  }
  return { file: best.file, sessionId: best.sessionId };
}

/** Read one run's session records and the resume id its metadata names. */
export function exportCodexSession(
  request: CodexSessionExportRequest,
): CodexSessionExport {
  const record = findCodexSession(request);
  return {
    file: record.file,
    sessionId: record.sessionId,
    records: readCodexSession(record.file),
  };
}

/**
 * Classify the conversation records of a rollout into the shared handover
 * vocabulary, in file order.
 *
 * `response_item` message records are the conversation.
 *
 * A line this reader cannot interpret is reported, never fatal on its own: the
 * reader returns, and the shared layer decides whether the loss is too large
 * to hand over. An unterminated final line is a write interrupted mid-record —
 * not a record at all, so it is neither read nor reported.
 */
export function readCodexSession(file: string): readonly HandoverRecord[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new SessionExportError(
      "unreadable-record",
      `cannot read codex session record ${file}: ${messageOf(error)}`,
    );
  }

  const lines = text.split("\n");
  // The record the binary may still be appending: the last non-blank line of a
  // file that does not end in a newline. Only this line, when unreadable, is a
  // torn write rather than a loss — it is not a record yet. An unterminated
  // line that is readable is processed as a complete record.
  let torn = -1;
  if (!text.endsWith("\n")) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index]!.trim() !== "") {
        torn = index;
        break;
      }
    }
  }

  const kept: RolloutLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line.trim());
    } catch {
      if (index === torn) continue;
      kept.push({ kind: "unreadable", content: line });
      continue;
    }
    const record = RolloutLineSchema.safeParse(value);
    kept.push(
      record.success
        ? { kind: "record", content: line, record: record.data }
        : { kind: "unreadable", content: line },
    );
  }

  const records: HandoverRecord[] = [];
  for (const line of kept) {
    const record = classifyLine(line);
    if (record !== undefined) records.push(record);
  }
  return records;
}

/** One rollout line in the shared vocabulary, or nothing when it is not conversation. */
function classifyLine(line: RolloutLine): HandoverRecord | undefined {
  if (line.kind === "unreadable") {
    return { kind: "unparseable", content: line.content };
  }
  const record = line.record;
  switch (record.kind) {
    // Store traffic was never the conversation, so it is absent from the read
    // rather than present as a deliberate omission.
    case "traffic":
      return undefined;
    case "turn":
      return responseItemTurn(record, line.content);
  }
}

/** A `response_item` message as a turn: the prose of the parts its role writes. */
function responseItemTurn(turn: Turn, content: string): HandoverRecord {
  const expected = turn.role === "user" ? "input_text" : "output_text";
  const prose = turn.parts.flatMap((part) =>
    part.kind === "prose" && part.type === expected ? [part.text] : [],
  );
  const text =
    turn.role === "user" ? userText(prose) : normalizeText(prose.join("\n\n"));
  return turnRecord(turn.role === "user" ? "User" : "Assistant", text, content);
}

/** A turn when the prose survived, and a deliberate omission when it did not. */
function turnRecord(
  role: "User" | "Assistant",
  text: string,
  content: string,
): HandoverRecord {
  return text === ""
    ? { kind: "dont-export", content }
    : { kind: "export", turn: { role, text } };
}

/** The surviving prose of a user message, with injected material removed. */
function userText(parts: readonly string[]): string {
  const kept: string[] = [];
  for (const part of parts) {
    const leading = part.trimStart();
    if (INJECTED_USER_PREFIXES.some((prefix) => leading.startsWith(prefix))) {
      continue;
    }
    const withoutImages = part.replace(IMAGE_MARKER, "");
    if (withoutImages.trim() === "") continue;
    kept.push(withoutImages);
  }
  return normalizeText(kept.join("\n\n"));
}

/** Trimmed edges, no trailing whitespace, no edge blank lines. */
function normalizeText(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""));
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
}

/** Every rollout file below the sessions root, at any date depth. */
function rolloutFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new SessionExportError(
        "unreadable-record",
        `cannot read codex session directory ${directory}: ${messageOf(error)}`,
      );
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && ROLLOUT_FILE.test(entry.name)) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files;
}

/** The metadata a rollout's first line carries, as far as a lookup reads it. */
interface SessionMetaSummary {
  readonly id: string;
  readonly cwd: string;
  /** Whether a rollout is an AgentControl subagent's, by either version's mark. */
  readonly subagent: boolean;
}

/** Read and narrow a rollout's `session_meta`; undefined when it has none. */
function readSessionMeta(file: string): SessionMetaSummary | undefined {
  const line = readFirstLine(file);
  if (line === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const meta = SessionMetaSchema.safeParse(parsed);
  if (!meta.success) return undefined;
  const payload = meta.data.payload;
  return {
    id: payload.id,
    cwd: payload.cwd,
    subagent: payload.thread_source === "subagent",
  };
}

/** The first line of a file, or undefined when it exceeds the scan budget. */
function readFirstLine(file: string): string | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < FIRST_LINE_LIMIT_BYTES) {
      const chunk = Buffer.alloc(64 * 1024);
      const read = readSync(descriptor, chunk, 0, chunk.length, offset);
      if (read === 0) break;
      const newline = chunk.subarray(0, read).indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(chunk.subarray(0, newline));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(chunk.subarray(0, read));
      offset += read;
    }
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Whether two cwd spellings name the same directory, symlinks resolved.
 *
 * Resolved on every comparison, never remembered: a record outlives the
 * directory it names, and a spelling cached before a worktree was removed and
 * re-created would answer for the wrong one.
 */
function samePath(candidate: string, wanted: string, canonicalWanted: string) {
  return (
    candidate === wanted || canonicalSpelling(candidate) === canonicalWanted
  );
}

/**
 * A path's one real spelling, falling back to its absolute form: the directory a
 * record names may be gone, and the recorded text is the only comparison left.
 */
function canonicalSpelling(value: string): string {
  return canonicalPath(value) ?? path.resolve(value);
}

/** The detail an unknown thrown value carries. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
