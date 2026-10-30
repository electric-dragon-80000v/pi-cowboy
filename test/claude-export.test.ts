/**
 * claude-export.test.ts — the claude session export, pinned against recorded
 * record shapes in a temporary store.
 *
 * Every fixture is built here from the fields the reader depends on; no test
 * reads a real home directory, launches the CLI, or reaches the network. The
 * store layout is the one claude writes under `CLAUDE_CONFIG_DIR`:
 * `projects/<slugged-cwd>/<session-id>.jsonl`, with sidechains beside it.
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionExportError } from "../src/agents/harness.js";
import { completeHandoverExport } from "../src/agents/handover.js";
import { claudeHarness } from "../src/agents/harness/claude/index.js";
import {
  readClaudeSession,
  readClaudeSessionRecords,
} from "../src/agents/harness/claude/session-export.js";
import { claudeProjectDir } from "../src/agents/harness/claude/staging.js";

const SESSION_ID = "54e910bc-afb7-4e8e-a70c-7df57ede3cf1";
const OTHER_SESSION_ID = "d7d3b337-378f-44e5-b8d6-6c7339df5281";
const SUBAGENT_ID = "esp02hpw";

/** Temporary roots this file made; removed after every test, pass or fail. */
const madeRoots: string[] = [];

/** The config directory this test writes its store under. */
let configDir: string;

/** The tree the run is said to have run in; it exists, so its real path is the slug. */
let cwd: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "cowboy-claude-export-"));
  madeRoots.push(root);
  configDir = join(root, "claude");
  cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  writeRunRecord();
});

afterEach(() => {
  for (const root of madeRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A user record carrying plain text. */
function user(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "user",
    uuid: "u1",
    sessionId: SESSION_ID,
    isSidechain: false,
    message: { role: "user", content: text },
    ...extra,
  };
}

/** An assistant record carrying one content block. */
function assistant(
  block: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "assistant",
    uuid: "a1",
    sessionId: SESSION_ID,
    isSidechain: false,
    message: { id: "msg_1", role: "assistant", content: [block] },
    ...extra,
  };
}

/** The project directory claude derives from the fixture cwd. */
function projectDir(): string {
  return claudeProjectDir(configDir, cwd);
}

/** The run record staging writes: the id the run was launched to write. */
function writeRunRecord(sessionId = SESSION_ID): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "session.json"),
    `${JSON.stringify({ sessionId })}\n`,
  );
}

/** Write one JSONL session file in the project directory. */
function writeSession(
  records: readonly Record<string, unknown>[],
  options: { sessionId?: string; name?: string } = {},
): string {
  const dir = projectDir();
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    options.name ?? `${options.sessionId ?? SESSION_ID}.jsonl`,
  );
  writeFileSync(
    file,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  return file;
}

/** Export the fixture store. */
function exportFixture() {
  return completeHandoverExport(readClaudeSessionRecords({ configDir, cwd }));
}

/** The typed reason an export refused with. */
function faultOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof SessionExportError) return error.fault;
    throw error;
  }
  throw new Error("the export did not refuse");
}

describe("claudeProjectDir", () => {
  it("slugs the canonical cwd by replacing every non-alphanumeric character", () => {
    // `/tmp` is `/private/tmp` on macOS, and claude keys the project by the
    // real spelling, so the fixture's real path is what the slug is built from.
    const real = realpathSync.native(cwd);
    const expected = real.replace(/[^A-Za-z0-9]/g, "-");

    expect(claudeProjectDir(configDir, cwd)).toBe(
      join(configDir, "projects", expected),
    );
    expect(expected.startsWith("-")).toBe(true);
  });

  it("keeps runs of punctuation as separate dashes rather than collapsing them", () => {
    expect(claudeProjectDir("/cfg", "/var/.../a_b.c d")).toBe(
      join("/cfg", "projects", "-var-----a-b-c-d"),
    );
  });
});

