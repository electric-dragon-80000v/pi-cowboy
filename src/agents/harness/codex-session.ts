/**
 * harness/codex-session.ts — reading one codex run's session out of its
 * rollout file, for a handover export.
 *
 * codex writes one append-only JSONL file per thread under
 * `$CODEX_HOME/sessions/YYYY/MM/DD/`. The file is the session: it carries the
 * connection's `session_meta` (its thread id and the cwd the run started in)
 * and every `response_item` the model exchanged. This module resolves the file
 * for a run's cwd, recovers the user and assistant prose, and returns the
 * thread id the CLI resumes by.
 *
 * The cwd is the lookup key because a run owns one worktree. The newest
 * rollout whose metadata names that cwd belongs to the live (settled) run:
 * its file is opened when the process starts and written on every turn, so no
 * earlier session in the same worktree can be newer. Subagent rollouts share
 * the parent's cwd and must be excluded; older versions mark them only in
 * `source`, newer ones also in `thread_source`.
 *
 * The id is read from `session_meta.payload.id`, never parsed from the
 * filename. A reverted thread's filename appends `_<rollout id>` after its
 * stable thread id, and a fork's `session_id` names the root thread rather
 * than this one.
 *
 * Which home to look in is resolved here too (`codexHomeDirectory`), because
 * the launch hands the child that same value: one resolver, so the store the
 * child writes and the store this reader scans cannot be told apart.
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
import { z } from "zod";
import { canonicalPath, expandTilde } from "../../paths.js";
import {
  SessionExportError,
  type HarnessExportLoss,
  type SessionExportTurn,
} from "../harness.js";

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
 * The first line of a rollout, as the lookup reads it. Only `session_meta` is
 * a candidate: every file starts with one. `id` must survive trimming, and a
 * file without it cannot name a session to resume, so it is no candidate.
 * `thread_source` and `source` are the two marks of a subagent rollout, and
 * differ in shape between versions, so their contents are read separately.
 */
const SessionMetaSchema = z.object({
  type: z.literal("session_meta"),
  payload: z.object({
    id: z.string().trim().min(1),
    cwd: z.string().min(1),
    thread_source: z.unknown().optional(),
    source: z.unknown().optional(),
  }),
});

/** One content part of a message; a part that is not text carries no `text`. */
const ContentPartSchema = z.object({
  type: z.string(),
  text: z.unknown().optional(),
});

/** A message's content: the parts in order, or a record this reader refuses. */
const MessageContentSchema = z.array(ContentPartSchema);

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

/** A session as this harness exports it, with the record it came from. */
export interface CodexSessionExport extends CodexSessionRecord {
  readonly session: string;
  readonly loss: HarnessExportLoss;
}

