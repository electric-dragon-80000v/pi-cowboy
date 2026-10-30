/**
 * pi-session.ts — the pi family's session format, and the store contract every
 * binary in that family satisfies.
 *
 * The family (pi, pig, pi-bolt) writes pi's format: one append-only JSONL file
 * per session under a store's sessions directory, a `session` header carrying
 * the id, then one record per entry with `message` records holding the
 * conversation. The launcher passes the spawn id as `--name`, the binary
 * records it as a `session_info` entry before the first message, and its latest
 * value is the lookup key: the export finds the file the run itself named and
 * returns the header id, which is the value `--session` resumes.
 *
 * The format is one implementation; only the store differs (see pi-store.ts and
 * pig-store.ts), so a new binary in the family adds a store and no reader.
 *
 * Every complete record becomes transferable prose, a deliberate omission, or
 * an unparseable record. Thinking, tool calls, tool results, system content,
 * images, compaction, and extension entries are readable omissions; shared
 * handover code alone renders the transcript and applies loss policy.
 */

import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { canonicalPath } from "../../paths.js";
import { isRecord, nonEmpty } from "../../predicates.js";
import { errorMessage } from "../../utils.js";
import {
  SessionExportError,
  type HandoverRecord,
  type HandoverRecordSource,
  type ReadHandoverRecords,
} from "../harness.js";

/**
 * The one session format this reader reads: the version every binary in the
 * family writes today. An older header describes a layout this reader does not
 * migrate, and a newer one may describe a layout it cannot know, so both are
 * refused rather than read through the current rules.
 */
const SESSION_VERSION = 3;

/** The name of the settings key that moves a store's session directory. */
const SESSION_DIR_SETTING = "sessionDir";

/** The environment a store resolves its directories from; `process.env` for a launch. */
export type SessionStoreEnv = Readonly<Record<string, string | undefined>>;

/**
 * Where one pi-family binary keeps its sessions: the whole of what differs
 * between the binaries, since they share the format above. Each member resolves
 * from a passed environment rather than `process.env`, so a store's rules can be
 * asserted without touching the real one.
 *
 * A store's two halves must agree, or a handover reads a directory nothing
 * wrote: the values a launch hands the child (`inheritedEnv`) have to land it in
 * the directory this store resolves for the export (`sessionDir`). A name the
 * store resolves against this process — from this process's home, or against its
 * cwd — is handed over expanded and absolute, so the child's own cwd cannot
 * reinterpret it; a name it resolves against the run's cwd travels as written,
 * because the child's cwd is that cwd.
 */
export interface SessionStore {
  /**
   * Env names this store's launch owns besides its family's reserved table, so
   * a configured entry for one cannot move the child off the store its export
   * reads. Empty when the family table already refuses every name it reads.
   */
  readonly reservedNames: readonly string[];
  /**
   * This cwd's session directory, resolved the way the binary's own process
   * resolves it — the directory the run wrote its session into.
   */
  sessionDir(cwd: string, env: SessionStoreEnv): Promise<string>;
  /**
   * The store variables this process carries, for a child of this store to
   * inherit — each value already in the form this store's `sessionDir` resolves,
   * so the child writes where that resolution looks.
   */
  inheritedEnv(env: SessionStoreEnv): Record<string, string>;
}

/**
 * One content part. Only a `text` part carries conversation prose; every other
 * type (thinking, tool call, image) is structure the artifact does not keep.
 */
const ContentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
});

/**
 * The content of a message: its typed parts. The role is checked separately,
 * because a message that is not user or assistant contributes nothing whatever
 * its content holds.
 */
const MessageContentSchema = z.array(z.unknown());

interface SessionHeader {
  readonly id: string;
}

/**
 * The directory name a store keys this cwd by: the physical absolute path with
 * its leading separator removed and every path separator or colon replaced.
 * Physical, because a binary keys the bucket by the directory the kernel
 * reports: a cwd reached through a symlink buckets under its target — `/tmp/x`
 * on macOS is `/private/tmp/x`. A path that does not exist has no physical
 * form, and then its own spelling is all there is to key by.
 */
export function sessionBucketName(cwd: string): string {
  const resolved = canonicalPath(cwd) ?? path.resolve(cwd);
  const encoded = resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return `--${encoded}--`;
}

/**
 * The session directory a store's own `sessionDir` setting names, or nothing
 * when no settings file declares one. A missing, unreadable or unparsable file
 * is no setting, because the binary falls back to its defaults for one it
 * cannot read.
 */
export async function readSessionDirSetting(
  configDir: string,
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(configDir, "settings.json"), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  return nonEmpty(parsed[SESSION_DIR_SETTING]);
}

/** The session file the run named after itself, or a refusal naming what was looked for. */
export async function findSessionFile(
  sessionDir: string,
  subagentId: string,
  cwd: string,
): Promise<string> {
  let entries;
  try {
    entries = await readdir(sessionDir, { withFileTypes: true });
  } catch {
    throw new SessionExportError(
      "session-not-found",
      `no session record under ${sessionDir} for ${cwd} (subagent ${subagentId})`,
    );
  }

  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filePath = path.join(sessionDir, entry.name);
    if ((await readLatestSessionName(filePath)) === subagentId) {
      matches.push(filePath);
    }
  }

  if (matches.length === 0) {
    throw new SessionExportError(
      "session-not-found",
      `no session record under ${sessionDir} for ${cwd} (subagent ${subagentId})`,
    );
  }
  if (matches.length > 1) {
    throw new SessionExportError(
      "ambiguous-session",
      `more than one session record under ${sessionDir} names subagent ${subagentId}: ${matches.join(", ")}`,
    );
  }
  return matches[0]!;
}