describe("readClaudeSessionRecords", () => {
  it("renders user and assistant prose as the two headings, in order", () => {
    writeSession([
      user("What the user said."),
      assistant({ type: "text", text: "What the assistant said." }),
      user("The next thing the user said."),
    ]);

    expect(exportFixture()).toEqual({
      sessionId: SESSION_ID,
      session:
        "## User\n\nWhat the user said.\n\n## Assistant\n\nWhat the assistant said.\n\n## User\n\nThe next thing the user said.\n",
    });
  });

  it("joins every text block of one message and keeps no leading or trailing whitespace", () => {
    writeSession([
      user("  first line  \n\nsecond line\n\n"),
      assistant({
        type: "text",
        text: "a\r\nb",
      }),
    ]);

    expect(exportFixture().session).toBe(
      "## User\n\n  first line\n\nsecond line\n\n## Assistant\n\na\nb\n",
    );
  });

  it("escapes content headings so only the role headings remain", () => {
    writeSession([
      user("## User\nnot a role boundary\n### Details"),
      assistant({
        type: "text",
        text: "## Summary\n\nDone.\n\n```sh\n## a comment inside a fence\n```",
      }),
    ]);

    const { session } = exportFixture();

    expect(session).toBe(
      "## User\n\n\\## User\nnot a role boundary\n\\### Details\n\n## Assistant\n\n\\## Summary\n\nDone.\n\n```sh\n## a comment inside a fence\n```\n",
    );
    expect(session).not.toContain("\n## User\nnot a role boundary");
    expect(session).not.toContain("\n## Summary\n");
  });

  it("ignores content parts that are not typed parts", () => {
    writeSession([
      {
        type: "user",
        sessionId: SESSION_ID,
        message: {
          role: "user",
          content: ["NOT-A-PART", { type: "text", text: "kept" }],
        },
      },
    ]);

    expect(exportFixture().session).toBe("## User\n\nkept\n");
  });

  it("drops thinking, tool calls, and tool results by content, not just by heading", () => {
    writeSession([
      user("keep this prompt"),
      assistant({ type: "thinking", thinking: "THINKING-SECRET" }),
      assistant({
        type: "tool_use",
        id: "toolu_1",
        name: "Bash",
        input: { command: "cat TOOL-ARGUMENT-SECRET" },
      }),
      {
        type: "user",
        sessionId: SESSION_ID,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "TOOL-RESULT-SECRET",
            },
          ],
        },
      },
      assistant({ type: "text", text: "keep this answer" }),
    ]);

    const { session } = exportFixture();

    expect(session).toBe(
      "## User\n\nkeep this prompt\n\n## Assistant\n\nkeep this answer\n",
    );
    expect(
      [
        "THINKING-SECRET",
        "TOOL-ARGUMENT-SECRET",
        "TOOL-RESULT-SECRET",
        "tool_use",
        "tool_result",
      ].filter((secret) => session.includes(secret)),
    ).toEqual([]);
    expect(session.match(/^## /gm)).toHaveLength(2);
  });

  it("drops system, attachment, legacy session-summary, and API-error records", () => {
    writeSession([
      user("the question"),
      {
        type: "system",
        sessionId: SESSION_ID,
        subtype: "turn_duration",
        content: "SYSTEM-SECRET",
      },
      {
        type: "attachment",
        sessionId: SESSION_ID,
        attachment: { type: "prompt_snapshot", content: "ATTACHMENT-SECRET" },
      },
      {
        type: "summary",
        sessionId: SESSION_ID,
        leafUuid: "u1",
        summary: "SESSION-TITLE-SECRET",
      },
      {
        type: "system",
        subtype: "compact_boundary",
        sessionId: SESSION_ID,
        content: "Conversation compacted",
        compactMetadata: { trigger: "auto", preTokens: 167219 },
      },
      assistant(
        { type: "text", text: "ERROR-SECRET" },
        { isApiErrorMessage: true },
      ),
      assistant(
        { type: "text", text: "SYNTHETIC-SECRET" },
        {
          message: {
            id: "m",
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "SYNTHETIC-SECRET" }],
          },
        },
      ),
      assistant({ type: "text", text: "the answer" }),
    ]);

    const { session } = exportFixture();

    expect(session).toBe(
      "## User\n\nthe question\n\n## Assistant\n\nthe answer\n",
    );
    expect(
      [
        "SYSTEM-SECRET",
        "ATTACHMENT-SECRET",
        "SESSION-TITLE-SECRET",
        "Conversation compacted",
        "ERROR-SECRET",
        "SYNTHETIC-SECRET",
      ].filter((secret) => session.includes(secret)),
    ).toEqual([]);
  });

  it("emits claude's compact-summary record as the shared compaction, not a turn", () => {
    writeSession([
      user("the history compaction replaced"),
      assistant({ type: "text", text: "the replaced answer" }),
      {
        type: "system",
        subtype: "compact_boundary",
        sessionId: SESSION_ID,
        content: "Conversation compacted",
        compactMetadata: { trigger: "auto", preTokens: 167219 },
      },
      {
        type: "user",
        uuid: "c1",
        sessionId: SESSION_ID,
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: {
          role: "user",
          content:
            "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.\n\n## Analysis\n\nSUMMARY-PROSE",
        },
      },
      assistant({ type: "text", text: "the answer after compaction" }),
    ]);

    expect(exportFixture()).toEqual({
      sessionId: SESSION_ID,
      session:
        "## Compaction\n\nThis session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.\n\n\\## Analysis\n\nSUMMARY-PROSE\n\n## Assistant\n\nthe answer after compaction\n",
    });
  });

  it("keeps only the latest compact summary and the turns after it", () => {
    writeSession([
      user("before the first compaction"),
      user("FIRST-SUMMARY", { isCompactSummary: true }),
      user("between the compactions"),
      user("SECOND-SUMMARY", { isCompactSummary: true }),
      assistant({ type: "text", text: "after the second compaction" }),
    ]);

    const { session } = exportFixture();

    expect(session).toBe(
      "## Compaction\n\nSECOND-SUMMARY\n\n## Assistant\n\nafter the second compaction\n",
    );
    expect(session).not.toContain("FIRST-SUMMARY");
    expect(session).not.toContain("between the compactions");
  });

  it("drops meta, local-command, and sidechain records", () => {
    writeSession([
      user("human words"),
      user("META-SECRET", { isMeta: true }),
      user("<command-name>/login</command-name>\nCOMMAND-SECRET"),
      user("<local-command-stdout>STDOUT-SECRET</local-command-stdout>"),
      user("<local-command-caveat>CAVEAT-SECRET</local-command-caveat>"),
      user("SIDECHAIN-SECRET", { isSidechain: true }),
      assistant({ type: "text", text: "assistant words" }),
      assistant(
        { type: "text", text: "SIDECHAIN-ANSWER" },
        { isSidechain: true },
      ),
    ]);

    expect(exportFixture().session).toBe(
      "## User\n\nhuman words\n\n## Assistant\n\nassistant words\n",
    );
  });

  it("strips injected reminders and the extension's own marker, keeping the prose", () => {
    writeSession([
      user(
        'before\n<system-reminder>REMINDER-SECRET</system-reminder>\nafter\n<<pi-cowboy-handover [{"harness":"pi","sessionId":"x"}]>>\nlast',
      ),
    ]);

    const { session } = exportFixture();

    expect(session).toBe("## User\n\nbefore\n\nafter\nlast\n");
    expect(session).not.toContain("REMINDER-SECRET");
    expect(session).not.toContain("pi-cowboy-handover");
  });

  it("gives an empty or tool-only turn no heading", () => {
    writeSession([
      user("   "),
      user("<system-reminder>only a reminder</system-reminder>"),
      assistant({ type: "tool_use", id: "t", name: "Read", input: {} }),
      user("real"),
    ]);

    expect(exportFixture().session).toBe("## User\n\nreal\n");
  });

  it("skips a partial trailing record without throwing or repeating a turn", () => {
    const file = writeSession([
      user("first"),
      assistant({ type: "text", text: "second" }),
    ]);
    // A write in flight leaves a line with no closing brace and no newline.
    writeFileSync(
      file,
      `${JSON.stringify(user("first"))}\n{"type":"assistant","sessionId":"${SESSION_ID}","message":{"role":"assistant","content":[{"type":"text","text":"sec`,
      "utf8",
    );

    expect(exportFixture().session).toBe("## User\n\nfirst\n");
  });

  it("reports a malformed middle line as loss and keeps readable records", () => {
    const file = writeSession([
      user("first"),
      assistant({ type: "text", text: "second" }),
    ]);
    writeFileSync(
      file,
      `${JSON.stringify(user("first"))}\nnot json\n${JSON.stringify(assistant({ type: "text", text: "second" }))}\n`,
      "utf8",
    );

    expect(exportFixture()).toEqual({
      sessionId: SESSION_ID,
      session: "## User\n\nfirst\n\n## Assistant\n\nsecond\n",
      loss: { excluded: 1, total: 3 },
    });
  });

  it("reports a JSON value that is not a claude session record as loss", () => {
    const file = writeSession([user("first")]);
    writeFileSync(file, `${JSON.stringify([user("not a record")])}\n`, "utf8");

    expect(exportFixture()).toEqual({
      sessionId: SESSION_ID,
      session: "",
      loss: { excluded: 1, total: 1 },
    });
  });

  it("returns the id the records carry when it is the file's id", () => {
    writeRunRecord(OTHER_SESSION_ID);
    writeSession([user("hello", { sessionId: OTHER_SESSION_ID })], {
      sessionId: OTHER_SESSION_ID,
    });

    expect(exportFixture().sessionId).toBe(OTHER_SESSION_ID);
  });

  it("reports records whose session differs from the pinned file as loss", () => {
    writeRunRecord(OTHER_SESSION_ID);
    writeSession([user("hello")], { name: `${OTHER_SESSION_ID}.jsonl` });

    expect(exportFixture()).toEqual({
      sessionId: OTHER_SESSION_ID,
      session: "",
      loss: { excluded: 1, total: 1 },
    });
  });

  it("reports records that name no session as loss", () => {
    writeRunRecord(OTHER_SESSION_ID);
    writeSession(
      [{ type: "user", message: { role: "user", content: "hello" } }],
      { name: `${OTHER_SESSION_ID}.jsonl` },
    );

    expect(exportFixture()).toEqual({
      sessionId: OTHER_SESSION_ID,
      session: "",
      loss: { excluded: 1, total: 1 },
    });
  });

  it("reports a non-UUID record session id as loss", () => {
    writeRunRecord(OTHER_SESSION_ID);
    writeSession([user("hello", { sessionId: "not-a-uuid" })], {
      name: `${OTHER_SESSION_ID}.jsonl`,
    });

    expect(exportFixture()).toEqual({
      sessionId: OTHER_SESSION_ID,
      session: "",
      loss: { excluded: 1, total: 1 },
    });
  });

  it("refuses when there is no project directory", () => {
    expect(faultOf(exportFixture)).toBe("session-not-found");
  });

  it("refuses when the project directory holds no session file", () => {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), "notes.jsonl"), "{}\n");
    writeFileSync(join(projectDir(), "agent-abc.jsonl"), "{}\n");

    expect(faultOf(exportFixture)).toBe("session-not-found");
  });

  it("ignores a sidechain file beside the main session", () => {
    writeSession([user("main")]);
    writeFileSync(
      join(projectDir(), "agent-abc.jsonl"),
      `${JSON.stringify(user("sidechain"))}\n`,
    );

    expect(exportFixture().session).toBe("## User\n\nmain\n");
  });

  it("reads the pinned session even when older conversations share the directory", () => {
    const older = writeSession([user("an older conversation")], {
      sessionId: OTHER_SESSION_ID,
    });
    const past = new Date(Date.now() - 60_000);
    utimesSync(older, past, past);
    writeSession([user("this run")]);

    expect(exportFixture()).toEqual({
      sessionId: SESSION_ID,
      session: "## User\n\nthis run\n",
    });
  });

  it("refuses a newer session beside the run's, the way a /clear leaves one", () => {
    writeSession([user("before the clear")]);
    const successor = writeSession([user("after the clear")], {
      sessionId: OTHER_SESSION_ID,
    });
    const later = new Date(Date.now() + 60_000);
    utimesSync(successor, later, later);

    expect(faultOf(exportFixture)).toBe("ambiguous-session");
  });

  it("refuses when the run record is gone, so the file cannot be named", () => {
    writeSession([user("this run")]);
    rmSync(join(configDir, "session.json"));

    expect(faultOf(exportFixture)).toBe("session-not-found");
  });

  it("refuses a run record that names no session", () => {
    writeSession([user("this run")]);
    writeFileSync(
      join(configDir, "session.json"),
      `{"sessionId":"not-a-uuid"}\n`,
    );

    expect(faultOf(exportFixture)).toBe("malformed-record");
  });

  it("refuses when the pinned session file is absent, even with another session present", () => {
    writeSession([user("someone else's")], { sessionId: OTHER_SESSION_ID });

    expect(faultOf(exportFixture)).toBe("session-not-found");
  });

  it("reports a conversation record without a readable message as loss", () => {
    writeSession([
      {
        type: "user",
        sessionId: SESSION_ID,
        message: { role: "user", content: 5 },
      },
    ]);

    expect(exportFixture()).toEqual({
      sessionId: SESSION_ID,
      session: "",
      loss: { excluded: 1, total: 1 },
    });
  });

  it("fails an unknown session file with the unreadable-record fault", () => {
    expect(
      faultOf(() =>
        readClaudeSession(join(configDir, "missing.jsonl"), SESSION_ID),
      ),
    ).toBe("unreadable-record");
  });

  it("returns no turns when every readable record is deliberately omitted", () => {
    writeSession([
      assistant({ type: "thinking", thinking: "only thinking" }),
      assistant({ type: "tool_use", id: "t", name: "Read", input: {} }),
    ]);

    expect(exportFixture()).toEqual({ sessionId: SESSION_ID, session: "" });
  });

  it("returns no turns for an empty file", () => {
    writeSession([]);

    expect(exportFixture()).toEqual({ sessionId: SESSION_ID, session: "" });
  });

  it("ignores the record fields the export does not read", () => {
    writeSession([
      {
        parentUuid: null,
        isSidechain: false,
        userType: "external",
        cwd,
        sessionId: SESSION_ID,
        type: "user",
        message: { role: "user", content: "the prompt" },
      },
      {
        parentUuid: "u1",
        isSidechain: false,
        cwd,
        sessionId: SESSION_ID,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "the answer" }],
        },
      },
    ]);

    expect(exportFixture()).toEqual({
      sessionId: SESSION_ID,
      session: "## User\n\nthe prompt\n\n## Assistant\n\nthe answer\n",
    });
  });
});

