/**
 * handover.test.ts — the handover vocabulary, pinned without a session:
 * the handover task the next run reads and the export rules (a throw is a
 * failure, an idless export is a broken one, an empty answer is no session).
 */

import { describe, expect, it } from "vitest";
import {
  exportRunSession,
  handoverSeverity,
  parseHandoverMarker,
  renderHandoverMarker,
  renderHandoverTask,
  type HandoverFault,
  type HandoverOutcome,
} from "../src/agents/handover.js";
import type { HarnessRegistry } from "../src/agents/harness/harness-registry.js";
import type {
  AnyHarnessId,
  HarnessExportForHandover,
} from "../src/agents/harness.js";

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
    expect(task).toContain("Review it together with the current state");
    expect(task.trimEnd().endsWith("assistant: done")).toBe(true);
  });

  it("still reads as a task when the spawn has no slug", () => {
    const task = renderHandoverTask({
      taskSlug: undefined,
      sourceName: "Pi",
      previous: [],
      current: { harness: "pi", sessionId: "ses_1" },
      session: "user: hello",
    });

    expect(task).toContain("You are continuing this task in this workspace.");
    expect(task).not.toContain('task ""');
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
    // One marker, and it opens the quote: a later export stops reading there.
    const lines = task.split("\n");
    const markers = lines.filter((line) =>
      line.startsWith("<<pi-cowboy-handover "),
    );
    expect(markers).toEqual([renderHandoverMarker(parseHandoverMarker(task)!)]);
    expect(lines.slice(lines.indexOf(markers[0]!) + 1).join("\n")).toContain(
      "user: continue",
    );
  });
});

describe("parseHandoverMarker", () => {
  it("reads back what the renderer wrote, ids and all", () => {
    const chain = [
      { harness: "claude", sessionId: "ses_a" },
      { harness: "codex", sessionId: "ses_b" },
    ] as const;

    expect(parseHandoverMarker(renderHandoverMarker(chain))).toEqual(
      chain.map((ref) => ({ ...ref })),
    );
  });

  it("reads the outermost marker when an older one sits inside the quote", () => {
    const inner = renderHandoverMarker([
      { harness: "claude", sessionId: "ses_old" },
    ]);
    const text = [
      renderHandoverMarker([{ harness: "codex", sessionId: "ses_new" }]),
      "quoted earlier task:",
      inner,
      "rest of the quote",
    ].join("\n");

    expect(parseHandoverMarker(text)).toEqual([
      { harness: "codex", sessionId: "ses_new" },
    ]);
  });

  it("answers nothing for text without a readable marker", () => {
    const broken = [
      "no marker here",
      "<<pi-cowboy-handover not json>>",
      '<<pi-cowboy-handover [{"harness":"pi"}]>>',
      "<<pi-cowboy-handover []>>",
      '<<pi-cowboy-handover [{"harness":"pi","sessionId":"s"}',
    ];

    expect(broken.map((text) => parseHandoverMarker(text))).toEqual(
      broken.map(() => undefined),
    );
  });
});

describe("handoverSeverity", () => {
  const faulted = (fault: HandoverFault): HandoverOutcome => ({
    kind: "faulted",
    fault,
  });

  it("marks a completed handover as the success", () => {
    expect(
      handoverSeverity({ kind: "handed-over", from: "pi", to: "claude" }),
    ).toBe("success");
  });

  it("marks a request that could not be served as a warning", () => {
    const refusals: readonly HandoverFault[] = [
      { kind: "agent-unknown" },
      { kind: "agent-not-settled", status: "spawned" },
      { kind: "harness-cannot-export-session", harness: "pi" },
      { kind: "never-started" },
      { kind: "request-refused", detail: "unknown harness" },
    ];

    expect(refusals.map((fault) => handoverSeverity(faulted(fault)))).toEqual(
      refusals.map(() => "warning"),
    );
  });

  it("marks a run that could not be stopped, exported, or relaunched as an error", () => {
    const failures: readonly HandoverFault[] = [
      { kind: "stop-failed", detail: "no pane" },
      { kind: "session-empty", harness: "pi" },
      { kind: "session-export-failed", harness: "pi", detail: "no file" },
      { kind: "launch-failed", detail: "boom" },
    ];

    expect(failures.map((fault) => handoverSeverity(faulted(fault)))).toEqual(
      failures.map(() => "error"),
    );
  });
});

describe("exportRunSession", () => {
  const request = {
    pi: {} as never,
    subagentId: "session-1",
    paneId: "w1:p1",
    cwd: "/repo",
  };

  /** A registry that answers for one harness and knows no other. */
  function registryWith(harness: {
    readonly id: AnyHarnessId;
    readonly exportForHandover?: HarnessExportForHandover;
  }): HarnessRegistry {
    return {
      get: (id: AnyHarnessId) => (id === harness.id ? harness : undefined),
    } as unknown as HarnessRegistry;
  }

  it("returns the harness's export, session id and all", async () => {
    await expect(
      exportRunSession(
        registryWith({
          id: "claude",
          exportForHandover: async () => ({
            sessionId: "ses_1",
            session: "user: hi",
          }),
        }),
        "claude",
        request,
      ),
    ).resolves.toEqual({
      kind: "exported",
      sessionId: "ses_1",
      session: "user: hi",
    });
  });

  it("refuses a harness that cannot export its session, exporting nothing", async () => {
    await expect(
      exportRunSession(registryWith({ id: "pi" }), "pi", request),
    ).resolves.toEqual({
      kind: "faulted",
      fault: { kind: "harness-cannot-export-session", harness: "pi" },
    });
  });

  it("turns a throwing export into its own fault", async () => {
    await expect(
      exportRunSession(
        registryWith({
          id: "claude",
          exportForHandover: async () => {
            throw new Error("no session file");
          },
        }),
        "claude",
        request,
      ),
    ).resolves.toEqual({
      kind: "faulted",
      fault: {
        kind: "session-export-failed",
        harness: "claude",
        detail: "no session file",
      },
    });
  });

  it("faults an export that names no session", async () => {
    await expect(
      exportRunSession(
        registryWith({
          id: "codex",
          exportForHandover: async () => ({
            sessionId: " \n",
            session: "user: hi",
          }),
        }),
        "codex",
        request,
      ),
    ).resolves.toEqual({
      kind: "faulted",
      fault: {
        kind: "session-export-failed",
        harness: "codex",
        detail: "the harness named no session id for the run it exported",
      },
    });
  });

  it("treats a blank answer as no session", async () => {
    await expect(
      exportRunSession(
        registryWith({
          id: "codex",
          exportForHandover: async () => ({
            sessionId: "ses_9",
            session: " \n\t ",
          }),
        }),
        "codex",
        request,
      ),
    ).resolves.toEqual({
      kind: "faulted",
      fault: { kind: "session-empty", harness: "codex" },
    });
  });
});
