/**
 * claude/session-export.ts — reading one claude run's transcript for a
 * handover.
 *
 * The harness launches claude with `CLAUDE_CONFIG_DIR` naming a staging
 * directory that belongs to one spawn (`claudeConfigDir`), so a run's store is
 * `<configDir>/projects/<slugged-cwd>/`. claude writes one main conversation
 * per run there as `<session-id>.jsonl`, appending one JSON record per event;
 * subagent sidechains are separate `agent-*.jsonl` files beside it. The main
 * file's name is the id `--resume` takes, and every record repeats it as
 * `sessionId`.
 *
 * The export is a lookup, not a search: the config directory comes from the
 * spawn id, the project directory from the canonical cwd, and the only
 * UUID-named file is the session. A second UUID-named file means something
 * forked or cleared the conversation, and the export refuses rather than
 * choosing one.
 *
 * The artifact is prose only. claude's record set carries thinking, tool
 * calls, tool results, system prompts, attachments, command wrappers, and
 * transport errors; all of them are dropped here, because the next harness
 * reads the result as a conversation and nothing else. The prose that survives
 * has its own ATX headings escaped, so the only headings in the artifact are
 * the role separators.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { canonicalPath } from "../../../paths.js";
import {
  SessionExportError,
  type HarnessExport,
  type SessionExportTurn,
} from "../../harness.js";

/** What one export reads: the run's config directory and the tree it ran in. */
export interface ClaudeSessionExportRequest {
  readonly configDir: string;
  readonly cwd: string;
}

/** The session id claude names a file and resumes by. */
const SESSION_FILE_NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** The same shape, for an id read out of a record rather than a filename. */
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The line the extension owns; an export must never write one. */
const HANDOVER_MARKER = "<<pi-cowboy-handover";

/**
 * One content part. Only a `text` part carries conversation prose; every other
 * type (thinking, tool call, tool result, image) is structure the artifact
 * does not keep.
 */
const ClaudeContentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
});

/**
 * A conversation record's message: the content is either the whole message as
 * a string or an array of typed parts. A record that carries neither cannot be
 * read as a turn, and refusing it is how a half-read transcript is never
 * presented as success.
 */
const ClaudeMessageSchema = z.object({
  content: z.union([z.string(), z.array(z.unknown())]),
});

/** One record and the file line it came from, so a refusal names the line. */
interface ParsedRecord {
  readonly record: Record<string, unknown>;
  readonly line: number;
}

/**
 * The project directory claude derives from a cwd: the canonical path with
 * every non-alphanumeric character replaced by `-`. `/tmp` resolves to
 * `/private/tmp` on macOS before this runs, which is the spelling claude uses.
 */
export function claudeProjectDir(configDir: string, cwd: string): string {
  const resolved = canonicalPath(cwd) ?? cwd;
  const slug = resolved.replace(/[^A-Za-z0-9]/g, "-");
  return path.join(configDir, "projects", slug);
}

/**
 * Export one run's session for a handover: find the run's one session file,
 * then read it. Synchronous because the files are local and small; the hook
 * wraps it in a promise.
 */
export function exportClaudeSession(
  request: ClaudeSessionExportRequest,
): HarnessExport {
  const projectDir = claudeProjectDir(request.configDir, request.cwd);
  return readClaudeSession(sessionFileIn(projectDir, request.cwd));
}

/**
 * Read one session file: its id, which is the name `--resume` takes, and its
 * user/assistant prose as markdown.
 */
export function readClaudeSession(file: string): HarnessExport {
  const sessionIdFromName = path.basename(file).slice(0, -".jsonl".length);
  const records = readRecords(file);

  if (records.length === 0) {
    throw new SessionExportError(
      "empty-session",
      `claude session ${sessionIdFromName} under ${file} holds no records`,
    );
  }

  const sessionId = sessionIdOf(records, file, sessionIdFromName);
  const session = renderTranscript(records, file);

  if (session === "") {
    throw new SessionExportError(
      "empty-session",
      `claude session ${sessionId} under ${file} holds no user or assistant text`,
    );
  }
  return { sessionId, session };
}

/**
 * The one UUID-named file under the project directory. A missing directory and
 * an empty directory are both "this run wrote no session"; two files are a
 * fork or a clear, and choosing one would make the export a guess.
 */
function sessionFileIn(projectDir: string, cwd: string): string {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch (error) {
    throw new SessionExportError(
      "session-not-found",
      `no claude session record under ${projectDir} for ${cwd} (${errorMessage(error)}). The run wrote no session, or its staging directory is gone.`,
    );
  }

  const files = entries
    .filter((entry) => entry.isFile() && SESSION_FILE_NAME.test(entry.name))
    .map((entry) => entry.name);

  if (files.length === 0) {
    throw new SessionExportError(
      "session-not-found",
      `no claude session record under ${projectDir} for ${cwd}. The run wrote no session, or its staging directory is gone.`,
    );
  }
  if (files.length > 1) {
    throw new SessionExportError(
      "ambiguous-session",
      `claude wrote more than one session under ${projectDir} for ${cwd}: ${files.join(", ")}. Refusing to choose one; a /clear or a forked session leaves no single conversation to hand over.`,
    );
  }
  return path.join(projectDir, files[0] as string);
}

/**
 * Parse the JSONL file, tolerating only a partial final line. A line that
 * cannot parse anywhere else is a malformed record, not a turn to skip: a
 * half-read transcript presented as success would silently lose work.
 */
