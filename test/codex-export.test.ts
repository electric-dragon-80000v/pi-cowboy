/**
 * codex-export.test.ts — the codex handover export against fixture rollouts:
 * the two-heading artifact, the filtering, the cwd lookup, the resume id read
 * from the record, and every typed refusal.
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
  type CodexSessionExportRequest,
  type CodexSessionRecord,
} from "../src/agents/harness/codex-session.js";
import {
  canExportForHandover,
  SessionExportError,
  type SessionExportFault,
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

/**
 * The listed markers that survive in an export. Asserting on the whole list
 * names the leak in the failure instead of one marker per assertion.
 */
function leaks(session: string, markers: readonly string[]): readonly string[] {
  return markers.filter((marker) => session.includes(marker));
}

/** One conversation fixture, read straight from a path. */
function readFixture(records: readonly Record<string, unknown>[]): string {
  const { dir } = fixtureHome();
  const file = writeRollout(dir, { records });
  return readCodexSession(file).session;
}

/** The fault a refused export carries; a test that expects a refusal uses it. */
function faultOf(run: () => unknown): SessionExportFault {
  try {
    run();
  } catch (error) {
    if (error instanceof SessionExportError) return error.fault;
    throw error;
  }
  throw new Error("expected the export to refuse, but it returned");
}

