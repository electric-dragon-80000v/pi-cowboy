/**
 * pi-export.test.ts — the pi family's session export without a real binary.
 *
 * The reader is the family's: pi, pig and pi-bolt write pi's format, so these
 * fixtures say nothing about a store — the file or the directory is handed in.
 * What a store decides is which directory a run's cwd resolves to, under which
 * names, so those rows are written once and run against each store, and the
 * rows only one store has (pig's root and its shared mode) stand alone. The
 * harnesses themselves are checked at the end: each id exports through its
 * store. One row is not a store's rule but the property every store must keep:
 * the values a child inherits resolve back to the directory the export reads.
 */

import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  RESERVED_ENV_VARS_BY_FAMILY,
  SessionExportError,
  type SessionExportFault,
} from "../src/agents/harness.js";
import { completeHandoverExport } from "../src/agents/handover.js";
import {
  findSessionFile,
  readHandoverRecordsOf,
  readSessionFile as readSessionRecords,
  sessionBucketName,
  type SessionStore,
} from "../src/agents/harness/pi-session.js";
import { piAgentDirectory, piStore } from "../src/agents/harness/pi-store.js";
import {
  pigAgentDirectory,
  pigConfigurationRoot,
  pigStore,
} from "../src/agents/harness/pig-store.js";
import { createHarnessRegistry } from "../src/agents/harness/harness-registry.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTmpDir(prefix = "pi-export-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const HEADER = {
  type: "session",
  version: 3,
  id: "01a16618-b2d0-7523-8666-48d3d798574b",
  timestamp: "2026-10-23T00:10:57.105Z",
  cwd: "/scrubbed/worktree",
};

function record(value: unknown): string {
  return JSON.stringify(value);
}

async function readSessionFile(file: string) {
  return completeHandoverExport(await readSessionRecords(file));
}

function user(...text: string[]): string {
  return record({
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-10-23T00:11:10.472Z",
    message: {
      role: "user",
      content: text.map((part) => ({ type: "text", text: part })),
    },
  });
}

function assistant(
  parts: readonly Record<string, unknown>[],
  id = "a1",
): string {
  return record({
    type: "message",
    id,
    parentId: "u1",
    timestamp: "2026-10-23T00:11:12.165Z",
    message: {
      role: "assistant",
      content: parts,
      api: "scrubbed",
      provider: "scrubbed",
      model: "scrubbed",
    },
  });
}

/** The `session_info` record the binary writes for the launcher's `--name`. */
function sessionInfo(name: string): string {
  return record({
    type: "session_info",
    id: "s1",
    parentId: null,
    timestamp: "2026-10-23T00:10:57.105Z",
    name,
  });
}

function text(value: string): Record<string, unknown> {
  return { type: "text", text: value };
}

async function writeSession(
  content: string,
  name = "2026-10-23T00-10-57-105Z_01a16618-b2d0-7523-8666-48d3d798574b.jsonl",
  dir?: string,
): Promise<string> {
  const root = dir ?? (await makeTmpDir());
  const file = join(root, name);
  await writeFile(file, content, "utf8");
  return file;
}

async function writeLines(
  lines: readonly string[],
  newlineAtEnd = true,
  name?: string,
): Promise<string> {
  const content = lines.join("\n") + (newlineAtEnd ? "\n" : "");
  return writeSession(content, name);
}

async function rejected(
  promise: Promise<unknown>,
): Promise<SessionExportError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SessionExportError) return error;
    throw error;
  }
  throw new Error("expected the export to fail");
}

function expectFault(error: SessionExportError, fault: SessionExportFault) {
  expect(error.fault).toBe(fault);
  expect(error.message).not.toBe("");
}

/** What a harness's export hook is handed: the run's own address. */
function exportRequest(subagentId: string) {
  return {
    pi: {} as unknown as ExtensionAPI,
    subagentId,
    paneId: "w1:p9",
    cwd: "/scrubbed/worktree",
  };
}

/** The directory name a store derives from a cwd, written out independently. */
function encodeCwd(cwd: string): string {
  const encoded = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return `--${encoded}--`;
}

/** One `settings.json`, in a directory that may not exist yet. */
async function writeSettings(
  dir: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "settings.json"), JSON.stringify(settings), "utf8");
}

/** One store's own spellings, so a shared row can be written once for both. */
interface StoreCase {
  readonly id: string;
  readonly store: SessionStore;
  /** The env name that moves this store's configuration root, where it has one. */
  readonly rootEnv?: string;
  /** The env name whose value is the whole sessions directory. */
  readonly sessionDirEnv: string;
  /** The env name that moves this store's agent directory. */
  readonly agentDirEnv: string;
  /** The project directory this store reads its own settings from. */
  readonly projectDir: string;
  /** Where a relative sessions-directory override resolves for this store. */
  readonly relativeOverride: (cwd: string) => string;
  /** What a child of this store is handed for the relative override `value`. */
  readonly inheritedRelative: (
    value: string,
  ) => Readonly<Record<string, string>>;
  /** The names reserved for this store, at whichever layer declares them. */
  readonly reservedNames: readonly string[];
  /** Store names this process sets, and what a child of this store inherits. */
  readonly inherited: Readonly<Record<string, string | undefined>>;
  readonly inheritedExpected: Readonly<Record<string, string>>;
}

