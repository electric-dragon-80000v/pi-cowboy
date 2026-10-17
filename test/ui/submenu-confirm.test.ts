/**
 * submenu-confirm.test.ts — the key-driven yes/no dialog (createKeyConfirm):
 * Y confirms, N and Escape cancel, anything else is ignored, and the detail
 * text renders in full because the body is not a list row.
 */
import { describe, expect, it, vi } from "vitest";
import { createKeyConfirm } from "../../src/ui/menu/submenus/confirm.js";
import type { Theme } from "../../src/ui/types.js";
import { KEY } from "./harness.js";

const theme: Theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

function build() {
  const onYes = vi.fn();
  const onNo = vi.fn();
  const body = createKeyConfirm({
    theme,
    message: "Force cleanup of agent abcd1234?",
    detail: "has uncommitted changes (/repo/wt)\n\nThis DELETES its worktree.",
    onYes,
    onNo,
  });
  return { body, onYes, onNo };
}

describe("createKeyConfirm", () => {
  it("renders the message, the full detail and the key hint", () => {
    const { body } = build();
    const text = body.render(80).join("\n");
    expect(text).toContain("Force cleanup of agent abcd1234?");
    expect(text).toContain("has uncommitted changes (/repo/wt)");
    expect(text).toContain("This DELETES its worktree.");
    expect(text).toContain("Y yes · N no");
  });

  it.each([
    ["lowercase y", "y", true],
    ["uppercase Y", "Y", true],
    ["lowercase n", "n", false],
    ["uppercase N", "N", false],
    ["Escape", KEY.escape, false],
  ])("%s resolves the dialog", (_label, key, yes) => {
    const { body, onYes, onNo } = build();
    body.handleInput?.(key);
    expect(onYes).toHaveBeenCalledTimes(yes ? 1 : 0);
    expect(onNo).toHaveBeenCalledTimes(yes ? 0 : 1);
  });

  it("ignores keys that are neither yes nor no", () => {
    const { body, onYes, onNo } = build();
    body.handleInput?.(KEY.enter);
    body.handleInput?.("x");
    expect(onYes).not.toHaveBeenCalled();
    expect(onNo).not.toHaveBeenCalled();
  });
});