describe("claudeHarness.readHandoverRecords", () => {
  /** The real TMPDIR, put back after every test. */
  let realTmpdir: string | undefined;

  /** The root this test redirected TMPDIR to. */
  let hookRoot: string;

  beforeEach(() => {
    realTmpdir = process.env.TMPDIR;
    hookRoot = mkdtempSync(join(tmpdir(), "cowboy-claude-hook-"));
    madeRoots.push(hookRoot);
    process.env.TMPDIR = hookRoot;
  });

  afterEach(() => {
    if (realTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = realTmpdir;
  });

  it("resolves the run's store from the subagent id and its cwd", async () => {
    const hookCwd = join(hookRoot, "work");
    mkdirSync(hookCwd, { recursive: true });
    const hookConfigDir = join(tmpdir(), "pi-cowboy", SUBAGENT_ID, "claude");
    mkdirSync(hookConfigDir, { recursive: true });
    writeFileSync(
      join(hookConfigDir, "session.json"),
      `${JSON.stringify({ sessionId: SESSION_ID })}\n`,
    );
    const dir = claudeProjectDir(hookConfigDir, hookCwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${SESSION_ID}.jsonl`),
      `${JSON.stringify(user("hook prompt"))}\n${JSON.stringify(assistant({ type: "text", text: "hook answer" }))}\n`,
    );

    const exported = await claudeHarness.readHandoverRecords?.({
      pi: {} as unknown as ExtensionAPI,
      subagentId: SUBAGENT_ID,
      paneId: "w1:p9",
      cwd: hookCwd,
    });

    expect(completeHandoverExport(exported!)).toEqual({
      sessionId: SESSION_ID,
      session: "## User\n\nhook prompt\n\n## Assistant\n\nhook answer\n",
    });
  });
});
