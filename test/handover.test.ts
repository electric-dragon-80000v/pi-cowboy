/**
 * handover.test.ts — the handover vocabulary: task markers, shared record
 * completion, and failure boundaries before a source run is stopped.
 */

import { describe, expect, it } from "vitest";
import {
  completeHandoverExport,
  exportRunSession,
  handoverSeverity,
  parseHandoverMarker,
  renderHandoverMarker,
  renderHandoverTask,
  type HandoverFault,
  type HandoverOutcome,
} from "../src/agents/handover.js";
import type { HarnessRegistry } from "../src/agents/harness/harness-registry.js";
import {
  SessionExportError,
  readHandoverRecord,
  type AnyHarnessId,
  type HandoverRecord,
  type HandoverRecordSource,
  type ReadHandoverRecords,
} from "../src/agents/harness.js";

const POLICY = { maxExcludedRatio: 0.5 };

function source(
  records: HandoverRecordSource["records"],
  sessionId = "ses_1",
): HandoverRecordSource {
  return { sessionId, records };
}

describe("renderHandoverTask", () => {
  it("names the task, the harness, the session id, and quotes the session", () => {
    const task = renderHandoverTask({
      taskSlug: "fix-login-flow",
      sourceName: "OpenCode",
      previous: [],
      current: { harness: "opencode", sessionId: "ses_abc" },
      session: "user: fix the login\nassistant: done",
    });

    expect(task).toContain(
      'You are continuing work on task "fix-login-flow" in this workspace.',
    );
    expect(task).toContain(
      "previously handled by another agent harness (OpenCode)",
    );
    expect(task).toContain('The previous run\'s session id is "ses_abc".');
    expect(task.trimEnd().endsWith("assistant: done")).toBe(true);
  });

  it("marks the boundary with the whole chain, oldest first", () => {
    const task = renderHandoverTask({
      taskSlug: "fix-login-flow",
      sourceName: "Codex",
      previous: [
        { harness: "claude", sessionId: "ses_first" },
        { harness: "opencode", sessionId: "ses_second" },
      ],
      current: { harness: "codex", sessionId: "ses_third" },
      session: "user: continue",
    });

    expect(parseHandoverMarker(task)).toEqual([
      { harness: "claude", sessionId: "ses_first" },
      { harness: "opencode", sessionId: "ses_second" },
      { harness: "codex", sessionId: "ses_third" },
    ]);
  });
});

describe("parseHandoverMarker", () => {
  it("reads back what the renderer wrote", () => {
    const chain = [
      { harness: "claude", sessionId: "ses_a" },
      { harness: "codex", sessionId: "ses_b" },
    ] as const;

    expect(parseHandoverMarker(renderHandoverMarker(chain))).toEqual(chain);
  });

  it("reads the outermost marker when an older one sits inside the quote", () => {
    const text = [
      renderHandoverMarker([{ harness: "codex", sessionId: "ses_new" }]),
      renderHandoverMarker([{ harness: "claude", sessionId: "ses_old" }]),
    ].join("\n");

    expect(parseHandoverMarker(text)).toEqual([
      { harness: "codex", sessionId: "ses_new" },
    ]);
  });
});