describe("readCodexSession", () => {
  it("renders user and assistant turns in order, in the exact block shape", () => {
    const session = readFixture([
      sessionMeta("/worktree", id(1)),
      userMessage("first"),
      assistantMessage("second"),
      userMessage("third"),
    ]);

    expect(session).toBe(
      "## User\n\nfirst\n\n## Assistant\n\nsecond\n\n## User\n\nthird\n",
    );
    expect(session.endsWith("\n\n")).toBe(false);
  });

  it("keeps assistant prose that starts with a plan envelope", () => {
    const session = readFixture([
      sessionMeta("/worktree", id(1)),
      assistantMessage("<proposed_plan>\nThe plan.\n</proposed_plan>"),
    ]);

    expect(session).toBe(
      "## Assistant\n\n<proposed_plan>\nThe plan.\n</proposed_plan>\n",
    );
  });

  it("drops thinking, tool calls, tool results, and developer instructions", () => {
    const session = readFixture([
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
      userMessage("the real question"),
      assistantMessage("the real answer"),
    ]);

    expect(session).toBe(
      "## User\n\nthe real question\n\n## Assistant\n\nthe real answer\n",
    );
    expect(
      leaks(session, [
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
    const session = readFixture([
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

    expect(session).toBe("## User\n\nkeep this\n");
    expect(
      leaks(session, [
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

  it("strips image markers and drops a turn that was only an image", () => {
    const session = readFixture([
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
      message("user", [
        { type: "input_text", text: "<image name=[Image #2]>" },
        {
          type: "input_image",
          image_url: "data:image/png;base64,IMAGE_SECRET",
        },
        { type: "input_text", text: "</image>" },
      ]),
    ]);

    expect(session).toBe(
      "## User\n\nlook at this\n\n## Assistant\n\nI looked.\n",
    );
    expect(session).not.toContain("IMAGE_SECRET");
    expect(session.match(/^## User$/gm)).toHaveLength(1);
  });

  it("does not emit a heading for empty or whitespace-only text", () => {
    const session = readFixture([
      sessionMeta("/worktree", id(1)),
      userMessage("   "),
      assistantMessage("\n\t\n"),
      userMessage("real"),
    ]);

    expect(session).toBe("## User\n\nreal\n");
  });

  it("leaves no trailing whitespace and one trailing newline", () => {
    const session = readFixture([
      sessionMeta("/worktree", id(1)),
      userMessage("line one   \nline two\t"),
    ]);

    expect(session).toBe("## User\n\nline one\nline two\n");
    expect(session).not.toMatch(/[ \t]+$/m);
  });

  it("escapes ATX headings the message itself contains", () => {
    const session = readFixture([
      sessionMeta("/worktree", id(1)),
      userMessage(
        "## User\nnot a role boundary\n# Title\n#### Deep\n  ## Indented\n#hashtag",
      ),
      assistantMessage("```md\n## User\n```\n## Assistant\nreal text"),
    ]);

    expect(session).toBe(
      [
        "## User",
        "",
        "\\## User",
        "not a role boundary",
        "\\# Title",
        "\\#### Deep",
        "  \\## Indented",
        "#hashtag",
        "",
        "## Assistant",
        "",
        "```md",
        "## User",
        "```",
        "\\## Assistant",
        "real text",
        "",
      ].join("\n"),
    );
    expect(session.match(/^\\## (User|Assistant)$/gm)).toHaveLength(2);
  });

  it("leaves headings inside an open fence untouched", () => {
    const session = readFixture([
      sessionMeta("/worktree", id(1)),
      assistantMessage("~~~\n## User\n# Title\n"),
    ]);

    expect(session).toBe("## Assistant\n\n~~~\n## User\n# Title\n");
  });

  it("tolerates a partial trailing record without duplicating the last turn", () => {
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

    const read = readCodexSession(file);
    expect(read.session).toBe("## User\n\nhello\n\n## Assistant\n\nhi\n");
    expect(read.session).not.toContain("unfinished");
    expect(read.session.match(/^## Assistant$/gm)).toHaveLength(1);
    // The two turns are counted; the interrupted write is not a record yet, so
    // it is neither read nor counted.
    expect(read.loss).toEqual({ excluded: 0, total: 2 });
  });

  it("skips a malformed record and reports what it lost", () => {
    const { dir } = fixtureHome();
    const file = writeRollout(dir, {
      raw: [
        JSON.stringify(sessionMeta("/worktree", id(1))),
        JSON.stringify(userMessage("hello")),
        '{"not": "a complete record"',
        JSON.stringify(assistantMessage("hi")),
      ].join("\n"),
    });

    const read = readCodexSession(file);

    expect(read.session).toBe("## User\n\nhello\n\n## Assistant\n\nhi\n");
    // Two turns plus the line that could not be read; the metadata record is
    // not a message, so it is in neither count.
    expect(read.loss).toEqual({ excluded: 1, total: 3 });
  });

  it("skips a message whose content is not an array of parts", () => {
    const { dir } = fixtureHome();
    const file = writeRollout(dir, {
      raw: [
        JSON.stringify(sessionMeta("/worktree", id(1))),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: "hello" },
        }),
      ].join("\n"),
    });

    const read = readCodexSession(file);

    expect(read.session).toBe("");
    expect(read.loss).toEqual({ excluded: 1, total: 1 });
  });

  it("does not abort over an unreadable legacy record while response items exist", () => {
    const { dir } = fixtureHome();
    const file = writeRollout(dir, {
      raw: [
        JSON.stringify(sessionMeta("/worktree", id(1))),
        JSON.stringify(userMessage("hello")),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: 42 },
        }),
        JSON.stringify(assistantMessage("hi")),
      ].join("\n"),
    });

    const read = readCodexSession(file);

    // The legacy form is never read once response items exist, so an
    // unreadable one costs the export that record and nothing more.
    expect(read.session).toBe("## User\n\nhello\n\n## Assistant\n\nhi\n");
    expect(read.loss).toEqual({ excluded: 1, total: 3 });
  });

  it("refuses a record it cannot read", () => {
    const { home } = fixtureHome();
    expect(faultOf(() => readCodexSession(home))).toBe("unreadable-record");
  });

  it("returns no session for a file whose records carry no prose", () => {
    const { dir } = fixtureHome();
    const file = writeRollout(dir, {
      records: [sessionMeta("/worktree", id(1))],
    });

    const read = readCodexSession(file);

    // Nothing was skipped: the file simply holds no turn, and the caller is
    // what reports that as an empty session.
    expect(read.session).toBe("");
    expect(read.loss).toEqual({ excluded: 0, total: 0 });
  });

  it("falls back to legacy event messages when no response items exist", () => {
    const session = readFixture([
      sessionMeta("/worktree", id(1), { session_id: undefined }),
      eventMessage("user_message", { message: "legacy question" }),
      eventMessage("agent_message", { message: "legacy answer" }),
    ]);

    expect(session).toBe(
      "## User\n\nlegacy question\n\n## Assistant\n\nlegacy answer\n",
    );
  });

  it("does not duplicate a dual-written legacy turn", () => {
    const session = readFixture([
      sessionMeta("/worktree", id(1)),
      eventMessage("user_message", { message: "hello" }),
      userMessage("hello"),
      eventMessage("agent_message", { message: "hi" }),
      assistantMessage("hi"),
    ]);

    expect(session).toBe("## User\n\nhello\n\n## Assistant\n\nhi\n");
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
      records: [
        sessionMeta(cwd, id(3), {
          thread_source: "subagent",
          source: { subagent: "review" },
        }),
      ],
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
    expect(exportCodexSession(request).session).toBe("## User\n\nnew\n");
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
      records: [
        sessionMeta("/worktree", id(1), {
          thread_source: "subagent",
          source: { subagent: "review" },
        }),
      ],
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
    expect(canExportForHandover(codexHarness)).toBe(true);

    const exported = await codexHarness.exportForHandover!({
      pi: {} as ExtensionAPI,
      subagentId: "c0d3e4f5",
      paneId: "pane-1",
      cwd: "/worktree",
    });

    expect(exported).toEqual({
      sessionId: id(7),
      session: "## User\n\nhello\n",
      loss: { excluded: 0, total: 1 },
    });
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

describe("the exported record", () => {
  it("keeps exactly the two role headings", () => {
    const session = readFixture([
      sessionMeta("/worktree", id(1)),
      userMessage("q"),
      assistantMessage("a"),
    ]);
    const headings = session
      .split("\n")
      .filter((line) => line.startsWith("#") || line.trim().startsWith("#"));
    expect(headings).toEqual(["## User", "## Assistant"]);
  });

  it("names the record type in the public result", () => {
    const { home, dir } = fixtureHome();
    const cwd = "/worktree";
    writeRollout(dir, {
      records: [sessionMeta(cwd, id(1)), userMessage("hello")],
    });

    const exported: CodexSessionRecord & { session: string } =
      exportCodexSession({ cwd, codexHome: home });
    expect(exported.sessionId).toBe(id(1));
    expect(exported.file.endsWith(".jsonl")).toBe(true);
  });
});