/** One rollout read: its conversation, and the records the reader skipped. */
export interface CodexSessionRead {
  readonly session: string;
  readonly loss: HarnessExportLoss;
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

/** Read one run's session and the resume id its record names. */
export function exportCodexSession(
  request: CodexSessionExportRequest,
): CodexSessionExport {
  const record = findCodexSession(request);
  const read = readCodexSession(record.file);
  return {
    file: record.file,
    sessionId: record.sessionId,
    session: read.session,
    loss: read.loss,
  };
}

/**
 * The conversation in a rollout as markdown, with what the reader had to leave
 * out. Only `## User` and `## Assistant` blocks survive; tool traffic,
 * reasoning, developer instructions, injected user envelopes, and ids are
 * dropped. ATX headings the message itself contains are escaped, so no content
 * line can be read as a role boundary.
 *
 * `response_item` message records are the conversation. Versions before about
 * 0.162 also wrote a duplicate `event_msg` pair for each turn; that form is
 * read only when a file has no `response_item` message at all, so a legacy
 * file still exports and a dual-written file cannot emit every turn twice.
 *
 * A record this reader cannot use is skipped and counted, never fatal on its
 * own: an unreadable line is excluded without aborting the export, and the
 * caller decides whether the loss is too large to hand over. An unterminated
 * final line is a write interrupted mid-record — not a record at all, so it
 * is neither read nor counted.
 */
export function readCodexSession(file: string): CodexSessionRead {
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
  // torn write rather than a loss — it is not a record yet, so it is neither
  // read nor counted. An unterminated line that is readable is processed as a
  // complete record.
  let torn = -1;
  if (!text.endsWith("\n")) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index]!.trim() !== "") {
        torn = index;
        break;
      }
    }
  }

  const turns: SessionExportTurn[] = [];
  const legacyTurns: SessionExportTurn[] = [];
  let sawResponseMessage = false;
  // Message records the export was built from, plus the lines it could not
  // classify. A store's tool traffic is not part of either count.
  let total = 0;
  let excluded = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!.trim();
    if (raw === "") continue;

    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      if (index === torn) continue;
      total += 1;
      excluded += 1;
      continue;
    }
    if (!isRecord(record)) {
      if (index === torn) continue;
      total += 1;
      excluded += 1;
      continue;
    }

    if (record.type === "response_item") {
      const payload = record.payload;
      if (!isRecord(payload) || payload.type !== "message") continue;
      const role = payload.role;
      if (role !== "user" && role !== "assistant") continue;
      sawResponseMessage = true;
      total += 1;
      const read = responseTurn(payload, role);
      if (read.kind === "excluded") {
        excluded += 1;
        continue;
      }
      if (read.turn !== undefined) turns.push(read.turn);
      continue;
    }

    if (record.type !== "event_msg") continue;
    const payload = record.payload;
    if (!isRecord(payload)) {
      total += 1;
      excluded += 1;
      continue;
    }
    const type = payload.type;
    if (type !== "user_message" && type !== "agent_message") continue;
    total += 1;
    if (typeof payload.message !== "string") {
      excluded += 1;
      continue;
    }
    const role = type === "user_message" ? "User" : "Assistant";
    const content =
      role === "User"
        ? userText([payload.message])
        : normalizeText(payload.message);
    if (content !== "") legacyTurns.push({ role, text: content });
  }

  const conversation = sawResponseMessage ? turns : legacyTurns;
  return {
    session: conversation.length === 0 ? "" : renderConversation(conversation),
    loss: { excluded, total },
  };
}

/**
 * One `response_item` message read as a turn, or the record this reader could
 * not read. A turn is absent when the message survived but said nothing.
 */
type MessageRead =
  | { readonly kind: "read"; readonly turn: SessionExportTurn | undefined }
  | { readonly kind: "excluded" };

/** One `response_item` message as a turn, or why it could not be read. */
function responseTurn(
  payload: Record<string, unknown>,
  role: "user" | "assistant",
): MessageRead {
  const content = MessageContentSchema.safeParse(payload.content);
  if (!content.success) return { kind: "excluded" };

  const parts: string[] = [];
  for (const part of content.data) {
    const expected = role === "user" ? "input_text" : "output_text";
    if (part.type !== expected) continue;
    if (typeof part.text !== "string") return { kind: "excluded" };
    parts.push(part.text);
  }

  const text =
    role === "user" ? userText(parts) : normalizeText(parts.join("\n\n"));
  return {
    kind: "read",
    turn:
      text === ""
        ? undefined
        : { role: role === "user" ? "User" : "Assistant", text },
  };
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

/**
 * Escape an ATX heading the message itself contains, so the only headings in
 * the export are the role separators. A line that reads `## User` would
 * otherwise be indistinguishable from a role boundary. Fenced code is left
 * untouched: there a leading `#` is literal text, not a heading.
 */
function escapeHeadings(text: string): string {
  let fence: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fenceMatch !== null) {
        const marker = fenceMatch[1]!;
        if (fence === undefined) {
          fence = marker;
        } else if (
          marker[0] === fence[0] &&
          marker.length >= fence.length &&
          fenceMatch[2]!.trim() === ""
        ) {
          fence = undefined;
        }
        return line;
      }
      if (fence !== undefined) return line;

      const headingMatch = /^( {0,3})#{1,6}(?=\s|$)/.exec(line);
      if (headingMatch === null) return line;
      const indent = headingMatch[1]!;
      return `${indent}\\${line.slice(indent.length)}`;
    })
    .join("\n");
}

/** The artifact: role headings and prose, one blank line between blocks. */
function renderConversation(turns: readonly SessionExportTurn[]): string {
  const blocks = turns.map(
    (turn) => `## ${turn.role}\n\n${escapeHeadings(turn.text)}`,
  );
  return `${blocks.join("\n\n")}\n`;
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
    subagent:
      payload.thread_source === "subagent" ||
      (isRecord(payload.source) && "subagent" in payload.source),
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

/** Whether a parsed JSON value is an object rather than a scalar or array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