const STORES: readonly StoreCase[] = [
  {
    id: "pi",
    store: piStore,
    sessionDirEnv: "PI_CODING_AGENT_SESSION_DIR",
    agentDirEnv: "PI_CODING_AGENT_DIR",
    projectDir: ".pi",
    // pi resolves the override against the process's own cwd.
    relativeOverride: () => resolve("relative-sessions"),
    inheritedRelative: (value) => ({
      ["PI_CODING_AGENT_SESSION_DIR"]: resolve(value),
    }),
    reservedNames: RESERVED_ENV_VARS_BY_FAMILY.pi,
    inherited: {
      PI_CODING_AGENT_DIR: "/var/agent",
      PI_CODING_AGENT_SESSION_DIR: "/var/sessions",
    },
    inheritedExpected: {
      PI_CODING_AGENT_DIR: "/var/agent",
      PI_CODING_AGENT_SESSION_DIR: "/var/sessions",
    },
  },
  {
    id: "pig",
    store: pigStore,
    rootEnv: "XDG_CONFIG_HOME",
    sessionDirEnv: "PIG_CODING_AGENT_SESSION_DIR",
    agentDirEnv: "PIG_CODING_AGENT_DIR",
    projectDir: ".pig",
    // pig resolves the override against the run's cwd.
    relativeOverride: (cwd) => join(cwd, "relative-sessions"),
    inheritedRelative: (value) => ({ ["PIG_CODING_AGENT_SESSION_DIR"]: value }),
    reservedNames: pigStore.reservedNames,
    inherited: {
      PIG_HOME: "/var/home",
      PIG_CODING_AGENT_DIR: "/var/agent",
      PIG_CODING_AGENT_SESSION_DIR: "/var/sessions",
    },
    inheritedExpected: {
      PIG_HOME: "/var/home",
      PIG_CODING_AGENT_DIR: "/var/agent",
      PIG_CODING_AGENT_SESSION_DIR: "/var/sessions",
    },
  },
];

const STORE_CASES = STORES.map((store) => [store.id, store] as const);

