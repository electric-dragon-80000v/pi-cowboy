/**
 * menu-agent-status-cleanup.ts — the status menu's two-phase cleanup workflow.
 *
 * A non-force pass runs first, in-menu, so a refusal the operator can override
 * can be surfaced where the decision belongs. When (and only when) a run refuses
 * for a *forceable* reason, the workflow offers `Force`, then a destructive
 * confirmation that names the checkout and what force would discard. Everything
 * else — the successful teardowns, the refusals force cannot touch — is reported
 * as it lands, and a clean sweep closes the menu.
 *
 * The force override lives here so it can never leak into `cleanup_cowboy_agent`:
 * the tool takes no options, and this is the only caller that passes `force`.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  SelectList,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import {
  cleanupNeedsAttention,
  formatKeptReason,
  summarizeCleanupReport,
} from "../../agents/cleanup-report.js";
import {
  isForceableRefusal,
  type CleanupOptions,
  type CleanupReport,
  type ForceableRefusedReport,
  type WorktreeKeptReason,
} from "../../agents/cleanup-policy.js";
import { getManagerOrNull } from "../../shell.js";
import { errorMessage } from "../../utils.js";
import type { Theme } from "../types.js";
import type { SwappableView } from "./screen-host.js";
import { createKeyConfirm } from "./submenus/confirm.js";
import {
  actionReport,
  agentSubject,
  buildSelectListTheme,
  withVimKeys,
} from "./helpers.js";

/** What the workflow needs from the screen hosting it. */
export interface StatusCleanupDeps {
  ctx: ExtensionCommandContext;
  theme: Theme;
  /** The swapping view the force dialogs are shown in. */
  view: SwappableView;
  /** Re-read the fleet and rebuild the agent rows in place. */
  refresh: () => void;
  /** Close the status menu (the forced pass then runs off-menu). */
  close: () => void;
  /** Repaint the screen: pi-tui redraws on input, but a body swapped from an async pass has no input to ride. */
  requestRender: () => void;
}

/** One id's outcome from a cleanup pass: its report, or the throw that stopped it. */
export type CleanupOutcome =
  | { id: string; kind: "report"; report: CleanupReport }
  | { id: string; kind: "error"; error: string };

/** A cleanup outcome carrying a forceable refusal — the only kind the force dialogs act on. */
type ForceableRefusal = Extract<CleanupOutcome, { kind: "report" }> & {
  report: ForceableRefusedReport;
};

/**
 * Run a cleanup pass over `ids` sequentially — teardowns share herdr/git state,
 * so items never run in parallel — building each id's options from `optsFor`.
 * Never throws: a per-id failure rides as `error`, so one id's outcome never
 * blocks the rest.
 */
async function runCleanupPass(
  ids: readonly string[],
  optsFor: (id: string) => CleanupOptions | undefined,
): Promise<CleanupOutcome[]> {
  const manager = getManagerOrNull();
  if (!manager) {
    return ids.map((id) => ({
      id,
      kind: "error",
      error: "manager unavailable",
    }));
  }
  const outcomes: CleanupOutcome[] = [];
  for (const id of ids) {
    try {
      outcomes.push({
        id,
        kind: "report",
        report: await manager.cleanup(id, optsFor(id)),
      });
    } catch (err) {
      outcomes.push({ id, kind: "error", error: errorMessage(err) });
    }
  }
  return outcomes;
}

/** Emit one terminal notification per outcome, with the wording the tool reports. */
function reportCleanupOutcomes(
  ctx: ExtensionCommandContext,
  outcomes: readonly CleanupOutcome[],
): void {
  const action = actionReport(ctx.ui);
  for (const outcome of outcomes) {
    if (outcome.kind === "report") {
      action.succeeded(
        summarizeCleanupReport(outcome.report),
        cleanupNeedsAttention(outcome.report) ? "warning" : "info",
      );
    } else {
      action.failed(`Failed to clean up agent ${outcome.id}`, outcome.error);
    }
  }
}

/** The refusal a report carries, or undefined when the run was not refused. */
function refusalReason(report: CleanupReport): WorktreeKeptReason | undefined {
  return report.outcome.kind === "refused" ? report.outcome.reason : undefined;
}

/** The worktree a refusal kept, when it named one. */
function refusalWorktreePath(report: CleanupReport): string | undefined {
  return report.worktree.kind === "kept"
    ? (report.worktree.path ?? undefined)
    : undefined;
}

/** The offer's phrasing of why force applies; the headline's wording reads after a colon, not after "anyway?". */
function offerReason(reason: WorktreeKeptReason): string {
  switch (reason.kind) {
    case "dirty":
      return "It has uncommitted changes";
    case "unverifiable":
      return `Its state could not be verified (${reason.detail})`;
    case "recovered-refusal":
      return "Herdr still reports it at work";
    default:
      return formatKeptReason(reason);
  }
}

