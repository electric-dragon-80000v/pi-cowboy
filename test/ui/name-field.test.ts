/**
 * name-field.test.ts — the shared single-line name field both worktree flows ask with.
 * Drives the real `Input` the field returns, so the assertions are about what the
 * component actually holds after the prefill is typed into it.
 */
import { describe, expect, it, vi } from "vitest";
import { createNameField } from "../../src/ui/menu/submenus/name-field.js";

/** A field whose rule rejects the empty name and the literal `bad`. */
function field(prefill: string) {
  const accepted: string[] = [];
  const cancelled: number[] = [];
  const notify = vi.fn();
  const input = createNameField({
    prefill,
    notify,
    validate: (name) => (name === "" || name === "bad" ? "rejected" : null),
    describeProblem: (problem) => problem,
    onDone: (name) => accepted.push(name),
    onCancel: () => cancelled.push(1),
  });
  return { input, accepted, cancelled, notify };
}

describe("createNameField — prefill", () => {
  it("types the prefill and leaves the caret after it, where the user continues", () => {
    const { input, accepted } = field("cow-");

    input.handleInput("x");
    input.handleInput("\r");

    expect(accepted).toEqual(["cow-x"]);
  });

  // Backspace and delete remove what precedes them; ctrl-u takes the line, and
  // undo reverts to the empty field it started as.
  it.each([
    { key: "backspace", char: "\x08" },
    { key: "delete", char: "\x7f" },
    { key: "ctrl-u", char: "\x15" },
    { key: "undo", char: "\x1f" },
  ])("drops $key, which would edit the prefill away", ({ char }) => {
    const { input } = field(`cow-${char}`);

    expect(input.getValue()).toBe("cow-");
  });

  it("carries a carriage return or newline as nothing rather than as a submit", () => {
    const { input, accepted, cancelled } = field("render\npage\r");

    expect(input.getValue()).toBe("renderpage");
    expect(accepted).toEqual([]);
    expect(cancelled).toEqual([]);
  });

  it("drops C1 control characters too", () => {
    const { input } = field("co\x9fw-");

    expect(input.getValue()).toBe("cow-");
  });

  it("keeps an ordinary prefill verbatim", () => {
    const { input, accepted, notify } = field("render-page");

    input.handleInput("\r");

    expect(accepted).toEqual(["render-page"]);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("createNameField — submit and cancel", () => {
  it("keeps the field open on a rejected name, notifying the problem", () => {
    const { input, accepted, notify } = field("bad");

    input.handleInput("\r");

    expect(notify).toHaveBeenCalledWith("rejected", "error");
    expect(accepted).toEqual([]);
    expect(input.getValue()).toBe("bad");
  });

  it("reports the trimmed name", () => {
    const { input, accepted } = field("  fix-login  ");

    input.handleInput("\r");

    expect(accepted).toEqual(["fix-login"]);
  });

  it("cancels on escape without a name", () => {
    const { input, accepted, cancelled } = field("cow-x");

    input.handleInput("\x1b");

    expect(cancelled).toEqual([1]);
    expect(accepted).toEqual([]);
  });
});
