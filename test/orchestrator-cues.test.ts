/**
 * orchestrator-cues.test.ts — Cue rendering and validation.
 *
 * The byte-identity cases pin the `default` cues to the exact pre-cue
 * cowboy_agent strings. If a cue changes, the parent-facing replies change —
 * this is the test that says so.
 */

import { describe, expect, it } from "vitest";
import {
  queuedCueContext,
  settledCueContext,
  spawnCueContext,
} from "../src/orchestrators/context.js";
import {
  renderCue,
  validateCueTemplate,
  validateOrchestratorCues,
} from "../src/orchestrators/cues.js";
import { DEFAULT_ORCHESTRATORS } from "../src/orchestrators/default-orchestrators.js";

const CUES = DEFAULT_ORCHESTRATORS.default.cues;

const PATH = "/wt/cow-fix-login-abc";
const BRANCH = "cow-fix-login-abc";
const AGENT_ID = "abcd1234-dead-beef";

/** The worktree line the spawned/queued acks append. */
const WORKTREE_NOTE = `(Worktree: ${PATH} (branch ${BRANCH}) — the agent's commits land on that branch, never on main. Merge it with the merge_cowboy_branch tool when done, then remove the worktree with cleanup_cowboy_agent.)`;

const SPAWNED_ACK = `Success! You delegated to an agent. A notification will arrive when done - USER: do not poll, don't check status and don't duplicate the delegated work!`;

const QUEUED_ACK = `Agent QUEUED — the concurrency limit is reached (2 agents already spawned), so this task is waiting for a slot. It is NOT spawned yet: the process has not started. It will start automatically when another agent settles; you'll get a message when it starts and when it settles. Do NOT re-delegate — this task IS in flight.`;

/* ── Byte identity with the pre-cue output ──────────────────────────────── */

describe("default cues reproduce the pre-cue output byte-for-byte", () => {
  it("spawned, with a worktree", () => {
    expect(
      renderCue(
        CUES,
        "spawned",
        spawnCueContext({
          agentId: AGENT_ID,
          worktree: { path: PATH, branch: BRANCH },
        }),
      ),
    ).toBe(`${SPAWNED_ACK}\n${WORKTREE_NOTE}\n\nAgent ID: ${AGENT_ID}`);
  });

  it("spawned, without a worktree", () => {
    expect(
      renderCue(CUES, "spawned", spawnCueContext({ agentId: AGENT_ID })),
    ).toBe(`${SPAWNED_ACK}\n\nAgent ID: ${AGENT_ID}`);
  });

  it("queued, with a worktree and 2 spawned agents", () => {
    expect(
      renderCue(
        CUES,
        "queued",
        queuedCueContext({
          agentId: AGENT_ID,
          worktree: { path: PATH, branch: BRANCH },
          queueRunning: 2,
        }),
      ),
    ).toBe(`${QUEUED_ACK}\n${WORKTREE_NOTE}\n\nAgent ID: ${AGENT_ID}`);
  });

  it("queued, without a worktree", () => {
    const context = queuedCueContext({ agentId: AGENT_ID, queueRunning: 2 });
    expect(renderCue(CUES, "queued", context)).toBe(
      `${QUEUED_ACK}\n\nAgent ID: ${AGENT_ID}`,
    );
  });

  it("settled clean (completed, worktree kept alive)", () => {
    expect(
      renderCue(
        CUES,
        "settled",
        settledCueContext({
          outcome: { kind: "completed", result: "All done." },
          worktree: { path: PATH, branch: BRANCH, processAlive: true },
        }),
      ),
    ).toBe(
      `All done.\n(Worktree: ${PATH} (branch ${BRANCH}). The agent process and its herdr pane stay until you call cleanup_cowboy_agent — its pane is closed, which ends that process. The worktree stays until you call cleanup_cowboy_agent to remove it — call it once the branch is merged or rejected.)`,
    );
  });

  it("settled clean, without a worktree", () => {
    expect(
      renderCue(
        CUES,
        "settled",
        settledCueContext({
          outcome: { kind: "completed", result: "All done." },
        }),
      ),
    ).toBe("All done.");
  });

  it("settled kept + alive", () => {
    expect(
      renderCue(
        CUES,
        "settled",
        settledCueContext({
          outcome: { kind: "completed", result: "Partial work." },
          worktree: {
            path: PATH,
            branch: BRANCH,
            retention: "has uncommitted changes",
            processAlive: true,
          },
        }),
      ),
    ).toBe(
      `Partial work.\n(Worktree: ${PATH} (branch ${BRANCH}) — KEPT: has uncommitted changes. The agent process and its herdr pane stay until you call cleanup_cowboy_agent — its pane is closed, which ends that process. Clean the worktree up, then call cleanup_cowboy_agent to remove it.)`,
    );
  });

  it("settled kept + stopped, with its status note", () => {
    expect(
      renderCue(
        CUES,
        "settled",
        settledCueContext({
          outcome: { kind: "stopped" },
          statusNote:
            " (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)",
          worktree: {
            path: PATH,
            branch: BRANCH,
            retention: "has uncommitted changes",
          },
        }),
      ),
    ).toBe(
      `\n(Worktree: ${PATH} (branch ${BRANCH}) — KEPT: has uncommitted changes. Clean the worktree up, then call cleanup_cowboy_agent to remove it.) (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)`,
    );
  });

  it("settled error, kept", () => {
    expect(
      renderCue(
        CUES,
        "settled",
        settledCueContext({
          outcome: { kind: "failed", error: "boom" },
          worktree: {
            path: PATH,
            branch: BRANCH,
            retention: "has uncommitted changes",
          },
        }),
      ),
    ).toBe(
      `\n\nError: boom\n(Worktree: ${PATH} (branch ${BRANCH}) — KEPT: has uncommitted changes. Clean the worktree up, then call cleanup_cowboy_agent to remove it.)`,
    );
  });
});