function readRecords(file: string): readonly ParsedRecord[] {
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
  const endsWithNewline = text.endsWith("\n");
  const tail = endsWithNewline ? -1 : lastNonEmptyLine(lines);
  const records: ParsedRecord[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) {
        throw new SessionExportError(
          "malformed-record",
          `malformed claude session record ${file}: line ${index + 1} is not a JSON object`,
        );
      }
      records.push({ record: parsed, line: index + 1 });
    } catch (error) {
      if (error instanceof SessionExportError) throw error;
      if (index === tail) continue;
      throw new SessionExportError(
        "malformed-record",
        `malformed claude session record ${file}: line ${index + 1} is not valid JSON (${errorMessage(error)})`,
      );
    }
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

/**
 * The id every record carries. The file name is what `--resume` looks up, so
 * a record naming a different session is a corrupt file, not an alternative
 * answer: returning either one would hand the next harness an id that may not
 * open this transcript.
 */
function sessionIdOf(
  records: readonly ParsedRecord[],
  file: string,
  sessionIdFromName: string,
): string {
  const named = records.find(
    ({ record }) =>
      typeof record.sessionId === "string" && record.sessionId !== "",
  );
  const namedId = named?.record.sessionId;
  if (typeof namedId !== "string") {
    throw new SessionExportError(
      "missing-session-id",
      `malformed claude session record ${file}: no record carries a sessionId`,
    );
  }
  if (!SESSION_ID.test(namedId)) {
    throw new SessionExportError(
      "malformed-record",
      `malformed claude session record ${file}: sessionId "${namedId}" is not a UUID`,
    );
  }
  if (namedId !== sessionIdFromName) {
    throw new SessionExportError(
      "malformed-record",
      `malformed claude session record ${file}: records name session "${namedId}" but the file is "${sessionIdFromName}.jsonl"`,
    );
  }
  return namedId;
}

/**
 * Render the conversation as the two-heading markdown the handover contract
 * specifies. The only transformations are the ones §1 allows: drop everything
 * that is not user or assistant prose, strip injected reminders and the
 * extension's marker, normalize edge whitespace, and escape headings the prose
 * itself contains.
 */
function renderTranscript(
  records: readonly ParsedRecord[],
  file: string,
): string {
  const turns: SessionExportTurn[] = [];

  for (const { record, line } of records) {
    const turn = turnOf(record, file, line);
    if (turn !== undefined) turns.push(turn);
  }

  if (turns.length === 0) return "";
  return `${turns.map((turn) => `## ${turn.role}\n\n${turn.text}`).join("\n\n")}\n`;
}

/** One record reduced to the turn it contributes, or nothing. */
function turnOf(
  record: Record<string, unknown>,
  file: string,
  line: number,
): SessionExportTurn | undefined {
  if (record.isSidechain === true) return undefined;

  if (record.type === "user") {
    if (record.isMeta === true) return undefined;
    if (record.isCompactSummary === true) return undefined;
    if (record.isVisibleInTranscriptOnly === true) return undefined;
    const text = escapeContentHeadings(
      cleanText(messageText(record.message, file, line)),
    );
    if (text === "" || isLocalCommand(text)) return undefined;
    return { role: "User", text };
  }

  if (record.type === "assistant") {
    if (record.isApiErrorMessage === true) return undefined;
    if (messageModel(record.message) === "<synthetic>") return undefined;
    const text = escapeContentHeadings(
      cleanText(messageText(record.message, file, line)),
    );
    if (text === "") return undefined;
    return { role: "Assistant", text };
  }

  return undefined;
}

/**
 * The text blocks of one message. Tool results, thinking, and tool calls are
 * not text and never reach the transcript; a message that holds only those
 * yields the empty string and contributes no heading.
 */
function messageText(message: unknown, file: string, line: number): string {
  const body = ClaudeMessageSchema.safeParse(message);
  if (!body.success) {
    throw new SessionExportError(
      "malformed-record",
      `malformed claude session record ${file}: line ${line} is a conversation record without a readable message`,
    );
  }

  const content = body.data.content;
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

/** The model a record names, when it names one. */
function messageModel(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  return typeof message.model === "string" ? message.model : undefined;
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
 * Escape an ATX heading the message itself contains, so the only headings in
 * the export are the role separators. A message line that reads `## User`
 * would otherwise be indistinguishable from a role boundary. Fenced code is
 * left untouched: there a leading `#` is literal text, not a heading.
 */
function escapeContentHeadings(text: string): string {
  let fence: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fenceMatch !== null) {
        const marker = fenceMatch[1] as string;
        if (fence === undefined) {
          fence = marker;
        } else if (
          marker[0] === fence[0] &&
          marker.length >= fence.length &&
          (fenceMatch[2] as string).trim() === ""
        ) {
          fence = undefined;
        }
        return line;
      }
      if (fence !== undefined) return line;

      const headingMatch = /^( {0,3})#{1,6}(?=\s|$)/.exec(line);
      if (headingMatch === null) return line;
      const indent = headingMatch[1] as string;
      return `${indent}\\${line.slice(indent.length)}`;
    })
    .join("\n");
}

/**
 * A user record that is a slash command or a local shell result rather than
 * something the human said. Older versions have no `isMeta` flag for these;
 * the wrapper is the record's own shape.
 */
function isLocalCommand(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/.test(
      trimmed,
    ) ||
    trimmed.startsWith(
      "Caveat: The messages below were generated by the user while running local commands",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
