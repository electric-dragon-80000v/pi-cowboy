/**
 * codex-export.test.ts — the codex handover reader against fixture rollouts:
 * the records it classifies, the traffic it ignores, the cwd lookup, and the
 * resume id read from the record.
 *
 * Rendering the artifact, escaping content headings, applying the exclusion
 * threshold, and reporting aggregate loss belong to the shared handover layer
 * and are pinned by its own tests; nothing here asserts them.
 *
 * The fixtures are small JSONL records in a temporary CODEX_HOME, never the
 * machine's own store and never the CLI.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { codexHarness } from "../src/agents/harness/codex.js";
import {
  codexHomeDirectory,
  exportCodexSession,
  findCodexSession,
  readCodexSession,
  type CodexSessionExport,
  type CodexSessionExportRequest,
} from "../src/agents/harness/codex-session.js";
import {
  canReadHandoverRecords,
  SessionExportError,
  type HandoverRecord,
  type SessionExportFault,
  type SessionExportTurn,
} from "../src/agents/harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** A temporary CODEX_HOME and the date directory a rollout lives in. */
function fixtureHome(): { home: string; dir: string } {
  const home = mkdtempSync(path.join(tmpdir(), "codex-export-"));
  roots.push(home);
  return { home, dir: path.join(home, "sessions", "2026", "10", "23") };
}

/** A rewrite-stable UUID-shaped id, so a fixture never names a real session. */
function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** The first record of every real rollout. */
function sessionMeta(
  cwd: string,
  threadId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    timestamp: "2026-10-23T08:00:00.000Z",
    ordinal: 0,
    type: "session_meta",
    payload: {
      session_id: threadId,
      id: threadId,
      timestamp: "2026-10-23T08:00:00.000Z",
      cwd,
      originator: "codex-tui",
      cli_version: "0.162.1",
      source: "cli",
      thread_source: "user",
      ...extra,
    },
  };
}

/** One `response_item` message with the given content parts. */
function message(
  role: "user" | "assistant",
  parts: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    timestamp: "2026-10-23T08:00:01.000Z",
    type: "response_item",
    payload: { type: "message", role, content: parts },
  };
}

function userMessage(text: string): Record<string, unknown> {
  return message("user", [{ type: "input_text", text }]);
}

function assistantMessage(text: string): Record<string, unknown> {
  return message("assistant", [{ type: "output_text", text }]);
}

/** One `response_item` record of a non-message type. */
function responseItem(
  type: string,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: "response_item", payload: { type, ...payload } };
}

/** One `event_msg` record. */
function eventMessage(
  type: string,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: "event_msg", payload: { type, ...payload } };
}

/**
 * One native `compacted` record, the summary codex wrote in `payload.message`.
 * `replacement_history` is carried by real records but is not the summary.
 */
function compactedRecord(message: string): Record<string, unknown> {
  return {
    timestamp: "2026-10-23T08:00:02.000Z",
    type: "compacted",
    payload: { message, replacement_history: [] },
  };
}

/** Write a rollout and return its path. */
function writeRollout(
  directory: string,
  options: {
    readonly records?: readonly Record<string, unknown>[];
    readonly raw?: string;
    readonly filename?: string;
    readonly threadId?: string;
    readonly mtimeMs?: number;
  } = {},
): string {
  mkdirSync(directory, { recursive: true });
  const file = path.join(
    directory,
    options.filename ??
      `rollout-2026-10-23T08-00-00-${options.threadId ?? id(1)}.jsonl`,
  );
  const raw =
    options.raw ??
    `${(options.records ?? []).map((record) => JSON.stringify(record)).join("\n")}\n`;
  writeFileSync(file, raw);
  if (options.mtimeMs !== undefined) {
    const time = new Date(options.mtimeMs);
    utimesSync(file, time, time);
  }
  return file;
}

