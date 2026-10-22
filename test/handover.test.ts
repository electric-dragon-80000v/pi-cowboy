/**
 * handover.test.ts — the handover vocabulary, pinned without a session:
 * the handover task the next run reads and the export rules (a throw is a
 * failure, an idless export is a broken one, an empty answer is no session).
 */

import { describe, expect, it } from "vitest";
import {
  exportRunSession,
  handoverSeverity,
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
      sessionId: "ses_abc",
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
      sessionId: "ses_1",
      session: "user: hello",
    });

    expect(task).toContain("You are continuing this task in this workspace.");
    expect(task).not.toContain('task ""');
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