/** A minimal in-menu status body shown while a slow cleanup pass runs. */
function progressBody(theme: Theme, message: string): Component {
  return {
    invalidate() {},
    render: () => [`  ${theme.fg("dim", message)}`],
  };
}

/** The first force dialog: Force first, Cancel second, Esc cancels. */
function forceOfferList(
  theme: Theme,
  message: string,
  onForce: () => void,
  onCancel: () => void,
): SelectList {
  const items: SelectItem[] = [
    { value: "force", label: "Force", description: message },
    {
      value: "cancel",
      label: "Cancel",
      description: "Keep the worktree and its changes",
    },
  ];
  const list = withVimKeys(
    new SelectList(items, 6, buildSelectListTheme(theme)),
  );
  list.onSelect = (item) => (item.value === "force" ? onForce() : onCancel());
  list.onCancel = onCancel;
  return list;
}

/**
 * Build the cleanup entry point for the status menu. The returned callback runs
 * the two-phase flow for `ids`; the menu stays open through the force decision
 * and only a clean sweep (or a confirmed force) closes it.
 */
export function createStatusCleanup(
  deps: StatusCleanupDeps,
): (ids: readonly string[]) => void {
  const { ctx, theme, view, refresh, close, requestRender } = deps;

  /** Swap the body and repaint (a swap with no keypress behind it gets no repaint). */
  const show = (body: Component): void => {
    view.activate(body);
    requestRender();
  };

  /** The second force step: spell out the consequence and require a Y. */
  const askForceConfirm = (
    idsToForce: readonly string[],
    reasons: ReadonlyMap<string, WorktreeKeptReason>,
    detailLines: readonly string[],
    onNo: () => void,
  ): void => {
    const single = idsToForce.length === 1;
    show(
      createKeyConfirm({
        theme,
        message: single
          ? `Force cleanup of agent ${idsToForce[0]}?`
          : `Force cleanup of ${idsToForce.length} agents?`,
        detail: [
          ...detailLines,
          "",
          single
            ? "This DELETES its worktree and anything uncommitted in it."
            : "This DELETES their worktrees and anything uncommitted in them.",
        ].join("\n"),
        onNo,
        onYes: () => {
          // The decision is made: hand the teardown back to run off-menu.
          close();
          actionReport(ctx.ui).pending(
            `Forcing cleanup of ${agentSubject(idsToForce)}`,
          );
          void (async () => {
            const forced = await runCleanupPass(idsToForce, (id) => {
              const reason = reasons.get(id);
              return { force: reason ? { reason } : {} };
            });
            reportCleanupOutcomes(ctx, forced);
          })();
        },
      }),
    );
  };

  /** The first force step: offer Force beside Cancel; Esc backs out. */
  const offerForce = (refusals: readonly ForceableRefusal[]): void => {
    const reasons = new Map<string, WorktreeKeptReason>();
    for (const { id, report } of refusals) {
      const reason = refusalReason(report);
      if (reason) reasons.set(id, reason);
    }
    const idsToForce = [...reasons.keys()];
    const single = idsToForce.length === 1;
    const detailLines = refusals.map(({ id, report }) => {
      const reason = refusalReason(report);
      const named = reason
        ? single
          ? formatKeptReason(reason)
          : `${id}: ${formatKeptReason(reason)}`
        : `${id}: kept`;
      const path = refusalWorktreePath(report);
      return path ? `${named} (${path})` : named;
    });
    const only = reasons.get(idsToForce[0] ?? "");
    const message = single
      ? `Clean up agent ${idsToForce[0]} anyway? ${only ? offerReason(only) : "kept"}.`
      : `Clean up ${idsToForce.length} agents anyway?`;
    // Backing out reports the reasons the dialog would have shown, then refreshes.
    const backOut = (): void => {
      reportCleanupOutcomes(ctx, refusals);
      refresh();
    };
    show(
      forceOfferList(
        theme,
        message,
        () => askForceConfirm(idsToForce, reasons, detailLines, backOut),
        backOut,
      ),
    );
  };

  /** Run one id set through both phases; see the module header for the shape. */
  return (ids: readonly string[]): void => {
    show(progressBody(theme, `Cleaning up ${agentSubject(ids)}\u2026`));
    void (async () => {
      const first = await runCleanupPass(ids, () => undefined);
      const refusals = first.filter(
        (o): o is ForceableRefusal =>
          o.kind === "report" && isForceableRefusal(o.report),
      );
      const refusalIds = new Set(refusals.map((o) => o.id));
      // Report everything that is settled now; forceable refusals wait for the dialog.
      reportCleanupOutcomes(
        ctx,
        first.filter((o) => !refusalIds.has(o.id)),
      );
      if (refusals.length > 0) {
        offerForce(refusals);
        return;
      }
      const needsAttention = first.some(
        (o) => o.kind === "error" || cleanupNeedsAttention(o.report),
      );
      // A refusal or failure leaves the agent listed with its reason; only a
      // clean sweep closes the menu.
      if (needsAttention) refresh();
      else close();
    })();
  };
}