/** The native line a fixture record is written as. */
function lineOf(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

/** The turns a read produced, in order. */
function turns(
  records: Iterable<HandoverRecord>,
): readonly SessionExportTurn[] {
  return [...records].flatMap((record) =>
    record.kind === "export" ? [record.turn] : [],
  );
}

/** The kinds a read produced, in order. */
function kinds(records: Iterable<HandoverRecord>): readonly string[] {
  return [...records].map((record) => record.kind);
}

/** Every native line the reader could not parse. */
function keptLines(records: Iterable<HandoverRecord>): readonly string[] {
  return [...records].flatMap((record) =>
    record.kind === "unparseable" ? [record.content] : [],
  );
}

/** One conversation fixture, read straight from a path. */
function readFixture(
  records: readonly Record<string, unknown>[],
): readonly HandoverRecord[] {
  const { dir } = fixtureHome();
  const file = writeRollout(dir, { records });
  return [...readCodexSession(file)];
}

/** The fault a refused read carries; a test that expects a refusal uses it. */
function faultOf(run: () => unknown): SessionExportFault {
  try {
    run();
  } catch (error) {
    if (error instanceof SessionExportError) return error.fault;
    throw error;
  }
  throw new Error("expected the read to refuse, but it returned");
}

/** Transferable turns never contain native traffic. */
function leaks(records: Iterable<HandoverRecord>, markers: readonly string[]) {
  const text = JSON.stringify(turns(records));
  return markers.filter((marker) => text.includes(marker));
}

describe("readCodexSession", () => {
  it("classifies user and assistant messages as turns, in order", () => {
    const records = readFixture([
      sessionMeta("/worktree", id(1)),
      userMessage("first"),
      assistantMessage("second"),
      userMessage("third"),
    ]);

    expect(turns(records)).toEqual([
      { role: "User", text: "first" },
      { role: "Assistant", text: "second" },
      { role: "User", text: "third" },
    ]);
    expect(kinds(records)).toEqual([
      "dont-export",
      "export",
      "export",
      "export",
    ]);
  });

  it("keeps assistant prose that starts with a plan envelope", () => {
    const records = readFixture([
      sessionMeta("/worktree", id(1)),
      assistantMessage("<proposed_plan>\nThe plan.\n</proposed_plan>"),
    ]);

    expect(turns(records)).toEqual([
      {
        role: "Assistant",
        text: "<proposed_plan>\nThe plan.\n</proposed_plan>",
      },
    ]);
  });

  it("counts thinking, tool traffic, developer content, and inter-agent messages as omitted", () => {
    const records = readFixture([
      sessionMeta("/worktree", id(1)),
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "DEVELOPER_SECRET" }],
        },
      },
      responseItem("reasoning", { summary: "REASONING_SECRET" }),
      responseItem("function_call", { name: "TOOL_CALL_SECRET" }),
      responseItem("function_call_output", {
        output: "TOOL_RESULT_SECRET",
      }),
      responseItem("custom_tool_call", { name: "CUSTOM_CALL_SECRET" }),
      responseItem("custom_tool_call_output", {
        output: "CUSTOM_RESULT_SECRET",
      }),
      responseItem("agent_message", { message: "AGENT_TRAFFIC_SECRET" }),
      eventMessage("token_count", { total: 1 }),
      eventMessage("context_compacted", {}),
      userMessage("the real question"),
      assistantMessage("the real answer"),
    ]);

    expect(kinds(records)).toEqual([
      "dont-export",
      "dont-export",
      "dont-export",
      "dont-export",
      "dont-export",
      "dont-export",
      "dont-export",
      "dont-export",
      "dont-export",
      "dont-export",
      "export",
      "export",
    ]);
    expect(turns(records)).toEqual([
      { role: "User", text: "the real question" },
      { role: "Assistant", text: "the real answer" },
    ]);
    expect(
      leaks(records, [
        "DEVELOPER_SECRET",
        "REASONING_SECRET",
        "TOOL_CALL_SECRET",
        "TOOL_RESULT_SECRET",
        "CUSTOM_CALL_SECRET",
        "CUSTOM_RESULT_SECRET",
        "AGENT_TRAFFIC_SECRET",
      ]),
    ).toEqual([]);
  });

  it("drops injected user envelopes but keeps the rest of the message", () => {
    const records = readFixture([
      sessionMeta("/worktree", id(1)),
      message("user", [
        { type: "input_text", text: "<environment_context>\nENV_SECRET" },
        { type: "input_text", text: "keep this" },
        {
          type: "input_image",
          image_url: "data:image/png;base64,IMAGE_SECRET",
        },
        { type: "input_text", text: "<turn_aborted>\nABORT_SECRET" },
        {
          type: "input_text",
          text: "# AGENTS.md instructions for /x\nAGENTS_SECRET",
        },
        { type: "input_text", text: "<user_action>\nACTION_SECRET" },
        { type: "input_text", text: "<recommended_plugins>\nPLUGINS_SECRET" },
        { type: "input_text", text: "<skill>\nSKILL_SECRET" },
        { type: "input_text", text: "<user_shell_command>\nSHELL_SECRET" },
        {
          type: "input_text",
          text: "<codex_internal_context>\nINTERNAL_SECRET",
        },
      ]),
    ]);

    expect(turns(records)).toEqual([{ role: "User", text: "keep this" }]);
    expect(
      leaks(records, [
        "ENV_SECRET",
        "IMAGE_SECRET",
        "ABORT_SECRET",
        "AGENTS_SECRET",
        "ACTION_SECRET",
        "PLUGINS_SECRET",
        "SKILL_SECRET",
        "SHELL_SECRET",
        "INTERNAL_SECRET",
      ]),
    ).toEqual([]);
  });

  it("strips image markers and reports an image-only message as deliberately not exported", () => {
    const onlyAnImage = message("user", [
      { type: "input_text", text: "<image name=[Image #2]>" },
      {
        type: "input_image",
        image_url: "data:image/png;base64,IMAGE_SECRET",
      },
      { type: "input_text", text: "</image>" },
    ]);
    const records = readFixture([
      sessionMeta("/worktree", id(1)),
      message("user", [
        {
          type: "input_text",
          text: '<image name=[Image #1] path="/tmp/image.png">',
        },
        {
          type: "input_image",
          image_url: "data:image/png;base64,IMAGE_SECRET",
        },
        { type: "input_text", text: "</image>" },
        { type: "input_text", text: "look at this" },
      ]),
      assistantMessage("I looked."),
      onlyAnImage,
    ]);

    expect(turns(records)).toEqual([
      { role: "User", text: "look at this" },
      { role: "Assistant", text: "I looked." },
    ]);
    // The message is still a record of the conversation, so it is reported
    // rather than dropped; it simply carries no turn.
    expect(records[3]).toEqual({
      kind: "dont-export",
      content: lineOf(onlyAnImage),
    });
    // The omission keeps the native line for diagnostics, so the marker only
    // has to be absent from what the next run would be given.
    expect(JSON.stringify(turns(records))).not.toContain("IMAGE_SECRET");
  });

  it("reports an empty or whitespace-only message as deliberately not exported", () => {
    const empty = userMessage("   ");
    const whitespace = assistantMessage("\n\t\n");
    const records = readFixture([
      sessionMeta("/worktree", id(1)),
      empty,
      whitespace,
      userMessage("real"),
    ]);

    expect([...records]).toEqual([
      {
        kind: "dont-export",
        content: lineOf(sessionMeta("/worktree", id(1))),
      },
      { kind: "dont-export", content: lineOf(empty) },
      { kind: "dont-export", content: lineOf(whitespace) },
      { kind: "export", turn: { role: "User", text: "real" } },
    ]);
  });

  it("leaves no trailing whitespace on a turn's prose", () => {
    const records = readFixture([
      sessionMeta("/worktree", id(1)),
      userMessage("line one   \nline two\t"),
    ]);

    expect(turns(records)).toEqual([
      { role: "User", text: "line one\nline two" },
    ]);
    expect(turns(records)[0]!.text).not.toMatch(/[ \t]+$/m);
  });

  it("classifies a native compaction summary as the shared compaction record, in order", () => {
    const compaction = compactedRecord("what happened before the compaction");
    const records = readFixture([
      sessionMeta("/worktree", id(1)),
      userMessage("before"),
      compaction,
      assistantMessage("after"),
    ]);

    expect(kinds(records)).toEqual([
      "dont-export",
      "export",
      "compaction",
      "export",
    ]);
    expect(records[2]).toEqual({
      kind: "compaction",
      summary: "what happened before the compaction",
    });
    expect(turns(records)).toEqual([
      { role: "User", text: "before" },
      { role: "Assistant", text: "after" },
    ]);
  });

  it("does not mistake the context_compacted notification for the compaction summary", () => {
    const notification = eventMessage("context_compacted", {});
    const records = readFixture([
      sessionMeta("/worktree", id(1)),
      notification,
      compactedRecord("the summary"),
    ]);

    expect(records[1]).toEqual({
      kind: "dont-export",
      content: lineOf(notification),
    });
    expect(records[2]).toEqual({ kind: "compaction", summary: "the summary" });
  });

  it("keeps a compaction with no plaintext summary as a readable omission", () => {
    // Model-backed compaction stores its summary encrypted, leaving `message`
    // empty; the record is still native history, but carries nothing to hand
    // over and must not discard the transcript before it.
    const encrypted = compactedRecord("");
    const records = readFixture([
      sessionMeta("/worktree", id(1)),
      userMessage("before"),
      encrypted,
      assistantMessage("after"),
    ]);

    expect(records[2]).toEqual({
      kind: "dont-export",
      content: lineOf(encrypted),
    });
    expect(turns(records)).toEqual([
      { role: "User", text: "before" },
      { role: "Assistant", text: "after" },
    ]);
  });

  it("reports a compaction whose summary is not a string as unparseable", () => {
    const malformed = {
      type: "compacted",
      payload: { message: { text: "not a string" } },
    };
    const records = readFixture([sessionMeta("/worktree", id(1)), malformed]);

    expect(records[1]).toEqual({
      kind: "unparseable",
      content: lineOf(malformed),
    });
  });

  it("reports a line it cannot parse alongside the records around it", () => {
    const broken = '{"not": "a complete record"';
    const { dir } = fixtureHome();
    const file = writeRollout(dir, {
      raw: [
        JSON.stringify(sessionMeta("/worktree", id(1))),
        JSON.stringify(userMessage("hello")),
        broken,
        JSON.stringify(assistantMessage("hi")),
      ].join("\n"),
    });

    const records = [...readCodexSession(file)];

    expect(kinds(records)).toEqual([
      "dont-export",
      "export",
      "unparseable",
      "export",
    ]);
    expect(turns(records)).toEqual([
      { role: "User", text: "hello" },
      { role: "Assistant", text: "hi" },
    ]);
    expect(keptLines(records)).toEqual([broken]);
  });

  it("reports a message whose content is not an array of parts as unparseable", () => {
    const odd = {
      type: "response_item",
      payload: { type: "message", role: "user", content: "hello" },
    };
    const records = readFixture([sessionMeta("/worktree", id(1)), odd]);

    expect([...records]).toEqual([
      {
        kind: "dont-export",
        content: lineOf(sessionMeta("/worktree", id(1))),
      },
      { kind: "unparseable", content: lineOf(odd) },
    ]);
    expect(turns(records)).toEqual([]);
  });

  it("tolerates a partial trailing record without reporting it", () => {
    const { dir } = fixtureHome();
    const complete = [
      sessionMeta("/worktree", id(1)),
      userMessage("hello"),
      assistantMessage("hi"),
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const file = writeRollout(dir, {
      raw: `${complete}\n{"timestamp":"2026-10-23T08:00:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"unfinished`,
    });

    const records = [...readCodexSession(file)];

    // The interrupted write is not a record yet: it is neither read nor
    // reported, and the turn before it is not duplicated.
    expect(kinds(records)).toEqual(["dont-export", "export", "export"]);
    expect(turns(records)).toEqual([
      { role: "User", text: "hello" },
      { role: "Assistant", text: "hi" },
    ]);
    expect(leaks(records, ["unfinished"])).toEqual([]);
  });

  it("reports metadata as omitted when a rollout holds no conversation", () => {
    const meta = sessionMeta("/worktree", id(1));
    const records = readFixture([meta]);

    expect([...records]).toEqual([
      { kind: "dont-export", content: lineOf(meta) },
    ]);
  });

  it("leaves the pre-0.162 event_msg turn form unread", () => {
    const records = readFixture([
      sessionMeta("/worktree", id(1)),
      eventMessage("user_message", { message: "older question" }),
      eventMessage("agent_message", { message: "older answer" }),
      userMessage("hello"),
      assistantMessage("hi"),
    ]);

    // Only the `response_item` form is transferable prose; older event forms
    // remain readable native entries and therefore count as omissions.
    expect([...records]).toEqual([
      {
        kind: "dont-export",
        content: lineOf(sessionMeta("/worktree", id(1))),
      },
      {
        kind: "dont-export",
        content: lineOf(
          eventMessage("user_message", { message: "older question" }),
        ),
      },
      {
        kind: "dont-export",
        content: lineOf(
          eventMessage("agent_message", { message: "older answer" }),
        ),
      },
      { kind: "export", turn: { role: "User", text: "hello" } },
      { kind: "export", turn: { role: "Assistant", text: "hi" } },
    ]);
  });

  it("refuses a record it cannot read", () => {
    const { home } = fixtureHome();
    expect(faultOf(() => readCodexSession(home))).toBe("unreadable-record");
  });
});