/* ── Rendering semantics ────────────────────────────────────────────────── */

describe("renderCue escaping and sections", () => {
  it("renders facts verbatim — no HTML escaping, no re-templating", () => {
    const result = `<a href="x">&amp;</a> {{agent_id}} — \`code\` {{{{braces}}}}`;
    expect(
      renderCue(
        CUES,
        "settled",
        settledCueContext({ outcome: { kind: "completed", result } }),
      ),
    ).toBe(result);
  });

  it("renders absent facts as empty, never as 'null'", () => {
    expect(
      renderCue(CUES, "spawned", spawnCueContext({ agentId: AGENT_ID })),
    ).not.toContain("null");
    expect(
      renderCue(
        CUES,
        "settled",
        settledCueContext({ outcome: { kind: "stopped" } }),
      ),
    ).toBe("");
  });

  it("trims sections to the facts that apply", () => {
    const withTree = renderCue(
      CUES,
      "settled",
      settledCueContext({
        outcome: { kind: "completed", result: "r" },
        worktree: { path: PATH, branch: BRANCH },
      }),
    );
    const withoutTree = renderCue(
      CUES,
      "settled",
      settledCueContext({ outcome: { kind: "completed", result: "r" } }),
    );

    expect(withTree).toContain("(Worktree:");
    expect(withoutTree).not.toContain("Worktree");
    // The inverted `{{^retention}}` arm carries the clean-tree removal wording.
    expect(withTree).toContain(
      "The worktree stays until you call cleanup_cowboy_agent to remove it",
    );
  });

  it("labels the queue singular only at exactly one spawned agent", () => {
    const label = (queueRunning: number) =>
      queuedCueContext({ agentId: AGENT_ID, queueRunning }).queue_running_label;

    expect(label(1)).toBe("agent");
    expect(label(2)).toBe("agents");
    expect(label(0)).toBe("agents");
  });

  it("keeps the status note's own leading space", () => {
    const context = settledCueContext({
      outcome: { kind: "completed", result: "r" },
      statusNote: " (STOPPED BY YOU)",
    });
    expect(context.status_note).toBe(" (STOPPED BY YOU)");
    expect(renderCue(CUES, "settled", context)).toBe("r (STOPPED BY YOU)");
  });

  it("only renders the dispatched event's template", () => {
    expect(
      renderCue(CUES, "spawned", spawnCueContext({ agentId: AGENT_ID })),
    ).not.toContain("Agent QUEUED");
  });
});