/**
 * The name the binary would show for a session file: its latest `session_info`
 * record, trimmed, with an empty name clearing an earlier one. Unknown and
 * malformed lines are skipped the way the binary's own session listing skips
 * them.
 */
async function readLatestSessionName(
  filePath: string,
): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }

  let latest: string | undefined;
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== "session_info") continue;
    latest = nonEmpty(parsed.name);
  }
  return latest;
}

/**
 * Read one session file into countable native records, yielding each one as
 * the shared export consumes it. The file, its header, and its format version
 * are validated before the source is returned; every complete entry after the
 * header becomes transferable prose, a deliberate omission, or an unreadable
 * record.
 */
export async function readSessionFile(
  filePath: string,
): Promise<HandoverRecordSource> {
  const content = await readSessionFileContent(filePath);
  const partialTail = !content.endsWith("\n");
  const lines = content.split("\n");
  // A complete file ends at the empty element after its final newline; an
  // unterminated final element is the record the binary is still appending.
  if (!partialTail) lines.pop();

  const header = findSessionHeader(lines, partialTail, filePath);
  return {
    sessionId: header.header.id,
    records: sessionRecords(lines, header.index, partialTail),
  };
}

/**
 * The session header record, found and validated before any record is yielded.
 * A malformed line before it is fatal, and a partial trailing line is the write
 * the binary has not finished rather than a record.
 */
function findSessionHeader(
  lines: readonly string[],
  partialTail: boolean,
  filePath: string,
): { readonly index: number; readonly header: SessionHeader } {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (partialTail && index === lines.length - 1) break;
      throw new SessionExportError(
        "malformed-record",
        `malformed session record in ${filePath} at line ${index + 1}`,
      );
    }
    if (!isRecord(parsed)) {
      throw new SessionExportError(
        "malformed-record",
        `malformed session record in ${filePath} at line ${index + 1}`,
      );
    }

    return { index, header: readHeader(parsed, filePath) };
  }

  throw new SessionExportError(
    "malformed-record",
    `session record ${filePath} has no session header`,
  );
}

/** Every complete entry, in file order, starting with the header's omission. */
function* sessionRecords(
  lines: readonly string[],
  headerIndex: number,
  partialTail: boolean,
): Iterable<HandoverRecord> {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === "") continue;

    if (index === headerIndex) {
      yield { kind: "dont-export", content: line };
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (partialTail && index === lines.length - 1) break;
      yield { kind: "unparseable", content: line };
      continue;
    }
    if (!isRecord(parsed)) {
      yield { kind: "unparseable", content: line };
      continue;
    }

    yield readTurn(parsed, line);
  }
}

async function readSessionFileContent(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    throw new SessionExportError(
      "unreadable-record",
      `cannot read session record ${filePath}: ${errorMessage(error)}`,
    );
  }
}

/**
 * The id in the session header, which must declare the one format version this
 * reader reads.
 */
function readHeader(
  record: Record<string, unknown>,
  filePath: string,
): SessionHeader {
  if (record.type !== "session") {
    throw new SessionExportError(
      "malformed-record",
      `session record ${filePath} does not start with a session header`,
    );
  }

  const version = record.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new SessionExportError(
      "malformed-record",
      `session record ${filePath} has no numeric version`,
    );
  }
  if (version !== SESSION_VERSION) {
    throw new SessionExportError(
      "unsupported-version",
      `session record ${filePath} uses version ${version}; this export reads version ${SESSION_VERSION}`,
    );
  }

  const id = nonEmpty(record.id);
  if (id === undefined) {
    throw new SessionExportError(
      "missing-session-id",
      `session record ${filePath} names no session id`,
    );
  }

  return { id };
}

/** One complete native record in the shared vocabulary. */
function readTurn(
  record: Record<string, unknown>,
  content: string,
): HandoverRecord {
  if (record.type !== "message") {
    return { kind: "dont-export", content };
  }
  if (!isRecord(record.message)) {
    return { kind: "unparseable", content };
  }

  const role = record.message.role;
  if (role !== "user" && role !== "assistant") {
    return { kind: "dont-export", content };
  }

  const parts = MessageContentSchema.safeParse(record.message.content);
  if (!parts.success) return { kind: "unparseable", content };

  const text = messageText(parts.data);
  return text === ""
    ? { kind: "dont-export", content }
    : {
        kind: "export",
        turn: { role: role === "user" ? "User" : "Assistant", text },
      };
}

/**
 * The text parts of one message as prose. A part that is not a `text` part, or
 * a `text` part with no string to read, contributes nothing; multiple text
 * parts are joined with a blank line.
 */
function messageText(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const candidate of content) {
    const part = ContentPartSchema.safeParse(candidate);
    if (!part.success) continue;
    if (part.data.type !== "text" || part.data.text === undefined) continue;
    const text = normalizeText(part.data.text);
    if (text !== "") parts.push(text);
  }
  if (parts.length === 0) return "";

  return parts.join("\n\n");
}

/** Consistent newlines, no trailing whitespace, no blank margin. */
function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/**
 * One store's handover record read: resolve the directory the run wrote into,
 * find the file it named after itself, and classify it. The run's own cwd is
 * the address both the directory and the lookup are keyed by.
 */
export function readHandoverRecordsOf(
  store: SessionStore,
): ReadHandoverRecords {
  return async ({ subagentId, cwd }) => {
    const sessionDir = await store.sessionDir(cwd, process.env);
    const file = await findSessionFile(sessionDir, subagentId, cwd);
    return readSessionFile(file);
  };
}