describe("session records", () => {
  it("renders user and assistant turns with the exact blank-line shape", async () => {
    const file = await writeLines([
      record(HEADER),
      sessionInfo("spawn-abc"),
      user("Fix the login flow."),
      assistant([text("Done.")]),
    ]);

    await expect(readSessionFile(file)).resolves.toEqual({
      sessionId: HEADER.id,
      session: "## User\n\nFix the login flow.\n\n## Assistant\n\nDone.\n",
    });
  });

  it("keeps only user and assistant text and drops every other record and part", async () => {
    const file = await writeLines([
      record(HEADER),
      record({
        type: "message",
        id: "s1",
        parentId: null,
        timestamp: "2026-10-23T00:11:00.000Z",
        message: {
          role: "system",
          content: "SYSTEM-PREAMBLE-MUST-GO",
        },
      }),
      user("question"),
      record({
        type: "message",
        id: "i1",
        parentId: "u1",
        timestamp: "2026-10-23T00:11:01.000Z",
        message: {
          role: "user",
          content: [
            text("with an image"),
            {
              type: "image",
              data: "IMAGE-DATA-MUST-GO",
              mimeType: "image/png",
            },
          ],
        },
      }),
      assistant([
        { type: "thinking", thinking: "THINKING-MUST-GO" },
        {
          type: "toolCall",
          name: "bash",
          arguments: { command: "TOOL-ARG-MUST-GO" },
        },
        text("answer"),
      ]),
      record({
        type: "message",
        id: "t1",
        parentId: "a1",
        timestamp: "2026-10-23T00:11:03.000Z",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "TOOL-RESULT-MUST-GO" }],
        },
      }),
      record({
        type: "message",
        id: "b1",
        parentId: "t1",
        timestamp: "2026-10-23T00:11:04.000Z",
        message: { role: "bashExecution", command: "BASH-MUST-GO" },
      }),
      record({
        type: "custom_message",
        id: "c1",
        parentId: "b1",
        timestamp: "2026-10-23T00:11:05.000Z",
        customType: "example",
        content: "CUSTOM-MESSAGE-MUST-GO",
        display: true,
      }),
      record({
        type: "custom",
        id: "c2",
        parentId: "c1",
        timestamp: "2026-10-23T00:11:05.500Z",
        customType: "example",
        data: "CUSTOM-STATE-MUST-GO",
      }),
      record({
        type: "compaction",
        id: "m1",
        parentId: "c2",
        timestamp: "2026-10-23T00:11:06.000Z",
        summary: "COMPACTION-MUST-GO",
        firstKeptEntryId: "u1",
        tokensBefore: 1,
      }),
      record({
        type: "branch_summary",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-10-23T00:11:07.000Z",
        summary: "BRANCH-SUMMARY-MUST-GO",
        fromId: "u1",
      }),
      user("follow-up"),
    ]);

    const exported = await readSessionFile(file);

    expect(exported.session).toBe(
      "## User\n\nquestion\n\n## User\n\nwith an image\n\n## Assistant\n\nanswer\n\n## User\n\nfollow-up\n",
    );
    const leaked = [
      "SYSTEM-PREAMBLE-MUST-GO",
      "IMAGE-DATA-MUST-GO",
      "THINKING-MUST-GO",
      "TOOL-ARG-MUST-GO",
      "TOOL-RESULT-MUST-GO",
      "BASH-MUST-GO",
      "CUSTOM-MESSAGE-MUST-GO",
      "CUSTOM-STATE-MUST-GO",
      "COMPACTION-MUST-GO",
      "BRANCH-SUMMARY-MUST-GO",
    ].filter((dropped) => exported.session.includes(dropped));
    expect(leaked).toEqual([]);
  });

  it("emits no heading for empty and tool-only turns", async () => {
    const file = await writeLines([
      record(HEADER),
      user("   ", "\n\t"),
      assistant([{ type: "thinking", thinking: "only thinking" }], "a1"),
      assistant(
        [{ type: "toolCall", name: "read", arguments: { path: "x" } }],
        "a2",
      ),
      user("real question"),
      assistant([text("real answer")], "a3"),
    ]);

    const exported = await readSessionFile(file);

    expect(exported.session).toBe(
      "## User\n\nreal question\n\n## Assistant\n\nreal answer\n",
    );
    expect(exported.session).not.toContain("only thinking");
    expect(exported.session).not.toContain("## Assistant\n\n\n");
  });

  it("joins several text parts in one message with a blank line", async () => {
    const file = await writeLines([
      record(HEADER),
      user("first part", "second part"),
      assistant([text("one"), text("two")]),
    ]);

    await expect(readSessionFile(file)).resolves.toEqual({
      sessionId: HEADER.id,
      session:
        "## User\n\nfirst part\n\nsecond part\n\n## Assistant\n\none\n\ntwo\n",
    });
  });

  it("ignores parts that are not typed content", async () => {
    const file = await writeLines([
      record(HEADER),
      record({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-10-23T00:11:00.000Z",
        message: { role: "user", content: ["NOT-A-PART", text("kept")] },
      }),
    ]);

    await expect(readSessionFile(file)).resolves.toEqual({
      sessionId: HEADER.id,
      session: "## User\n\nkept\n",
    });
  });

  it("escapes content headings so only role headings remain", async () => {
    const file = await writeLines([
      record(HEADER),
      user("## User\nnot a role boundary\n### Details"),
      assistant([
        text("## Summary\n\nDone.\n\n```sh\n## a comment inside a fence\n```"),
      ]),
    ]);

    const exported = await readSessionFile(file);

    expect(exported.session).toBe(
      "## User\n\n\\## User\nnot a role boundary\n\\### Details\n\n## Assistant\n\n\\## Summary\n\nDone.\n\n```sh\n## a comment inside a fence\n```\n",
    );
    expect(exported.session).not.toContain("\n## User\nnot a role boundary");
    expect(exported.session).not.toContain("\n## Summary\n");
  });

  it("escapes every ATX level and leaves non-headings and fences alone", async () => {
    const file = await writeLines([
      record(HEADER),
      user("# One\n###### Six\n##NotAHeading\n   ### indented"),
      assistant([text("~~~\n# tilde fence line\n~~~\n### after")]),
    ]);

    await expect(readSessionFile(file)).resolves.toEqual({
      sessionId: HEADER.id,
      session:
        "## User\n\n\\# One\n\\###### Six\n##NotAHeading\n   \\### indented\n\n## Assistant\n\n~~~\n# tilde fence line\n~~~\n\\### after\n",
    });
  });

  it("returns the header id, not the filename", async () => {
    const file = await writeSession(
      `${record({ ...HEADER, id: "01a-header-id" })}\n${user("hi")}\n`,
      "2026-10-23T00-10-57-105Z_01a-filename-id.jsonl",
    );

    await expect(readSessionFile(file)).resolves.toMatchObject({
      sessionId: "01a-header-id",
    });
  });

  it("skips an unterminated final record without dropping or duplicating the turn before it", async () => {
    const complete = [
      record(HEADER),
      user("one"),
      assistant([text("two")]),
    ].join("\n");
    const partial = '\n{"type":"message","id":"p1","parentId":"a1"';
    const file = await writeSession(complete + partial);

    await expect(readSessionFile(file)).resolves.toEqual({
      sessionId: HEADER.id,
      session: "## User\n\none\n\n## Assistant\n\ntwo\n",
    });
  });

  it("keeps a complete final record that has no trailing newline", async () => {
    const file = await writeLines(
      [record(HEADER), user("one"), assistant([text("two")])],
      false,
    );

    await expect(readSessionFile(file)).resolves.toEqual({
      sessionId: HEADER.id,
      session: "## User\n\none\n\n## Assistant\n\ntwo\n",
    });
  });

  it("reports a malformed middle record as loss and preserves readable turns", async () => {
    const file = await writeLines([
      record(HEADER),
      user("one"),
      "{not json",
      assistant([text("two")]),
    ]);

    await expect(readSessionFile(file)).resolves.toEqual({
      sessionId: HEADER.id,
      session: "## User\n\none\n\n## Assistant\n\ntwo\n",
      loss: { excluded: 1, total: 4 },
    });
  });

  it("fails a version newer than it understands", async () => {
    const file = await writeLines([
      record({ ...HEADER, version: 4 }),
      user("one"),
    ]);

    const error = await rejected(readSessionFile(file));
    expectFault(error, "unsupported-version");
    expect(error.message).toContain(file);
  });

  it("fails a version older than it reads, rather than reading it by current rules", async () => {
    const file = await writeLines([
      record({ ...HEADER, version: 2 }),
      user("one"),
    ]);

    const error = await rejected(readSessionFile(file));
    expectFault(error, "unsupported-version");
    expect(error.message).toContain(file);
  });

  it("fails a header with no version", async () => {
    const unversioned: Record<string, unknown> = { ...HEADER };
    delete unversioned.version;
    const file = await writeLines([record(unversioned), user("one")]);

    const error = await rejected(readSessionFile(file));
    expectFault(error, "malformed-record");
    expect(error.message).toContain(file);
  });

  it("fails a non-numeric version", async () => {
    const file = await writeLines([
      record({ ...HEADER, version: "3" }),
      user("one"),
    ]);

    const error = await rejected(readSessionFile(file));
    expectFault(error, "malformed-record");
    expect(error.message).toContain(file);
  });

  it("fails a record with no header", async () => {
    const file = await writeLines([user("one")]);

    const error = await rejected(readSessionFile(file));
    expectFault(error, "malformed-record");
    expect(error.message).toContain(file);
  });

  it("fails a header with no session id", async () => {
    const file = await writeLines([record({ ...HEADER, id: "" }), user("one")]);

    const error = await rejected(readSessionFile(file));
    expectFault(error, "missing-session-id");
    expect(error.message).toContain(file);
  });

  it("returns no turns for a session without conversation records", async () => {
    const file = await writeLines([
      record(HEADER),
      record({
        type: "message",
        id: "t1",
        parentId: null,
        timestamp: "2026-10-23T00:11:00.000Z",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "tool only" }],
        },
      }),
    ]);

    await expect(readSessionFile(file)).resolves.toEqual({
      sessionId: HEADER.id,
      session: "",
    });
  });

  it("reports unusable message content as loss", async () => {
    const file = await writeLines([
      record(HEADER),
      record({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-10-23T00:11:00.000Z",
        message: { role: "user", content: 42 },
      }),
    ]);

    await expect(readSessionFile(file)).resolves.toEqual({
      sessionId: HEADER.id,
      session: "",
      loss: { excluded: 1, total: 2 },
    });
  });

  it("reports a bare-string turn as loss", async () => {
    const file = await writeLines([
      record(HEADER),
      record({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-10-23T00:11:00.000Z",
        message: { role: "user", content: "bare string" },
      }),
    ]);

    await expect(readSessionFile(file)).resolves.toEqual({
      sessionId: HEADER.id,
      session: "",
      loss: { excluded: 1, total: 2 },
    });
  });

  it("fails an unreadable file with a typed error", async () => {
    const dir = await makeTmpDir();
    const missing = join(dir, "missing.jsonl");

    const error = await rejected(readSessionFile(missing));
    expectFault(error, "unreadable-record");
    expect(error.message).toContain(missing);
  });
});

