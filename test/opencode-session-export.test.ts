/**
 * opencode-session-export.test.ts — reading a run's session back for a handover.
 *
 * Record classification carries user turns and assistant text in order while
 * omitting reasoning and tool traffic. The session is not searched for: staging
 * pins one id on the run's command line and records it, so the read is a lookup
 * of that id and nothing else in the store can shadow it. The hook test pins the
 * wiring — the record's id rides `session export`, and a spawn with no record
 * refuses instead of guessing.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionExportError } from "../src/agents/harness.js";
import { completeHandoverExport } from "../src/agents/handover.js";
import type { OpencodeSessionExportRequest } from "../src/agents/harness/opencode/session-export.js";
import {
  classifyOpencodeMessages,
  parseOpencodeSessionExport,
  readOpencodeSessionRecords,
} from "../src/agents/harness/opencode/session-export.js";
import {
  opencodeConfigDir,
  opencodeSessionRecordFile,
} from "../src/agents/harness/opencode/staging.js";

/** The subagent these tests read for; the shape a spawn id has. */
const SUBAGENT_ID = "a1b2c3d4";

/** The id staging pins: opencode's `ses_` prefix and 26 base62 characters. */
const RUN_SESSION_ID = `ses_${"a".repeat(26)}`;

function renderRecords(messages: readonly unknown[]): string {
  return completeHandoverExport({
    sessionId: "ses_1",
    records: classifyOpencodeMessages(messages),
  }).session;
}

async function readRecords(request: OpencodeSessionExportRequest) {
  return completeHandoverExport(await readOpencodeSessionRecords(request));
}

/** The transfer JSON opencode writes for one session. */
function sessionExport(id: string, messages: readonly unknown[]): string {
  return JSON.stringify({ info: { id }, messages });
}

function user(text: string): unknown {
  return { type: "user", text };
}

function assistant(...parts: readonly unknown[]): unknown {
  return { type: "assistant", content: parts };
}

interface Part {
  readonly type: string;
  readonly text?: string;
}

const text = (value: string): Part => ({ type: "text", text: value });
const reasoning = (value: string): Part => ({
  type: "reasoning",
  text: value,
});
const tool = (): Part => ({ type: "tool", text: "tool output" });

/**
 * A completed compaction as opencode's own export writes it: a session-level
 * message whose summary is the text that replaces the history before it.
 */
