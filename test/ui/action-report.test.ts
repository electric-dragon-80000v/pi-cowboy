/**
 * action-report.test.ts — the three-stage shape every slow action reports in.
 */
import { describe, expect, it, vi } from "vitest";
import { actionReport } from "../../src/ui/action-report.js";

/** Identity theme: the symbols come through bare, so the message text is readable. */
const flatTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function sink() {
  const notify = vi.fn();
  return { notify, report: actionReport({ notify, theme: flatTheme }) };
}

describe("actionReport", () => {
  it("appends an ellipsis to the in-progress line", () => {
    const { notify, report } = sink();

    report.pending("Cleaning up agent abcd1234");

    expect(notify).toHaveBeenCalledWith(
      "Cleaning up agent abcd1234 \u2026",
      "info",
    );
  });

  it("marks a success with the check symbol as info by default", () => {
    const { notify, report } = sink();

    report.succeeded("Stopped abcd1234");

    expect(notify).toHaveBeenCalledWith("✓ Stopped abcd1234", "info");
  });

  it("keeps the check symbol when the success carries a caveat", () => {
    const { notify, report } = sink();

    report.succeeded(
      "Stopped 1 of 2 agent(s); bbbb (already settled)",
      "warning",
    );

    expect(notify).toHaveBeenCalledWith(
      "✓ Stopped 1 of 2 agent(s); bbbb (already settled)",
      "warning",
    );
  });

  it("marks a failure with the cross symbol and the reason, as an error", () => {
    const { notify, report } = sink();

    report.failed(
      "Failed to clean up agent abcd1234",
      new Error("worktree is locked"),
    );

    expect(notify).toHaveBeenCalledWith(
      "✗ Failed to clean up agent abcd1234: worktree is locked",
      "error",
    );
  });

  it("accepts a bare string as the failure reason", () => {
    const { notify, report } = sink();

    report.failed("Steer refused for abcd1234", "agent is queued");

    expect(notify).toHaveBeenCalledWith(
      "✗ Steer refused for abcd1234: agent is queued",
      "error",
    );
  });

  it("colors the terminal symbols through the theme", () => {
    const notify = vi.fn();
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const report = actionReport({ notify, theme });

    report.succeeded("Stopped abcd1234");
    report.failed("Failed to stop abcd1234", "gone");

    expect(notify).toHaveBeenCalledWith(
      "<success>✓</success> Stopped abcd1234",
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      "<error>✗</error> Failed to stop abcd1234: gone",
      "error",
    );
    // In-progress carries no terminal symbol, so the theme is not touched.
    report.pending("Stopping abcd1234");
    expect(notify).toHaveBeenCalledWith("Stopping abcd1234 \u2026", "info");
  });
});