describe("findSessionFile", () => {
  it("finds the file whose latest session_info names the run, ignoring newer decoys", async () => {
    const dir = await makeTmpDir();

    await writeFile(
      join(dir, "newer-unrelated.jsonl"),
      `${record({ ...HEADER, id: "01a-unrelated" })}\n${sessionInfo("someone-else")}\n${user("not ours")}\n`,
      "utf8",
    );
    const wanted = join(dir, "older-wanted.jsonl");
    await writeFile(
      wanted,
      `${record({ ...HEADER, id: "01a-wanted" })}\n${sessionInfo("spawn-abc")}\n${user("ours")}\n`,
      "utf8",
    );

    await expect(
      findSessionFile(dir, "spawn-abc", "/scrubbed/worktree"),
    ).resolves.toBe(wanted);
    await expect(readSessionFile(wanted)).resolves.toMatchObject({
      sessionId: "01a-wanted",
    });
  });

  it("uses the latest session_info name, not the first", async () => {
    const dir = await makeTmpDir();
    const file = join(dir, "renamed.jsonl");
    await writeFile(
      file,
      `${record(HEADER)}\n${sessionInfo("old-name")}\n${sessionInfo("spawn-abc")}\n${user("hi")}\n`,
      "utf8",
    );

    await expect(
      findSessionFile(dir, "spawn-abc", "/scrubbed/worktree"),
    ).resolves.toBe(file);
    await expect(
      findSessionFile(dir, "old-name", "/scrubbed/worktree"),
    ).rejects.toMatchObject({ fault: "session-not-found" });
  });

  it("refuses when no file names the subagent", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      join(dir, "other.jsonl"),
      `${record(HEADER)}\n${sessionInfo("someone-else")}\n${user("hi")}\n`,
      "utf8",
    );

    await expect(
      findSessionFile(dir, "spawn-abc", "/scrubbed/worktree"),
    ).rejects.toMatchObject({ fault: "session-not-found" });
  });

  it("refuses two files claiming the id, naming both instead of choosing one", async () => {
    const dir = await makeTmpDir();
    for (const name of ["one.jsonl", "two.jsonl"]) {
      await writeFile(
        join(dir, name),
        `${record(HEADER)}\n${sessionInfo("spawn-abc")}\n${user("hi")}\n`,
        "utf8",
      );
    }

    const error = await rejected(
      findSessionFile(dir, "spawn-abc", "/scrubbed/worktree"),
    );
    expectFault(error, "ambiguous-session");
    expect(error.message).toContain("one.jsonl");
    expect(error.message).toContain("two.jsonl");
  });

  it("refuses a missing directory with the directory and the cwd named, creating nothing", async () => {
    const dir = await makeTmpDir();
    const absent = join(dir, "nested", "sessions");

    const error = await rejected(
      findSessionFile(absent, "spawn-abc", "/scrubbed/worktree"),
    );
    expectFault(error, "session-not-found");
    expect(error.message).toContain(absent);
    expect(error.message).toContain("/scrubbed/worktree");
    expect(
      await realpath(absent).then(
        () => "exists",
        () => "absent",
      ),
    ).toBe("absent");
  });
});