/* ── Validation ─────────────────────────────────────────────────────────── */

describe("validateCueTemplate", () => {
  it("accepts every variable its own cue supplies", () => {
    expect(
      validateCueTemplate(
        "spawned",
        "{{agent_id}} {{has_worktree}} {{worktree_path}} {{worktree_branch}}",
      ),
    ).toEqual({ ok: true });
    expect(
      validateCueTemplate(
        "queued",
        "{{#has_worktree}}{{worktree_path}}{{/has_worktree}} {{queue_running}} {{queue_running_label}}",
      ),
    ).toEqual({ ok: true });
    expect(
      validateCueTemplate(
        "settled",
        "{{result}}{{#error}}{{error}}{{/error}}{{#retention}}{{retention}}{{/retention}}{{#process_alive}}{{/process_alive}}{{^retention}}x{{/retention}}{{status_note}}",
      ),
    ).toEqual({ ok: true });
  });

  it("accepts comments and unescaped interpolation", () => {
    expect(
      validateCueTemplate(
        "spawned",
        "{{! a note }}{{{agent_id}}}{{&agent_id}}",
      ),
    ).toEqual({ ok: true });
  });

  it("rejects an unknown variable, naming the cue's allowed set", () => {
    const result = validateCueTemplate("spawned", "hi {{worktre_path}}");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain('unknown variable "{{worktre_path}}"');
    expect(result.reason).toContain("spawned cue");
    expect(result.reason).toContain("agent_id, has_worktree");
    expect(result.reason).not.toContain("\n");
  });

  it("rejects a variable belonging to another cue", () => {
    expect(validateCueTemplate("spawned", "{{queue_running}}").ok).toBe(false);
    expect(validateCueTemplate("queued", "{{result}}").ok).toBe(false);
    expect(validateCueTemplate("settled", "{{agent_id}}").ok).toBe(false);
  });

  it("rejects partials and delimiter changes", () => {
    const partial = validateCueTemplate("spawned", "{{>shared}}");
    const delimiters = validateCueTemplate(
      "spawned",
      "{{=<% %>=}}<%agent_id%>",
    );

    expect(partial).toEqual({
      ok: false,
      reason: 'partials are not supported: "{{>shared}}"',
    });
    expect(delimiters.ok).toBe(false);
    if (delimiters.ok) throw new Error("unreachable");
    expect(delimiters.reason).toContain("delimiter changes are not supported");
  });

  it("rejects an unparsable template on one line", () => {
    const result = validateCueTemplate("settled", "{{#has_worktree}}oops");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("unparsable template");
    expect(result.reason).not.toContain("\n");
  });
});

describe("validateOrchestratorCues", () => {
  it("accepts a partial cue set and the shipped defaults", () => {
    expect(validateOrchestratorCues({})).toEqual({ ok: true });
    expect(validateOrchestratorCues({ spawned: "{{agent_id}}" })).toEqual({
      ok: true,
    });
    expect(
      validateOrchestratorCues(DEFAULT_ORCHESTRATORS.default.cues),
    ).toEqual({ ok: true });
  });

  it("reports the first failing cue", () => {
    expect(validateOrchestratorCues({ settled: "{{nope}}" }).ok).toBe(false);
  });
});

/* ── Per-cue typing ─────────────────────────────────────────────────────── */

describe("per-cue context types", () => {
  it("refuses a context from another cue at compile time", () => {
    // @ts-expect-error — settled-only facts cannot render through the spawned cue.
    expect(() => renderCue(CUES, "spawned", { result: "r" })).not.toThrow();
  });
});
