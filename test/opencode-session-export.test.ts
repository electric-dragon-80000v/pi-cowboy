/**
 * opencode-session-export.test.ts — reading a run's session back for a handover.
 *
 * Record classification carries user turns and assistant text in order while
 * omitting reasoning and tool traffic. Selection is the part the CLI cannot
 * answer: one directory holds a run per spawn and a definition proof under the
 * same agent name, so only its model tells them apart. The hook test pins the
 * wiring — the list query carries the run's directory, and the read uses the
 * id the list selected.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionExportError } from "../src/agents/harness.js";
import { completeHandoverExport } from "../src/agents/handover.js";
import type {
  OpencodeSessionExportRequest,
  OpencodeSessionSummary,
} from "../src/agents/harness/opencode/session-export.js";
import {
  classifyOpencodeMessages,
  opencodeSessionListPath,
  parseOpencodeSessionExport,
  parseOpencodeSessionList,
  readOpencodeSessionRecords,
  selectOpencodeRunSession,
} from "../src/agents/harness/opencode/session-export.js";

function renderRecords(messages: readonly unknown[]): string {
  return completeHandoverExport({
    sessionId: "ses_1",
    records: classifyOpencodeMessages(messages),
  }).session;
}

async function readRecords(request: OpencodeSessionExportRequest) {
  return completeHandoverExport(await readOpencodeSessionRecords(request));
}

const CWD = "/repo/wt";

const PROOF_MODEL = "pi-cowboy/opencode-definition-proof";

/** One session-list entry, with the fields the selector reads. */
function summary(
  id: string,
  input: {
    agent?: string;
    directory?: string;
    updated?: number;
    model?: { id: string; providerID: string };
  } = {},
): OpencodeSessionSummary {
  return {
    id,
    agent: input.agent,
    model: input.model ?? { id: "m", providerID: "p" },
    time: { updated: input.updated ?? 0 },
    location: { directory: input.directory ?? CWD },
  };
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

describe("opencodeSessionListPath", () => {
  it("scopes the list to the run's directory", () => {
    expect(opencodeSessionListPath("/repo/wt")).toBe(
      "/api/session?directory=%2Frepo%2Fwt&limit=100",
    );
  });

  it("encodes a directory with query characters in it", () => {
    expect(opencodeSessionListPath("/repo/a b&c?d")).toBe(
      "/api/session?directory=%2Frepo%2Fa%20b%26c%3Fd&limit=100",
    );
  });
});

describe("parseOpencodeSessionList", () => {
  it("reads the sessions the API returned", () => {
    const stdout = JSON.stringify({
      data: [
        summary("ses_1", { agent: "a1b2c3d4", updated: 10 }),
        summary("ses_2", { agent: "a1b2c3d4", updated: 20 }),
      ],
    });
    expect(parseOpencodeSessionList(stdout)?.map((s) => s.id)).toEqual([
      "ses_1",
      "ses_2",
    ]);
  });

  it("is undefined for output of another shape", () => {
    expect(parseOpencodeSessionList("not json")).toBeUndefined();
    expect(parseOpencodeSessionList('{"sessions":[]}')).toBeUndefined();
  });
});

describe("selectOpencodeRunSession", () => {
  const select = (sessions: readonly OpencodeSessionSummary[]) =>
    selectOpencodeRunSession(sessions, {
      cwd: CWD,
      subagentId: "a1b2c3d4",
      proofModel: PROOF_MODEL,
    });

  it("selects the session the run's agent wrote in its directory", () => {
    const sessions = [
      summary("ses_other_agent", { agent: "zzzzzzzz", updated: 30 }),
      summary("ses_other_dir", {
        agent: "a1b2c3d4",
        directory: "/repo/other",
        updated: 40,
      }),
      summary("ses_run", { agent: "a1b2c3d4", updated: 10 }),
    ];
    expect(select(sessions)?.id).toBe("ses_run");
  });

  it("skips the definition proof even when it is newer", () => {
    const sessions = [
      summary("ses_run", { agent: "a1b2c3d4", updated: 10 }),
      summary("ses_proof", {
        agent: "a1b2c3d4",
        updated: 20,
        model: { id: "opencode-definition-proof", providerID: "pi-cowboy" },
      }),
    ];
    expect(select(sessions)?.id).toBe("ses_run");
  });

  it("selects the newest run when a directory holds several", () => {
    const sessions = [
      summary("ses_old", { agent: "a1b2c3d4", updated: 10 }),
      summary("ses_new", { agent: "a1b2c3d4", updated: 30 }),
      summary("ses_mid", { agent: "a1b2c3d4", updated: 20 }),
    ];
    expect(select(sessions)?.id).toBe("ses_new");
  });

  it("compares directories with trailing separators normalized", () => {
    const sessions = [
      summary("ses_run", { agent: "a1b2c3d4", directory: `${CWD}/` }),
    ];
    expect(select(sessions)?.id).toBe("ses_run");
  });

  it("is undefined when the run wrote no session", () => {
    expect(
      select([
        summary("ses_proof", {
          agent: "a1b2c3d4",
          model: { id: "opencode-definition-proof", providerID: "pi-cowboy" },
        }),
      ]),
    ).toBeUndefined();
    expect(select([])).toBeUndefined();
  });
});

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
      { kind: "export", turn: { role: "User", text: "first" } },
      { kind: "export", turn: { role: "Assistant", text: "second" } },
      { kind: "export", turn: { role: "Assistant", text: "third" } },
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

  it("classifies readable non-transferable messages as deliberate omissions", () => {
    const messages = [
      { type: "agent-switched" },
      { type: "model-switched" },
      { type: "system", text: "tools changed" },
      { type: "synthetic", text: "server restarted" },
      { type: "compaction", text: "summary of earlier work" },
      { type: "shell", text: "echo hi" },
      { type: "idle" },
      { type: "assistant", content: [reasoning("thinking")] },
      { type: "assistant", content: [tool()] },
    ];

    expect([...classifyOpencodeMessages(messages)]).toEqual(
      messages.map((message) => ({
        kind: "dont-export",
        content: JSON.stringify(message),
      })),
    );
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
  /** The staging root the reader resolves this spawn's env file under. */
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

  /** The env.sh a spawn's launch stages for the pane launcher. */
  function stageEnv(content: string): string {
    const file = path.join(staging, "pi-cowboy", "a1b2c3d4", "env.sh");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }

  /** A request over a fake pi that answers the two reads. */
  function request(
    exec: ReturnType<typeof vi.fn>,
  ): OpencodeSessionExportRequest {
    return {
      pi: { exec } as unknown as ExtensionAPI,
      subagentId: "a1b2c3d4",
      cwd: CWD,
      proofModel: PROOF_MODEL,
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

  /** The two answers the hook reads, keyed by the command it runs. */
  function answering(input: { list: string; exported: string; code?: number }) {
    return vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("api")) {
        return { code: input.code ?? 0, stdout: input.list, stderr: "" };
      }
      return { code: input.code ?? 0, stdout: input.exported, stderr: "" };
    });
  }

  it("lists the run's directory and exports the selected session", async () => {
    const exec = answering({
      list: JSON.stringify({
        data: [
          summary("ses_run", { agent: "a1b2c3d4", updated: 10 }),
          summary("ses_proof", {
            agent: "a1b2c3d4",
            updated: 20,
            model: { id: "opencode-definition-proof", providerID: "pi-cowboy" },
          }),
        ],
      }),
      exported: sessionExport("ses_run", [
        user("do it"),
        assistant(reasoning("hidden"), text("done")),
      ]),
    });

    await expect(readRecords(request(exec))).resolves.toEqual({
      sessionId: "ses_run",
      session: "## User\n\ndo it\n\n## Assistant\n\ndone\n",
    });

    expect(exec.mock.calls[0]).toEqual([
      "opencode",
      [
        "api",
        "--standalone",
        "GET",
        "/api/session?directory=%2Frepo%2Fwt&limit=100",
      ],
      { timeout: 15_000 },
    ]);
    expect(exec.mock.calls[1]).toEqual([
      "opencode",
      ["session", "export", "--standalone", "ses_run"],
      { timeout: 30_000 },
    ]);
  });

  it("reads through the run's staged environment when it has one", async () => {
    const envFile = stageEnv("export XDG_DATA_HOME='/store/run'\n");
    const exec = answering({
      list: JSON.stringify({
        data: [summary("ses_run", { agent: "a1b2c3d4" })],
      }),
      exported: sessionExport("ses_run", [user("do it")]),
    });

    await expect(readRecords(request(exec))).resolves.toEqual({
      sessionId: "ses_run",
      session: "## User\n\ndo it\n",
    });

    // Both reads source the file, so the store the run's env selected is the
    // store they query; only its path joins the command.
    const script = `( . '${envFile}' && { command opencode "$@"; } )`;
    expect(exec.mock.calls[0]).toEqual([
      "sh",
      [
        "-c",
        script,
        "opencode",
        "api",
        "--standalone",
        "GET",
        "/api/session?directory=%2Frepo%2Fwt&limit=100",
      ],
      { timeout: 15_000 },
    ]);
    expect(exec.mock.calls[1]).toEqual([
      "sh",
      [
        "-c",
        script,
        "opencode",
        "session",
        "export",
        "--standalone",
        "ses_run",
      ],
      { timeout: 30_000 },
    ]);
  });

  it("refuses a run whose session cannot be found", async () => {
    const exec = answering({
      list: JSON.stringify({ data: [] }),
      exported: sessionExport("ses_run", [user("do it")]),
    });
    const refused = await refusalOf(readRecords(request(exec)));
    expect(refused.fault).toBe("session-not-found");
    expect(refused.message).toContain(
      "no opencode session for agent a1b2c3d4 in /repo/wt: the run wrote no session this harness can find",
    );
  });

  it("reports a failed list with the command and its stderr", async () => {
    const exec = vi.fn(async () => ({
      code: 2,
      stdout: "",
      stderr: "no server\n",
    }));
    const refused = await refusalOf(readRecords(request(exec)));
    expect(refused.fault).toBe("export-command-failed");
    expect(refused.message).toBe(
      "could not list the opencode sessions in /repo/wt: `opencode api --standalone GET /api/session?directory=%2Frepo%2Fwt&limit=100` exited 2: no server",
    );
  });

  it("reports a failed export with the command and its stderr", async () => {
    const exec = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("api")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            data: [summary("ses_run", { agent: "a1b2c3d4" })],
          }),
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: "session not found" };
    });
    const refused = await refusalOf(readRecords(request(exec)));
    expect(refused.fault).toBe("export-command-failed");
    expect(refused.message).toBe(
      "could not export opencode session ses_run: `opencode session export --standalone ses_run` exited 1: session not found",
    );
  });

  it("refuses output of a shape the harness cannot read", async () => {
    const exec = answering({
      list: JSON.stringify({
        data: [summary("ses_run", { agent: "a1b2c3d4" })],
      }),
      exported: "not json",
    });
    const refused = await refusalOf(readRecords(request(exec)));
    expect(refused.fault).toBe("malformed-record");
    expect(refused.message).toBe(
      "`opencode session export ses_run` returned a shape this harness does not recognize.",
    );
  });

  it("refuses a list of a shape the harness cannot read", async () => {
    const exec = answering({
      list: "not json",
      exported: sessionExport("ses_run", [user("do it")]),
    });
    const refused = await refusalOf(readRecords(request(exec)));
    expect(refused.fault).toBe("malformed-record");
    expect(refused.message).toContain(
      "returned a shape this harness does not recognize",
    );
  });
});