describe("the family's export", () => {
  it.each(STORE_CASES)(
    "%s: resolves the run's directory from the request and exports its file",
    async (id, storeCase) => {
      const dir = await makeTmpDir(`${id}-export-`);
      await writeFile(
        join(dir, "run.jsonl"),
        [
          record(HEADER),
          sessionInfo("spawn-abc"),
          user("hand this on"),
          assistant([text("done")]),
        ].join("\n") + "\n",
        "utf8",
      );
      vi.stubEnv(storeCase.sessionDirEnv, dir);

      const source = await readHandoverRecordsOf(storeCase.store)(
        exportRequest("spawn-abc"),
      );
      expect(source.sessionId).toBe(HEADER.id);
      expect([...source.records]).toEqual([
        { kind: "dont-export", content: record(HEADER) },
        { kind: "dont-export", content: sessionInfo("spawn-abc") },
        { kind: "export", turn: { role: "User", text: "hand this on" } },
        { kind: "export", turn: { role: "Assistant", text: "done" } },
      ]);
    },
  );

  it.each(STORE_CASES)(
    "%s: refuses a request whose run named no file",
    async (id, storeCase) => {
      const dir = await makeTmpDir(`${id}-export-`);
      vi.stubEnv(storeCase.sessionDirEnv, dir);

      await expect(
        readHandoverRecordsOf(storeCase.store)(exportRequest("spawn-abc")),
      ).rejects.toMatchObject({ fault: "session-not-found" });
    },
  );

  /** One run's store, keyed the way the family's launch keys it. */
  async function storeHoldingRun(
    sessionDirEnv: string,
  ): Promise<Record<string, string>> {
    const dir = await makeTmpDir("family-export-");
    await writeFile(
      join(dir, "run.jsonl"),
      [
        record(HEADER),
        sessionInfo("spawn-abc"),
        user("hand this on"),
        assistant([text("done")]),
      ].join("\n") + "\n",
      "utf8",
    );
    return { [sessionDirEnv]: dir };
  }

  it.each(["pi", "pi-bolt"] as const)(
    "%s exports from pi's store",
    async (id) => {
      const env = await storeHoldingRun("PI_CODING_AGENT_SESSION_DIR");
      vi.stubEnv(
        "PI_CODING_AGENT_SESSION_DIR",
        env.PI_CODING_AGENT_SESSION_DIR!,
      );
      const harness = createHarnessRegistry().require(id);

      await expect(
        harness.readHandoverRecords!(exportRequest("spawn-abc")),
      ).resolves.toMatchObject({ sessionId: HEADER.id });
    },
  );

  it("pig exports from its own store, and not from pi's names in default mode", async () => {
    const env = await storeHoldingRun("PIG_CODING_AGENT_SESSION_DIR");
    vi.stubEnv(
      "PIG_CODING_AGENT_SESSION_DIR",
      env.PIG_CODING_AGENT_SESSION_DIR!,
    );
    const harness = createHarnessRegistry().require("pig");

    await expect(
      harness.readHandoverRecords!(exportRequest("spawn-abc")),
    ).resolves.toMatchObject({ sessionId: HEADER.id });

    // The same directory, named through pi's variable: pig reads its own in
    // default mode, so this run is not what its export looks for.
    delete process.env.PIG_CODING_AGENT_SESSION_DIR;
    vi.stubEnv(
      "PI_CODING_AGENT_SESSION_DIR",
      env.PIG_CODING_AGENT_SESSION_DIR!,
    );
    const pigHarness = createHarnessRegistry().require("pig");
    await expect(
      pigHarness.readHandoverRecords!(exportRequest("spawn-abc")),
    ).rejects.toMatchObject({ fault: "session-not-found" });
  });
});