function completedCompaction(summary: string): unknown {
  return {
    id: "msg_comp",
    time: { created: 1002 },
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

/** A failed compaction: opencode keeps it in the session, but it has no summary. */
function failedCompaction(): unknown {
  return {
    id: "msg_comp",
    time: { created: 1002 },
    type: "compaction",
    status: "failed",
    reason: "auto",
    error: { type: "compaction.failed", message: "provider refused" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

describe("parseOpencodeSessionExport", () => {
  it("reads the session id and messages", () => {
    const parsed = parseOpencodeSessionExport(
      sessionExport("ses_1", [user("hi")]),
    );
    expect(parsed?.sessionId).toBe("ses_1");
    expect(parsed?.messages).toHaveLength(1);
  });

  it("is undefined when the id or messages are missing", () => {
    expect(
      parseOpencodeSessionExport('{"info":{},"messages":[]}'),
    ).toBeUndefined();
    expect(
      parseOpencodeSessionExport('{"info":{"id":"ses_1"}}'),
    ).toBeUndefined();
    expect(parseOpencodeSessionExport("not json")).toBeUndefined();
  });
});

describe("classifyOpencodeMessages", () => {
  it("classifies user turns and assistant text in order", () => {
    const parsed = parseOpencodeSessionExport(
      sessionExport("ses_1", [
        user("first"),
        assistant(reasoning("hidden"), tool(), text("second")),
        assistant(text("third")),
      ]),
    );
    const messages = parsed?.messages ?? [];

    expect([...classifyOpencodeMessages(messages)]).toEqual([
      { kind: "user", content: "first" },
      { kind: "assistant", content: "second" },
      { kind: "assistant", content: "third" },
    ]);
    expect(
      completeHandoverExport({
        sessionId: "ses_1",
        records: classifyOpencodeMessages(messages),
      }).session,
    ).toBe(
      [
        "## User",
        "",
        "first",
        "",
        "## Assistant",
        "",
        "second",
        "",
        "## Assistant",
        "",
        "third",
        "",
      ].join("\n"),
    );
  });

  it("classifies other native messages, thinking, and tool traffic by kind", () => {
    const messages = [
      { type: "agent-switched" },
      { type: "model-switched" },
      { type: "system", text: "tools changed" },
      { type: "synthetic", text: "server restarted" },
      { type: "shell", text: "echo hi" },
      { type: "idle" },
      { type: "assistant", content: [reasoning("thinking")] },
      { type: "assistant", content: [tool()] },
    ];

    expect([...classifyOpencodeMessages(messages)]).toEqual([
      ...messages.slice(0, 6).map((message) => ({
        kind: "other",
        unmappedKind: (message as { type: string }).type,
        content: JSON.stringify(message),
      })),
      { kind: "thinking", content: "thinking" },
      { kind: "tool-call", content: JSON.stringify([tool()]) },
    ]);
  });

  it("classifies a completed compaction as the shared compaction boundary", () => {
    const messages = [
      user("before"),
      completedCompaction("earlier work condensed"),
      user("after"),
    ];

    expect([...classifyOpencodeMessages(messages)]).toEqual([
      { kind: "user", content: "before" },
      { kind: "compaction", content: "earlier work condensed" },
      { kind: "user", content: "after" },
    ]);
  });

  it("starts the artifact at the compaction's summary", () => {
    expect(
      renderRecords([
        user("before"),
        completedCompaction("earlier work condensed"),
        user("after"),
      ]),
    ).toBe("## Compaction\n\nearlier work condensed\n\n## User\n\nafter\n");
  });

  it("classifies a compaction with no summary as a blank compaction", () => {
    const failed = failedCompaction();

    expect([...classifyOpencodeMessages([failed])]).toEqual([
      { kind: "compaction", content: "" },
    ]);
    expect(renderRecords([user("before"), failed, user("after")])).toBe(
      "## User\n\nbefore\n\n## User\n\nafter\n",
    );
  });

  it("does not read a provider compaction part as a session compaction", () => {
    const providerState = {
      type: "compaction",
      text: "encrypted provider state",
    };

    expect([...classifyOpencodeMessages([assistant(providerState)])]).toEqual([
      {
        kind: "other",
        unmappedKind: "assistant",
        content: JSON.stringify(assistant(providerState)),
      },
    ]);
    expect(
      renderRecords([assistant(providerState, text("visible answer"))]),
    ).toBe("## Assistant\n\nvisible answer\n");
  });

  it("reports native messages it cannot classify as unparseable", () => {
    expect([...classifyOpencodeMessages([null])]).toEqual([
      { kind: "unparseable", content: "null" },
    ]);
  });

  it("joins several text parts of one message with one blank line", () => {
    expect(
      renderRecords([
        { type: "assistant", content: [text("one"), text("two")] },
      ]),
    ).toBe("## Assistant\n\none\n\ntwo\n");
  });

  it("skips blank text", () => {
    expect(
      renderRecords([
        { type: "user", text: "   " },
        { type: "assistant", content: [text("")] },
      ]),
    ).toBe("");
  });

  it("escapes a heading the message itself contains", () => {
    const body = "## Verdict\n\n- pass\n- one note";
    expect(renderRecords([{ type: "assistant", content: [text(body)] }])).toBe(
      "## Assistant\n\n\\## Verdict\n\n- pass\n- one note\n",
    );
  });

  it("escapes a role heading a message quotes", () => {
    expect(
      renderRecords([{ type: "user", text: "## User\nnot a boundary" }]),
    ).toBe("## User\n\n\\## User\nnot a boundary\n");
  });

  it("leaves a heading inside fenced code alone", () => {
    const body = "```markdown\n## User\n```";
    expect(renderRecords([{ type: "assistant", content: [text(body)] }])).toBe(
      `## Assistant\n\n${body}\n`,
    );
  });

  it("trims the blank margin and trailing whitespace, keeping indentation", () => {
    expect(
      renderRecords([{ type: "user", text: "\n\n  keep indent  \n\t\n\n" }]),
    ).toBe("## User\n\n  keep indent\n");
  });

  it("ends the artifact with exactly one newline", () => {
    expect(renderRecords([{ type: "user", text: "one\n\n\n" }])).toBe(
      "## User\n\none\n",
    );
  });
});

describe("readOpencodeSessionRecords", () => {
  /** The staging root the reader resolves this spawn's config dir under. */
  let staging: string;
  let previousTmpdir: string | undefined;

  beforeEach(() => {
    previousTmpdir = process.env.TMPDIR;
    staging = fs.mkdtempSync(path.join(tmpdir(), "cowboy-opencode-export-"));
    process.env.TMPDIR = staging;
  });

  afterEach(() => {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    fs.rmSync(staging, { recursive: true, force: true });
  });

  /** The run record a launch's staging writes for this export to read. */
  function stageRecord(content: unknown): string {
    const file = opencodeSessionRecordFile(opencodeConfigDir(SUBAGENT_ID));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      typeof content === "string" ? content : JSON.stringify(content),
    );
    return file;
  }

  /** The env.sh a spawn's launch stages for the pane launcher. */
  function stageEnv(content: string): string {
    const file = path.join(staging, "pi-cowboy", SUBAGENT_ID, "env.sh");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }

  /** A request over a fake pi that answers the export read. */
  function request(
    exec: ReturnType<typeof vi.fn>,
  ): OpencodeSessionExportRequest {
    return {
      pi: { exec } as unknown as ExtensionAPI,
      subagentId: SUBAGENT_ID,
    };
  }

  /** The failure a record read threw, so its shared fault can be asserted. */
  async function refusalOf(
    exportPromise: Promise<unknown>,
  ): Promise<SessionExportError> {
    try {
      await exportPromise;
    } catch (error) {
      if (error instanceof SessionExportError) return error;
      throw error;
    }
    throw new Error("the export resolved instead of refusing");
  }

  /** The answer the read runs against. */
  function answering(input: { exported: string; code?: number }) {
    return vi.fn(async (_command: string, _args: readonly string[]) => ({
      code: input.code ?? 0,
      stdout: input.exported,
      stderr: "",
    }));
  }

  it("exports the session id staging pinned", async () => {
    stageRecord({ sessionId: RUN_SESSION_ID });
    const exec = answering({
      exported: sessionExport(RUN_SESSION_ID, [
        user("do it"),
        assistant(reasoning("hidden"), text("done")),
      ]),
    });

    await expect(readRecords(request(exec))).resolves.toEqual({
      sessionId: RUN_SESSION_ID,
      session: "## User\n\ndo it\n\n## Assistant\n\ndone\n",
    });

    expect(exec.mock.calls).toEqual([
      [
        "opencode",
        ["session", "export", "--standalone", RUN_SESSION_ID],
        { timeout: 30_000 },
      ],
    ]);
  });

  it("reads through the run's staged environment when it has one", async () => {
    stageRecord({ sessionId: RUN_SESSION_ID });
    const envFile = stageEnv("export XDG_DATA_HOME='/store/run'\n");
    const exec = answering({
      exported: sessionExport(RUN_SESSION_ID, [user("do it")]),
    });

    await expect(readRecords(request(exec))).resolves.toEqual({
      sessionId: RUN_SESSION_ID,
      session: "## User\n\ndo it\n",
    });

    // The read sources the file, so the store the run's env selected is the
    // store it queries; only the file's path joins the command.
    const script = `( . '${envFile}' && { command opencode "$@"; } )`;
    expect(exec.mock.calls).toEqual([
      [
        "sh",
        [
          "-c",
          script,
          "opencode",
          "session",
          "export",
          "--standalone",
          RUN_SESSION_ID,
        ],
        { timeout: 30_000 },
      ],
    ]);
  });

  it("refuses a spawn that pinned no session id", async () => {
    const exec = answering({ exported: sessionExport(RUN_SESSION_ID, []) });
    const refused = await refusalOf(readRecords(request(exec)));
    expect(refused.fault).toBe("session-not-found");
    expect(refused.message).toContain("no opencode run record under");
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses a run record that is not JSON", async () => {
    stageRecord("not json");
    const exec = answering({ exported: sessionExport(RUN_SESSION_ID, []) });
    const refused = await refusalOf(readRecords(request(exec)));
    expect(refused.fault).toBe("malformed-record");
    expect(refused.message).toContain("not valid JSON");
  });

  it("refuses a run record naming no session", async () => {
    stageRecord({ sessionId: "not-a-session" });
    const exec = answering({ exported: sessionExport(RUN_SESSION_ID, []) });
    const refused = await refusalOf(readRecords(request(exec)));
    expect(refused.fault).toBe("malformed-record");
    expect(refused.message).toContain("no valid sessionId");
  });

  it("reports a failed export with the command and its stderr", async () => {
    stageRecord({ sessionId: RUN_SESSION_ID });
    const exec = vi.fn(async () => ({
      code: 1,
      stdout: "",
      stderr: "session not found",
    }));
    const refused = await refusalOf(readRecords(request(exec)));
    expect(refused.fault).toBe("export-command-failed");
    expect(refused.message).toBe(
      `could not export opencode session ${RUN_SESSION_ID}: \`opencode session export --standalone ${RUN_SESSION_ID}\` exited 1: session not found`,
    );
  });

  it("refuses output of a shape the harness cannot read", async () => {
    stageRecord({ sessionId: RUN_SESSION_ID });
    const exec = answering({ exported: "not json" });
    const refused = await refusalOf(readRecords(request(exec)));
    expect(refused.fault).toBe("malformed-record");
    expect(refused.message).toBe(
      `\`opencode session export ${RUN_SESSION_ID}\` returned a shape this harness does not recognize.`,
    );
  });
});