describe("completeHandoverExport", () => {
  it("renders user and assistant records as turns and counts every yielded source record", () => {
    expect(
      completeHandoverExport(
        source([
          { kind: "user", content: "first" },
          {
            kind: "other",
            unmappedKind: "session_info",
            content: "a readable native entry",
          },
          { kind: "unparseable", content: "{broken" },
          { kind: "assistant", content: "second" },
        ]),
      ),
    ).toEqual({
      sessionId: "ses_1",
      session: "## User\n\nfirst\n\n## Assistant\n\nsecond\n",
      loss: { excluded: 1, total: 4 },
    });
  });

  it("excludes thinking, tool calls, and other native records without counting them as loss", () => {
    const exported = completeHandoverExport(
      source([
        { kind: "user", content: "question" },
        { kind: "thinking", content: "reasoning that must stay out" },
        { kind: "tool-call", content: '{"name":"read"}' },
        {
          kind: "other",
          unmappedKind: "branch_summary",
          content: "native entry that must stay out",
        },
        { kind: "assistant", content: "answer" },
      ]),
    );

    expect(exported.session).toBe(
      "## User\n\nquestion\n\n## Assistant\n\nanswer\n",
    );
    expect(exported.loss).toBeUndefined();
    expect(exported.session).not.toContain("must stay out");
  });

  it("renders each record before the next is produced, in one pass", () => {
    const readOrder: string[] = [];
    const pulls: number[] = [];
    let nextCalls = 0;
    const texts = ["first", "second", "third"];

    function* streamed(): Generator<HandoverRecord> {
      for (let index = 0; index < texts.length; index += 1) {
        const text = texts[index]!;
        const read = () => {
          readOrder.push(text);
          return text;
        };
        pulls.push(readOrder.length);
        yield index === 0
          ? {
              kind: "user",
              get content() {
                return read();
              },
            }
          : {
              kind: "assistant",
              get content() {
                return read();
              },
            };
      }
    }

    function* counted(): Generator<HandoverRecord> {
      const inner = streamed();
      for (;;) {
        nextCalls += 1;
        const step = inner.next();
        if (step.done) return;
        yield step.value;
      }
    }

    const exported = completeHandoverExport({
      sessionId: "ses_1",
      records: counted(),
    });

    expect(nextCalls).toBe(texts.length + 1);
    expect(pulls).toEqual([0, 1, 2]);
    expect(readOrder).toEqual(texts);
    expect(exported).toEqual({
      sessionId: "ses_1",
      session:
        "## User\n\nfirst\n\n## Assistant\n\nsecond\n\n## Assistant\n\nthird\n",
    });
  });

  it("escapes content headings but leaves fenced code literal", () => {
    expect(
      completeHandoverExport(
        source([
          {
            kind: "assistant",
            content: "# heading\n```md\n# literal\n```",
          },
        ]),
      ).session,
    ).toBe("## Assistant\n\n\\# heading\n```md\n# literal\n```\n");
  });

  it("does not expose excluded or unparseable content in the session", () => {
    const exported = completeHandoverExport(
      source([
        { kind: "thinking", content: "private reasoning" },
        { kind: "unparseable", content: "broken private record" },
      ]),
    );

    expect(exported.session).toBe("");
    expect(exported.loss).toEqual({ excluded: 1, total: 2 });
  });

  it("renders every turn when the source has no compaction", () => {
    const exported = completeHandoverExport(
      source([
        { kind: "user", content: "first" },
        { kind: "tool-call", content: "tool result" },
        { kind: "assistant", content: "second" },
      ]),
    );

    expect(exported.session).toBe(
      "## User\n\nfirst\n\n## Assistant\n\nsecond\n",
    );
    expect(exported.loss).toBeUndefined();
  });

  it("starts the transcript at the one compaction summary", () => {
    const exported = completeHandoverExport(
      source([
        { kind: "user", content: "old" },
        { kind: "unparseable", content: "{broken" },
        { kind: "compaction", content: "summary A" },
        { kind: "assistant", content: "after A" },
      ]),
    );

    expect(exported.session).toBe(
      "## Compaction\n\nsummary A\n\n## Assistant\n\nafter A\n",
    );
    expect(exported.loss).toBeUndefined();
  });

  it("keeps only the latest compaction summary and what follows it", () => {
    const exported = completeHandoverExport(
      source([
        { kind: "user", content: "old" },
        { kind: "unparseable", content: "{broken" },
        { kind: "compaction", content: "summary A" },
        { kind: "assistant", content: "after A" },
        { kind: "tool-call", content: "tool result" },
        { kind: "compaction", content: "summary B" },
        { kind: "user", content: "after B" },
      ]),
    );

    expect(exported.session).toBe(
      "## Compaction\n\nsummary B\n\n## User\n\nafter B\n",
    );
    expect(exported.loss).toBeUndefined();
  });

  it("counts only retained records toward loss", () => {
    const exported = completeHandoverExport(
      source([
        { kind: "unparseable", content: "{broken older" },
        {
          kind: "other",
          unmappedKind: "session_info",
          content: "older tool result",
        },
        { kind: "compaction", content: "summary" },
        { kind: "unparseable", content: "{broken retained" },
        { kind: "assistant", content: "after" },
      ]),
    );

    expect(exported.session).toBe(
      "## Compaction\n\nsummary\n\n## Assistant\n\nafter\n",
    );
    expect(exported.loss).toEqual({ excluded: 1, total: 3 });
  });

  it("does not start the transcript at a compaction with a blank summary", () => {
    const exported = completeHandoverExport(
      source([
        { kind: "user", content: "before" },
        { kind: "compaction", content: "   " },
        { kind: "assistant", content: "after" },
      ]),
    );

    expect(exported.session).toBe(
      "## User\n\nbefore\n\n## Assistant\n\nafter\n",
    );
    expect(exported.loss).toBeUndefined();
  });

  it("escapes headings inside a compaction summary", () => {
    const exported = completeHandoverExport(
      source([{ kind: "compaction", content: "# not a user turn" }]),
    );

    expect(exported.session).toBe("## Compaction\n\n\\# not a user turn\n");
    expect(exported.loss).toBeUndefined();
  });
});