describe("the session bucket name", () => {
  it("encodes the absolute cwd the way the family does", () => {
    expect(sessionBucketName("/Users/example/work")).toBe(
      "--Users-example-work--",
    );
    expect(sessionBucketName("/Volumes/a:b/c")).toBe("--Volumes-a-b-c--");
  });

  it("keys a symlinked cwd by the directory the kernel reports", async () => {
    const root = await makeTmpDir();
    const target = join(root, "physical");
    await mkdir(target);
    const link = join(root, "through-a-link");
    await symlink(target, link);

    expect(sessionBucketName(link)).toBe(encodeCwd(await realpath(target)));
    expect(sessionBucketName(link)).not.toBe(encodeCwd(link));
  });
});

describe("store directories", () => {
  it.each(STORE_CASES)(
    "%s: uses the agent dir its own env var names, with the bucket under it",
    async (id, storeCase) => {
      const cwd = await makeTmpDir(`${id}-cwd-`);
      const agent = await makeTmpDir(`${id}-agent-`);

      expect(
        await storeCase.store.sessionDir(cwd, {
          [storeCase.agentDirEnv]: agent,
        }),
      ).toBe(join(agent, "sessions", sessionBucketName(cwd)));
    },
  );

  it.each(STORE_CASES)(
    "%s: takes the session env var as the whole directory",
    async (id, storeCase) => {
      const cwd = await makeTmpDir(`${id}-cwd-`);
      const dir = await makeTmpDir(`${id}-override-`);

      expect(
        await storeCase.store.sessionDir(cwd, {
          [storeCase.sessionDirEnv]: dir,
        }),
      ).toBe(dir);
    },
  );

  it.each(STORE_CASES)(
    "%s: resolves a relative session env var the way its own binary does",
    async (id, storeCase) => {
      const cwd = await makeTmpDir(`${id}-cwd-`);

      expect(
        await storeCase.store.sessionDir(cwd, {
          [storeCase.sessionDirEnv]: "relative-sessions",
        }),
      ).toBe(storeCase.relativeOverride(cwd));
    },
  );

  it.each(STORE_CASES)(
    "%s: reads the project's sessionDir over the global one, resolved against the run's cwd",
    async (id, storeCase) => {
      const cwd = await makeTmpDir(`${id}-cwd-`);
      const agent = await makeTmpDir(`${id}-agent-`);
      await writeSettings(cwd, {});
      await writeSettings(join(cwd, storeCase.projectDir), {
        sessionDir: "local-sessions",
      });
      await writeSettings(agent, { sessionDir: "/global/sessions" });

      expect(
        await storeCase.store.sessionDir(cwd, {
          [storeCase.agentDirEnv]: agent,
        }),
      ).toBe(join(cwd, "local-sessions"));
    },
  );

  it.each(STORE_CASES)(
    "%s: falls back to the global sessionDir, resolved against the run's cwd",
    async (id, storeCase) => {
      const cwd = await makeTmpDir(`${id}-cwd-`);
      const agent = await makeTmpDir(`${id}-agent-`);
      await writeSettings(agent, { sessionDir: "global-sessions" });

      expect(
        await storeCase.store.sessionDir(cwd, {
          [storeCase.agentDirEnv]: agent,
        }),
      ).toBe(join(cwd, "global-sessions"));
    },
  );

  it.each(STORE_CASES)(
    "%s: lets the session env var beat a configured sessionDir",
    async (id, storeCase) => {
      const cwd = await makeTmpDir(`${id}-cwd-`);
      const agent = await makeTmpDir(`${id}-agent-`);
      const dir = await makeTmpDir(`${id}-override-`);
      await writeSettings(agent, { sessionDir: "/global/sessions" });

      expect(
        await storeCase.store.sessionDir(cwd, {
          [storeCase.agentDirEnv]: agent,
          [storeCase.sessionDirEnv]: dir,
        }),
      ).toBe(dir);
    },
  );

  it("pi's default agent dir is pi's own, from the variable or the home", () => {
    expect(piAgentDirectory({})).toBe(join(homedir(), ".pi", "agent"));
    expect(piAgentDirectory({ PI_CODING_AGENT_DIR: "/var/agent" })).toBe(
      "/var/agent",
    );
    // pi reads a `~` in that variable as the home, as its own resolver does.
    expect(piAgentDirectory({ PI_CODING_AGENT_DIR: "~/elsewhere" })).toBe(
      join(homedir(), "elsewhere"),
    );
  });

  it("pig's root moves with PIG_HOME, and its agent dir with PIG_CODING_AGENT_DIR", async () => {
    const cwd = await makeTmpDir("pig-cwd-");
    const home = await makeTmpDir("pig-home-");
    const agent = await makeTmpDir("pig-agent-");

    expect(pigConfigurationRoot({})).toBe(join(homedir(), ".pig"));
    expect(pigConfigurationRoot({ PIG_HOME: home })).toBe(home);
    expect(await pigStore.sessionDir(cwd, { PIG_HOME: home })).toBe(
      join(home, "agent", "sessions", sessionBucketName(cwd)),
    );
    expect(
      await pigStore.sessionDir(cwd, {
        PIG_HOME: home,
        PIG_CODING_AGENT_DIR: agent,
      }),
    ).toBe(join(agent, "sessions", sessionBucketName(cwd)));
  });

  it("pig's root moves with XDG_CONFIG_HOME when PIG_HOME is unset", async () => {
    const cwd = await makeTmpDir("pig-cwd-");
    const xdg = await makeTmpDir("pig-xdg-");

    expect(await pigStore.sessionDir(cwd, { XDG_CONFIG_HOME: xdg })).toBe(
      join(xdg, "pig", "agent", "sessions", sessionBucketName(cwd)),
    );
  });

  it("pig reads pi's directories in shared mode", async () => {
    const cwd = await makeTmpDir("pig-cwd-");
    const piAgent = await makeTmpDir("pi-agent-");
    const explicit = await makeTmpDir("pi-sessions-");

    expect(
      await pigStore.sessionDir(cwd, {
        PIG_USE_PI_DIRS: "1",
        PI_CODING_AGENT_DIR: piAgent,
      }),
    ).toBe(join(piAgent, "sessions", sessionBucketName(cwd)));
    expect(
      await pigStore.sessionDir(cwd, {
        PIG_USE_PI_DIRS: "1",
        PI_CODING_AGENT_SESSION_DIR: explicit,
      }),
    ).toBe(explicit);
  });

  it("pig ignores its own directory variables in shared mode", async () => {
    const cwd = await makeTmpDir("pig-cwd-");
    const piAgent = await makeTmpDir("pi-agent-");
    const pigAgent = await makeTmpDir("pig-agent-");

    expect(
      await pigStore.sessionDir(cwd, {
        PIG_USE_PI_DIRS: "1",
        PIG_CODING_AGENT_DIR: pigAgent,
        PI_CODING_AGENT_DIR: piAgent,
      }),
    ).toBe(join(piAgent, "sessions", sessionBucketName(cwd)));
  });

  it.each(["true", "yes", "0", ""] as const)(
    "pig keeps its own directories for PIG_USE_PI_DIRS=%o",
    async (value) => {
      const cwd = await makeTmpDir("pig-cwd-");
      const pigAgent = await makeTmpDir("pig-agent-");
      const piAgent = await makeTmpDir("pi-agent-");

      expect(
        await pigStore.sessionDir(cwd, {
          PIG_CODING_AGENT_DIR: pigAgent,
          PI_CODING_AGENT_DIR: piAgent,
          PIG_USE_PI_DIRS: value,
        }),
      ).toBe(join(pigAgent, "sessions", sessionBucketName(cwd)));
    },
  );

  it("pig reads pi's directories for the exact value `1`", async () => {
    const cwd = await makeTmpDir("pig-cwd-");
    const pigAgent = await makeTmpDir("pig-agent-");
    const piAgent = await makeTmpDir("pi-agent-");

    expect(
      await pigStore.sessionDir(cwd, {
        PIG_CODING_AGENT_DIR: pigAgent,
        PI_CODING_AGENT_DIR: piAgent,
        PIG_USE_PI_DIRS: "1",
      }),
    ).toBe(join(piAgent, "sessions", sessionBucketName(cwd)));
  });

  it("pig expands a `~` in its own agent dir", () => {
    // Probed: PIG_CODING_AGENT_DIR='~/pig-agent' writes under
    // $HOME/pig-agent/sessions/.
    expect(pigAgentDirectory({ PIG_CODING_AGENT_DIR: "~/elsewhere" })).toBe(
      join(homedir(), "elsewhere"),
    );
    expect(pigConfigurationRoot({ PIG_HOME: "~/pig-home" })).toBe(
      join(homedir(), "pig-home"),
    );
  });
});

