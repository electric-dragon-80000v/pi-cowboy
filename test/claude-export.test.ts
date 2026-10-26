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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionExportError } from "../src/agents/harness.js";
import { claudeHarness } from "../src/agents/harness/claude/index.js";
import {
  claudeProjectDir,
  exportClaudeSession,
  readClaudeSession,
} from "../src/agents/harness/claude/session-export.js";

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
    version: "2.1.287",
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
    version: "2.1.287",
    ...extra,
  };
}

/** The project directory claude derives from the fixture cwd. */
function projectDir(): string {
  return claudeProjectDir(configDir, cwd);
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
  return exportClaudeSession({ configDir, cwd });
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

describe("exportClaudeSession", () => {
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

  it("drops system, attachment, compaction, and API-error records", () => {
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
        summary: "COMPACTION-SECRET",
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
        "COMPACTION-SECRET",
        "ERROR-SECRET",
        "SYNTHETIC-SECRET",
      ].filter((secret) => session.includes(secret)),
    ).toEqual([]);
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

  it("still refuses a malformed line that is not the trailing one", () => {
    const file = writeSession([
      user("first"),
      assistant({ type: "text", text: "second" }),
    ]);
    writeFileSync(
      file,
      `${JSON.stringify(user("first"))}\nnot json\n${JSON.stringify(assistant({ type: "text", text: "second" }))}\n`,
      "utf8",
    );

    expect(faultOf(exportFixture)).toBe("malformed-record");
  });

  it("returns the id the records carry when it is the file's id", () => {
    writeSession([user("hello", { sessionId: OTHER_SESSION_ID })], {
      sessionId: OTHER_SESSION_ID,
    });

    expect(exportFixture().sessionId).toBe(OTHER_SESSION_ID);
  });

  it("refuses when the file name and the records disagree", () => {
    writeSession([user("hello")], { name: `${OTHER_SESSION_ID}.jsonl` });

    expect(faultOf(exportFixture)).toBe("malformed-record");
  });

  it("refuses records that name no session", () => {
    writeSession(
      [{ type: "user", message: { role: "user", content: "hello" } }],
      {
        name: `${OTHER_SESSION_ID}.jsonl`,
      },
    );

    expect(faultOf(exportFixture)).toBe("missing-session-id");
  });

  it("refuses a non-UUID session id", () => {
    writeSession([user("hello", { sessionId: "not-a-uuid" })], {
      name: `${OTHER_SESSION_ID}.jsonl`,
    });

    expect(faultOf(exportFixture)).toBe("malformed-record");
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

  it("refuses two UUID-named files instead of choosing one", () => {
    writeSession([user("first")]);
    writeSession([user("second")], { sessionId: OTHER_SESSION_ID });

    expect(faultOf(exportFixture)).toBe("ambiguous-session");
  });

  it("refuses a conversation record without a readable message", () => {
    writeSession([
      {
        type: "user",
        sessionId: SESSION_ID,
        message: { role: "user", content: 5 },
      },
    ]);

    expect(faultOf(exportFixture)).toBe("malformed-record");
  });

  it("fails an unknown session file with the unreadable-record fault", () => {
    expect(
      faultOf(() => readClaudeSession(join(configDir, "missing.jsonl"))),
    ).toBe("unreadable-record");
  });

  it("refuses a session with no prose after filtering", () => {
    writeSession([
      assistant({ type: "thinking", thinking: "only thinking" }),
      assistant({ type: "tool_use", id: "t", name: "Read", input: {} }),
    ]);

    expect(faultOf(exportFixture)).toBe("empty-session");
  });

  it("refuses an empty file", () => {
    writeSession([]);

    expect(faultOf(exportFixture)).toBe("empty-session");
  });

  it("reads the older 2.0.70 record shape", () => {
    writeSession([
      {
        parentUuid: null,
        isSidechain: false,
        userType: "external",
        cwd,
        sessionId: SESSION_ID,
        version: "2.0.70",
        type: "user",
        message: { role: "user", content: "older prompt" },
      },
      {
        parentUuid: "u1",
        isSidechain: false,
        cwd,
        sessionId: SESSION_ID,
        version: "2.0.70",
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "older answer" }],
        },
      },
    ]);

    expect(exportFixture()).toEqual({
      sessionId: SESSION_ID,
      session: "## User\n\nolder prompt\n\n## Assistant\n\nolder answer\n",
    });
  });
});

describe("claudeHarness.exportForHandover", () => {
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
    const dir = claudeProjectDir(hookConfigDir, hookCwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${SESSION_ID}.jsonl`),
      `${JSON.stringify(user("hook prompt"))}\n${JSON.stringify(assistant({ type: "text", text: "hook answer" }))}\n`,
    );

    const exported = await claudeHarness.exportForHandover?.({
      pi: {} as unknown as ExtensionAPI,
      subagentId: SUBAGENT_ID,
      paneId: "w1:p9",
      cwd: hookCwd,
    });

    expect(exported).toEqual({
      sessionId: SESSION_ID,
      session: "## User\n\nhook prompt\n\n## Assistant\n\nhook answer\n",
    });
  });
});