describe("readHandoverRecord", () => {
  it("keeps a record the vocabulary knows as it is", () => {
    const record: HandoverRecord = {
      kind: "other",
      unmappedKind: "session_meta",
      content: "{}",
    };

    expect(readHandoverRecord(record)).toEqual(record);
  });

  it("counts a record whose kind it does not know as loss", () => {
    const stale = { kind: "export", content: "hi" };

    expect(readHandoverRecord(stale)).toEqual({
      kind: "unparseable",
      content: JSON.stringify(stale),
    });
  });

  it("counts an other record with no native type as loss", () => {
    const malformed = { kind: "other", content: "hi" };

    expect(readHandoverRecord(malformed)).toEqual({
      kind: "unparseable",
      content: JSON.stringify(malformed),
    });
  });
});

describe("handoverSeverity", () => {
  const faulted = (fault: HandoverFault): HandoverOutcome => ({
    kind: "faulted",
    fault,
  });

  it("marks a complete handover with loss as a warning", () => {
    expect(
      handoverSeverity({
        kind: "handed-over",
        from: "codex",
        to: "pi",
        loss: { excluded: 1, total: 4 },
      }),
    ).toBe("warning");
  });

  it("marks a complete handover without loss as success", () => {
    expect(
      handoverSeverity({ kind: "handed-over", from: "pi", to: "claude" }),
    ).toBe("success");
  });

  it("marks export failures as errors", () => {
    expect(
      handoverSeverity(
        faulted({
          kind: "session-export-failed",
          harness: "pi",
          detail: "no file",
        }),
      ),
    ).toBe("error");
  });
});

describe("exportRunSession", () => {
  const request = {
    pi: {} as never,
    subagentId: "session-1",
    paneId: "w1:p1",
    cwd: "/repo",
  };

  function registryWith(harness: {
    readonly id: AnyHarnessId;
    readonly readHandoverRecords?: ReadHandoverRecords;
  }): HarnessRegistry {
    return {
      get: (id: AnyHarnessId) => (id === harness.id ? harness : undefined),
    } as unknown as HarnessRegistry;
  }

  it("renders the harness's classified records", async () => {
    await expect(
      exportRunSession(
        registryWith({
          id: "claude",
          readHandoverRecords: async () =>
            source([{ kind: "user", content: "hi" }]),
        }),
        "claude",
        request,
        POLICY,
      ),
    ).resolves.toEqual({
      kind: "exported",
      sessionId: "ses_1",
      session: "## User\n\nhi\n",
    });
  });

  it("refuses a harness that cannot read its session records", async () => {
    await expect(
      exportRunSession(registryWith({ id: "pi" }), "pi", request, POLICY),
    ).resolves.toEqual({
      kind: "faulted",
      fault: { kind: "harness-cannot-export-session", harness: "pi" },
    });
  });

  it("preserves a reader's typed fault and detail", async () => {
    await expect(
      exportRunSession(
        registryWith({
          id: "claude",
          readHandoverRecords: async () => {
            throw new SessionExportError(
              "session-not-found",
              "no session file",
            );
          },
        }),
        "claude",
        request,
        POLICY,
      ),
    ).resolves.toMatchObject({
      kind: "faulted",
      fault: {
        kind: "session-export-failed",
        detail: "no session file",
        exportFault: "session-not-found",
      },
    });
  });

  it("refuses loss over the configured share before calling the session empty", async () => {
    await expect(
      exportRunSession(
        registryWith({
          id: "codex",
          readHandoverRecords: async () =>
            source([
              { kind: "unparseable", content: "bad one" },
              { kind: "unparseable", content: "bad two" },
              {
                kind: "other",
                unmappedKind: "session_info",
                content: "valid but omitted",
              },
            ]),
        }),
        "codex",
        request,
        POLICY,
      ),
    ).resolves.toMatchObject({
      kind: "faulted",
      fault: {
        kind: "session-export-failed",
        detail:
          "2 of 3 session records could not be read — 67%, over the 50% limit set by agent.handoverMaxExcludedRatio",
      },
    });
  });

  it("keeps loss exactly at the configured share and reports it", async () => {
    await expect(
      exportRunSession(
        registryWith({
          id: "codex",
          readHandoverRecords: async () =>
            source([
              { kind: "user", content: "keep" },
              { kind: "unparseable", content: "bad" },
            ]),
        }),
        "codex",
        request,
        POLICY,
      ),
    ).resolves.toEqual({
      kind: "exported",
      sessionId: "ses_1",
      session: "## User\n\nkeep\n",
      loss: { excluded: 1, total: 2 },
    });
  });

  it("treats a source with nothing exportable as an empty session", async () => {
    await expect(
      exportRunSession(
        registryWith({
          id: "codex",
          readHandoverRecords: async () =>
            source([{ kind: "tool-call", content: "tool-only message" }]),
        }),
        "codex",
        request,
        POLICY,
      ),
    ).resolves.toEqual({
      kind: "faulted",
      fault: { kind: "session-empty", harness: "codex" },
    });
  });
});
