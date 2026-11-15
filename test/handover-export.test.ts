/**
 * handover-export.test.ts — how an export reads: its severity per answer, and
 * the sentence each fault contributes after the agent id.
 */
import { describe, expect, it } from "vitest";
import {
  exportWorktreeName,
  handoverExportArtifact,
  handoverExportFaultReason,
  handoverExportSeverity,
  type HandoverExportFault,
} from "../src/agents/handover-export.js";

const ARTIFACT = {
  defaultPath: "/tmp/main-abcd1234-pi-ses_1.md",
  text: "task",
  sessionId: "ses_1",
};

describe("handoverExportArtifact", () => {
  it("names the file after the checkout, harness and session, in /tmp", () => {
    expect(
      handoverExportArtifact({
        worktree: "feat/login",
        harness: "claude",
        sessionId: "ses_1",
        text: "task",
      }),
    ).toEqual({
      kind: "prepared",
      defaultPath: "/tmp/feat-login-claude-ses_1.md",
      text: "task",
      sessionId: "ses_1",
    });
  });

  it("carries a loss when the read dropped records", () => {
    expect(
      handoverExportArtifact({
        worktree: "main-abcd1234",
        harness: "pi",
        sessionId: "ses_1",
        text: "task",
        loss: { excluded: 1, total: 4 },
      }).loss,
    ).toEqual({ excluded: 1, total: 4 });
  });
});

describe("exportWorktreeName", () => {
  it("names the checkout by its own directory, not its branch", () => {
    expect(
      exportWorktreeName(
        { path: "/repo/worktrees/cow-fix-login-abcd1234" },
        "spawn-1",
      ),
    ).toBe("cow-fix-login-abcd1234");
  });

  it("falls back to the agent id when the run had no worktree", () => {
    expect(exportWorktreeName(undefined, "spawn-1")).toBe("main-spawn-1");
  });
});

describe("handoverExportSeverity", () => {
  it("reports a clean artifact as a success", () => {
    expect(handoverExportSeverity({ kind: "prepared", ...ARTIFACT })).toBe(
      "success",
    );
  });

  it("reports an artifact that lost records as a warning", () => {
    expect(
      handoverExportSeverity({
        kind: "prepared",
        ...ARTIFACT,
        loss: { excluded: 1, total: 4 },
      }),
    ).toBe("warning");
  });

  it.each([
    { kind: "agent-unknown" },
    { kind: "agent-not-settled", status: "spawned" },
    { kind: "harness-cannot-export-session", harness: "pi" },
    { kind: "never-started" },
    { kind: "handover-in-progress", detail: "busy" },
  ] satisfies Array<HandoverExportFault>)(
    "reports $kind as a warning",
    (fault) => {
      expect(handoverExportSeverity({ kind: "faulted", fault })).toBe(
        "warning",
      );
    },
  );

  it.each([
    { kind: "session-empty", harness: "pi" },
    { kind: "session-export-failed", harness: "pi", detail: "gone" },
  ] satisfies Array<HandoverExportFault>)(
    "reports $kind as an error",
    (fault) => {
      expect(handoverExportSeverity({ kind: "faulted", fault })).toBe("error");
    },
  );
});

describe("handoverExportFaultReason", () => {
  it("names the agent the run unknown case is about", () => {
    expect(handoverExportFaultReason({ kind: "agent-unknown" })).toBe(
      "not found — check the id from its spawn or completion result.",
    );
  });

  it("says the run's state is what stopped the read", () => {
    expect(
      handoverExportFaultReason({
        kind: "agent-not-settled",
        status: "spawned",
      }),
    ).toBe(
      "is still spawned — its session cannot be read while the run is in that state. Nothing was changed.",
    );
  });

  it("names the harness that cannot export", () => {
    expect(
      handoverExportFaultReason({
        kind: "harness-cannot-export-session",
        harness: "pi",
      }),
    ).toBe(
      'was not exported: harness "pi" cannot export its own session, so there is nothing to write.',
    );
  });

  it("names the harness whose export failed, with its detail", () => {
    expect(
      handoverExportFaultReason({
        kind: "session-export-failed",
        harness: "claude",
        detail: "no transcript",
      }),
    ).toBe(
      'was not exported: harness "claude" could not export its session (no transcript).',
    );
  });

  it("repeats the manager's reason while a handover owns the agent", () => {
    expect(
      handoverExportFaultReason({
        kind: "handover-in-progress",
        detail: "a handover is already in progress.",
      }),
    ).toBe("was not exported: a handover is already in progress.");
  });
});
