/**
 * menu-agent-status-cleanup.test.ts — the status menu's two-phase cleanup
 * workflow (createStatusCleanup) at the module boundary: a stub view and stub
 * refresh/close, not a whole menu. The menu-level wiring (that "Clean up" enters
 * the flow, that a clean sweep closes the menu) stays in agent-status-menu.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import type {
  CleanupOptions,
  CleanupReport,
} from "../../src/agents/cleanup-policy.js";
import { SwappableView } from "../../src/ui/menu/screen-host.js";
import type { Theme } from "../../src/ui/types.js";
import { KEY } from "./harness.js";
import { resetShell, setManager } from "./shell-mock.js";
import {
  dirtyRefusal,
  forcedTeardown,
  fullTeardown,
  unlocatableRefusal,
} from "./cleanup-fixtures.js";

vi.mock("../../src/shell.js", () => import("./shell-mock.js"));

const { createStatusCleanup } =
  await import("../../src/ui/menu/menu-agent-status-cleanup.js");

const theme: Theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

/** An inert body the view starts on; the flow replaces it. */
const sentinel: Component = { invalidate() {}, render: () => [] };

interface Recorded {
  id: string;
  opts?: CleanupOptions;
}

let calls: Recorded[];
let cleanupImpl: (id: string, opts?: CleanupOptions) => CleanupReport;

/** Let the flow's async pass (and any forced pass) run to completion. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

function buildFlow() {
  const refresh = vi.fn();
  const close = vi.fn();
  const notify = vi.fn();
  const requestRender = vi.fn();
  const ctx = { ui: { notify, theme } } as unknown as ExtensionCommandContext;
  setManager({
    cleanup: (id: string, opts?: CleanupOptions) => {
      calls.push({ id, opts });
      return Promise.resolve(cleanupImpl(id, opts));
    },
  });
  const view = new SwappableView(sentinel);
  const beginCleanup = createStatusCleanup({
    ctx,
    theme,
    view,
    refresh,
    close,
    requestRender,
  });
  return {
    beginCleanup,
    refresh,
    close,
    notify,
    requestRender,
    text: () => stripTerminalSequences(view.render(80).join("\n")),
    press: (key: string) => view.handleInput(key),
  };
}

beforeEach(() => {
  resetShell();
  calls = [];
  cleanupImpl = (id) => fullTeardown(id);
});

describe("createStatusCleanup", () => {
  it("runs the non-force pass first, then forces on Y and closes", async () => {
    cleanupImpl = (id, opts) =>
      opts?.force ? forcedTeardown(id) : dirtyRefusal(id);
    const flow = buildFlow();

    flow.beginCleanup(["beef5678-completed"]);
    await flush();

    // The non-force pass refused; Force/Cancel is up and the menu stays open.
    expect(calls).toEqual([{ id: "beef5678-completed", opts: undefined }]);
    expect(flow.close).not.toHaveBeenCalled();
    expect(flow.text()).toContain("Force");
    expect(flow.text()).toContain("Cancel");

    flow.press(KEY.enter); // Force
    // The second step spells out the consequence before a Y can land.
    expect(flow.text()).toContain("Force cleanup of agent beef5678-completed?");
    expect(flow.text()).toContain("This DELETES its worktree");

    flow.press("y");
    await flush();

    expect(calls).toEqual([
      { id: "beef5678-completed", opts: undefined },
      {
        id: "beef5678-completed",
        opts: { force: { reason: { kind: "dirty" } } },
      },
    ]);
    expect(flow.close).toHaveBeenCalledTimes(1);
    expect(flow.notify).toHaveBeenCalledWith(
      "✓ Cleaned up agent beef5678-completed forced — has uncommitted changes: pane closed, worktree removed (/repo/.worktrees/fix-login), branch deleted (cow-fix-login-abcd1234)",
      "info",
    );
  });

  it("backs out of the offer on Escape without forcing, still naming the reason", async () => {
    cleanupImpl = (id, opts) =>
      opts?.force ? forcedTeardown(id) : dirtyRefusal(id);
    const flow = buildFlow();

    flow.beginCleanup(["beef5678-completed"]);
    await flush();
    flow.press(KEY.escape);

    expect(calls).toHaveLength(1);
    expect(flow.refresh).toHaveBeenCalledTimes(1);
    expect(flow.close).not.toHaveBeenCalled();
    // Backing out still reports the refusal the dialog would have overridden.
    expect(flow.notify).toHaveBeenCalledWith(
      "✓ Did not clean up agent beef5678-completed: has uncommitted changes pane closed",
      "warning",
    );
  });

  it("does not force when the confirmation is declined, still naming the reason", async () => {
    cleanupImpl = (id, opts) =>
      opts?.force ? forcedTeardown(id) : dirtyRefusal(id);
    const flow = buildFlow();

    flow.beginCleanup(["beef5678-completed"]);
    await flush();
    flow.press(KEY.enter); // Force
    flow.press("n");

    expect(calls).toHaveLength(1);
    expect(flow.refresh).toHaveBeenCalledTimes(1);
    expect(flow.close).not.toHaveBeenCalled();
    expect(flow.notify).toHaveBeenCalledWith(
      "✓ Did not clean up agent beef5678-completed: has uncommitted changes pane closed",
      "warning",
    );
  });

  it("repaints when it swaps in the force offer", async () => {
    cleanupImpl = (id, opts) =>
      opts?.force ? forcedTeardown(id) : dirtyRefusal(id);
    const flow = buildFlow();

    flow.beginCleanup(["beef5678-completed"]);
    // Clear the progress body's repaint; the offer is swapped in from the async
    // pass, where no keystroke follows to force a redraw.
    flow.requestRender.mockClear();
    await flush();

    expect(flow.text()).toContain("Force");
    expect(flow.requestRender).toHaveBeenCalled();
  });

  it("stays open and warns when the refusal is not forceable", async () => {
    cleanupImpl = (id) => unlocatableRefusal(id);
    const flow = buildFlow();

    flow.beginCleanup(["beef5678-completed"]);
    await flush();

    expect(flow.text()).not.toContain("Force");
    expect(flow.refresh).toHaveBeenCalledTimes(1);
    expect(flow.close).not.toHaveBeenCalled();
    expect(flow.notify).toHaveBeenCalledWith(
      "✓ Did not clean up agent beef5678-completed: state could not be verified (missing worktree path or repo cwd) pane closed",
      "warning",
    );
  });

  it("asks once for a whole batch and forces it together", async () => {
    cleanupImpl = (id, opts) =>
      opts?.force ? forcedTeardown(id) : dirtyRefusal(id);
    const flow = buildFlow();

    flow.beginCleanup(["a-completed", "b-completed"]);
    await flush();

    // Both refused on the non-force pass; one prompt covers both.
    expect(flow.text()).toContain("Clean up 2 agents anyway?");

    flow.press(KEY.enter); // Force
    expect(flow.text()).toContain("Force cleanup of 2 agents?");
    expect(flow.text()).toContain("a-completed: has uncommitted changes");

    flow.press("y");
    await flush();

    expect(calls.map((call) => call.opts?.force !== undefined)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(flow.close).toHaveBeenCalledTimes(1);
  });
});