describe("inherited store variables", () => {
  it.each(STORE_CASES)(
    "%s: carries every store name this process sets, absolute",
    async (_id, storeCase) => {
      expect(storeCase.store.inheritedEnv({ ...storeCase.inherited })).toEqual(
        storeCase.inheritedExpected,
      );
    },
  );

  it.each(STORE_CASES)(
    "%s: moves nothing for an unset or empty value",
    async (_id, storeCase) => {
      expect(
        storeCase.store.inheritedEnv({
          [storeCase.agentDirEnv]: "",
          [storeCase.sessionDirEnv]: "   ",
        }),
      ).toEqual({});
    },
  );

  it.each(STORE_CASES)(
    "%s: hands a relative session override over as the export resolves it",
    async (_id, storeCase) => {
      const value = "store/sessions";

      expect(
        storeCase.store.inheritedEnv({ [storeCase.sessionDirEnv]: value }),
      ).toEqual(storeCase.inheritedRelative(value));
    },
  );

  it.each(STORE_CASES)(
    "%s: carries only names its own harness reserves",
    async (_id, storeCase) => {
      const inherited = Object.keys(
        storeCase.store.inheritedEnv({
          ...storeCase.inherited,
          [storeCase.sessionDirEnv]: "/var/sessions",
        }),
      );

      expect(inherited.length).toBeGreaterThan(0);
      expect(storeCase.reservedNames).toEqual(
        expect.arrayContaining(inherited),
      );
    },
  );

  it("pig carries its mode flag, and pi's names when it selects them", () => {
    // The mode decides which directories the child resolves, and in shared mode
    // the names it reads are pi's — pig's own do not move the store there.
    expect(
      pigStore.inheritedEnv({
        PIG_USE_PI_DIRS: "1",
        PIG_HOME: "/var/home",
        PI_CODING_AGENT_DIR: "/var/agent",
        PI_CODING_AGENT_SESSION_DIR: "/var/sessions",
      }),
    ).toEqual({
      PIG_USE_PI_DIRS: "1",
      PI_CODING_AGENT_DIR: "/var/agent",
      PI_CODING_AGENT_SESSION_DIR: "/var/sessions",
    });
  });

  it("pig's agent dir is handed over as the export resolves it", () => {
    expect(
      pigStore.inheritedEnv({ PIG_CODING_AGENT_DIR: "~/elsewhere" }),
    ).toEqual({ PIG_CODING_AGENT_DIR: join(homedir(), "elsewhere") });
    expect(
      pigStore.inheritedEnv({ PIG_CODING_AGENT_DIR: "relative-agent" }),
    ).toEqual({ PIG_CODING_AGENT_DIR: resolve("relative-agent") });
  });

  it("pig hands over the root that answered, and only that one", () => {
    expect(pigStore.inheritedEnv({ XDG_CONFIG_HOME: "relative-xdg" })).toEqual({
      XDG_CONFIG_HOME: resolve("relative-xdg"),
    });
    expect(
      pigStore.inheritedEnv({
        PIG_HOME: "/var/home",
        XDG_CONFIG_HOME: "/var/xdg",
      }),
    ).toEqual({ PIG_HOME: "/var/home" });
  });
});

/**
 * The values a launch may carry for one of a store's names. A child is handed
 * the environment of a process whose cwd is not the run's, so a value that
 * survives the hand-over only by accident of the two cwds agreeing is what the
 * rows below are for.
 */
const INHERITED_VALUES: readonly string[] = [
  "a-relative-store",
  "~/a-home-store",
  "/an/absolute/store",
];

const INHERITED_CASES = STORES.flatMap((store) =>
  [store.rootEnv, store.agentDirEnv, store.sessionDirEnv]
    .filter((name): name is string => name !== undefined)
    .flatMap((name) =>
      INHERITED_VALUES.map(
        (value) =>
          [`${store.id}: ${name}=${value}`, store, name, value] as const,
      ),
    ),
);

describe("the store a child inherits", () => {
  it.each(INHERITED_CASES)(
    "%s resolves back to the directory the export reads",
    async (_label, storeCase, name, value) => {
      const cwd = await makeTmpDir(`${storeCase.id}-cwd-`);
      const env = { [name]: value };

      expect(
        resolve(
          await storeCase.store.sessionDir(
            cwd,
            storeCase.store.inheritedEnv(env),
          ),
        ),
      ).toBe(resolve(await storeCase.store.sessionDir(cwd, env)));
    },
  );
});