describe("findCodexSession", () => {
  it("returns the newest cwd match and its record id", () => {
    const { home, dir } = fixtureHome();
    const cwd = "/worktree";
    const request: CodexSessionExportRequest = { cwd, codexHome: home };
    writeRollout(dir, {
      records: [sessionMeta(cwd, id(1)), userMessage("old")],
      threadId: id(1),
      mtimeMs: 1_000,
    });
    writeRollout(dir, {
      records: [sessionMeta(cwd, id(2)), userMessage("new")],
      threadId: id(2),
      mtimeMs: 2_000,
    });
    writeRollout(dir, {
      records: [sessionMeta(cwd, id(3), { thread_source: "subagent" })],
      threadId: id(3),
      mtimeMs: 3_000,
    });
    writeRollout(dir, {
      records: [sessionMeta("/elsewhere", id(4))],
      threadId: id(4),
      mtimeMs: 4_000,
    });

    expect(findCodexSession(request)).toEqual({
      file: path.join(dir, `rollout-2026-10-23T08-00-00-${id(2)}.jsonl`),
      sessionId: id(2),
    });
    expect(turns(exportCodexSession(request).records)).toEqual([
      { role: "User", text: "new" },
    ]);
  });

  it("reads the id from the record, not the filename", () => {
    const { home, dir } = fixtureHome();
    const cwd = "/worktree";
    const threadId = id(2);
    writeRollout(dir, {
      records: [sessionMeta(cwd, threadId), userMessage("hello")],
      filename: `rollout-2026-10-23T08-00-00-${id(1)}.jsonl`,
    });

    expect(findCodexSession({ cwd, codexHome: home }).sessionId).toBe(threadId);
  });

  it("returns the thread id of a reverted filename, not its rollout suffix", () => {
    const { home, dir } = fixtureHome();
    const cwd = "/worktree";
    const threadId = id(2);
    writeRollout(dir, {
      records: [
        sessionMeta(cwd, threadId, { session_id: id(9) }),
        userMessage("hello"),
      ],
      filename: `rollout-2026-10-23T08-00-00-${threadId}_${id(1)}.jsonl`,
    });

    const found = findCodexSession({ cwd, codexHome: home });
    expect(found.sessionId).toBe(threadId);
    expect(found.sessionId).not.toBe(id(1));
    expect(found.sessionId).not.toBe(id(9));
  });

  it("matches a cwd through a symlink", () => {
    const { home, dir } = fixtureHome();
    const real = path.join(home, "real-worktree");
    const link = path.join(home, "linked-worktree");
    mkdirSync(real);
    symlinkSync(real, link);
    writeRollout(dir, {
      records: [sessionMeta(real, id(1)), userMessage("hello")],
    });

    expect(findCodexSession({ cwd: link, codexHome: home }).sessionId).toBe(
      id(1),
    );
  });

  it("throws when the session store does not exist", () => {
    const { home } = fixtureHome();
    expect(() =>
      exportCodexSession({ cwd: "/worktree", codexHome: home }),
    ).toThrow(`no codex session store at ${path.join(home, "sessions")}`);
    expect(
      faultOf(() => exportCodexSession({ cwd: "/worktree", codexHome: home })),
    ).toBe("session-not-found");
  });

  it("throws when no record names the cwd", () => {
    const { home, dir } = fixtureHome();
    writeRollout(dir, {
      records: [sessionMeta("/somewhere-else", id(1)), userMessage("hello")],
    });

    expect(() =>
      exportCodexSession({ cwd: "/worktree", codexHome: home }),
    ).toThrow(
      `no codex session record under ${path.join(home, "sessions")} for /worktree`,
    );
    expect(
      faultOf(() => exportCodexSession({ cwd: "/worktree", codexHome: home })),
    ).toBe("session-not-found");
  });

  it("refuses when only a subagent rollout names the cwd", () => {
    const { home, dir } = fixtureHome();
    writeRollout(dir, {
      records: [sessionMeta("/worktree", id(1), { thread_source: "subagent" })],
    });

    expect(() =>
      findCodexSession({ cwd: "/worktree", codexHome: home }),
    ).toThrow(SessionExportError);
    expect(
      faultOf(() => findCodexSession({ cwd: "/worktree", codexHome: home })),
    ).toBe("session-not-found");
  });

  it("is wired into the harness and uses CODEX_HOME", async () => {
    const { home, dir } = fixtureHome();
    writeRollout(dir, {
      records: [sessionMeta("/worktree", id(7)), userMessage("hello")],
      threadId: id(7),
    });
    vi.stubEnv("CODEX_HOME", home);
    expect(canReadHandoverRecords(codexHarness)).toBe(true);

    const read = await codexHarness.readHandoverRecords!({
      pi: {} as ExtensionAPI,
      subagentId: "c0d3e4f5",
      paneId: "pane-1",
      cwd: "/worktree",
    });

    expect(read.sessionId).toBe(id(7));
    expect([...read.records]).toEqual([
      {
        kind: "dont-export",
        content: lineOf(sessionMeta("/worktree", id(7))),
      },
      { kind: "export", turn: { role: "User", text: "hello" } },
    ]);
  });
});

describe("the home the launch and the export share", () => {
  it("resolves a configured home absolutely, for the child and for this reader alike", () => {
    vi.stubEnv("CODEX_HOME", "relative-home");

    expect(codexHomeDirectory()).toBe(path.resolve("relative-home"));
    expect(codexHarness.inheritedEnv?.()).toEqual({
      CODEX_HOME: path.resolve("relative-home"),
    });
  });

  it("hands codex's own home when the variable names none", () => {
    vi.stubEnv("CODEX_HOME", "");

    expect(codexHarness.inheritedEnv?.()).toEqual({
      CODEX_HOME: path.join(homedir(), ".codex"),
    });
  });
});

describe("the record source the harness returns", () => {
  it("names the record type in the public result", () => {
    const { home, dir } = fixtureHome();
    const cwd = "/worktree";
    writeRollout(dir, {
      records: [sessionMeta(cwd, id(1)), userMessage("hello")],
    });

    const exported: CodexSessionExport = exportCodexSession({
      cwd,
      codexHome: home,
    });
    expect(exported.sessionId).toBe(id(1));
    expect(exported.file.endsWith(".jsonl")).toBe(true);
    expect(turns(exported.records)).toEqual([{ role: "User", text: "hello" }]);
  });
});
