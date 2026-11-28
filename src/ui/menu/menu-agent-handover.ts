/**
 * menu-agent-handover.ts — the status menu's handover sub-flow.
 *
 * An agent's session can be carried to another harness. A run still in flight
 * has no finished session to read, so the sub-flow asks before stopping it;
 * only a confirmed stop ends a run it did not settle on its own.
 *
 * The submenu only chooses: which targets exist, why a source cannot produce a
 * session, and how an outcome reads are all answered by the same modules
 * `handover_cowboy_agent` uses, so the menu cannot offer a handover the tool
 * would refuse.
 *
 * Nothing here changes the agent during the listing; only a target selection
 * hands the environment over, and it does so off-menu.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  SelectList,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { isActivePhase, type AgentSpawn } from "../../types.js";
import { handoverExportFaultReason } from "../../agents/handover-export.js";
import { handoverSeverity } from "../../agents/handover.js";
import { handoverTargets } from "../../agents/handover-target.js";
import {
  canReadHandoverRecords,
  type AnyHarnessId,
} from "../../agents/harness.js";
import { renderHandoverOutcome } from "../../agents/tool-handover.js";
import {
  getHarnessAvailability,
  getHarnessRegistry,
  getManagerOrNull,
} from "../../shell.js";
import type { Theme } from "../types.js";

import { createKeyConfirm } from "./submenus/confirm.js";
import { actionReport, buildSelectListTheme, withVimKeys } from "./helpers.js";

/** What the sub-flow needs from the menu hosting it. */
export interface StatusHandoverDeps {
  ctx: ExtensionCommandContext;
  theme: Theme;
  /** Show `body` as this flow's dialog, in place of the level's own body. */
  show: (body: Component) => void;
  /** Leave the flow, back on the agent's actions. */
  leave: () => void;
}

/**
 * Build the status menu's handover entry point. The returned callback opens the
 * submenu for one settled spawn and runs whichever action is picked.
 */
export function createStatusHandover(
  deps: StatusHandoverDeps,
): (spawn: AgentSpawn) => void {
  const { ctx, theme, show, leave } = deps;
  const action = actionReport(ctx.ui);

  /** Report why the source run has no session to offer, and leave the menu. */
  const refuse = (spawn: AgentSpawn, reason: string): void => {
    leave();
    action.outcome("warning", `Agent ${spawn.id} ${reason}`);
  };

  /** Hand the run to another harness, off-menu, and report the tool's sentence. */
  const runHandover = (spawn: AgentSpawn, harness: AnyHarnessId): void => {
    const manager = getManagerOrNull();
    leave();
    if (!manager) {
      action.failed(
        `Failed to hand agent ${spawn.id} over to ${harness}`,
        "manager unavailable",
      );
      return;
    }
    action.pending(`Handing agent ${spawn.id} over to ${harness}`);
    void (async () => {
      const outcome = await manager.handover(spawn.id, { harness });
      action.outcome(
        handoverSeverity(outcome),
        renderHandoverOutcome(spawn.id, outcome),
      );
    })();
  };

  /** The submenu: one row per target harness. */
  const openSubmenu = (spawn: AgentSpawn, from: AnyHarnessId): void => {
    const registry = getHarnessRegistry();
    const items: SelectItem[] = handoverTargets(
      registry,
      getHarnessAvailability(),
      from,
    ).map((harness) => ({
      value: `harness:${harness}`,
      label: `Hand over to ${registry.displayName(harness)}`,
      description: `Launch the next run of this agent under ${registry.displayName(harness)}`,
    }));
    // With no other launchable harness there is nothing to pick, so the row
    // reports that instead of opening an empty list.
    if (items.length === 0) {
      refuse(spawn, "was not handed over: no other harness can take it over.");
      return;
    }

    const list = withVimKeys(
      new SelectList(items, 10, buildSelectListTheme(theme)),
    );
    list.onSelect = (item) => {
      runHandover(spawn, item.value.slice("harness:".length));
    };
    list.onCancel = () => leave();
    show(list);
  };

  /**
   * Confirm ending a run that is still in flight. A handover reads a finished
   * session, so the run has to end first; declining leaves it running and
   * returns to its actions.
   */
  const askStop = (spawn: AgentSpawn, proceed: () => void): void => {
    show(
      createKeyConfirm({
        theme,
        message: `Agent ${spawn.id} is still running.`,
        detail:
          "pi-cowboy will need to stop it before it can be handed over. Proceed?\n\nY stops the run and opens the handover targets; N or Esc leaves it running.",
        onNo: () => leave(),
        onYes: () => {
          const manager = getManagerOrNull();
          if (!manager) {
            leave();
            action.failed(
              `Failed to stop agent ${spawn.id}`,
              "manager unavailable",
            );
            return;
          }
          action.pending(`Stopping agent ${spawn.id}`);
          void (async () => {
            try {
              await manager.abort(spawn.id, "user");
            } catch (error) {
              leave();
              action.failed(`Failed to stop agent ${spawn.id}`, error);
              return;
            }
            // The stop's own verdict is not enough: what the next step needs is
            // a run that actually settled.
            if (isActivePhase(spawn.lifecycle.phase)) {
              leave();
              action.failed(
                `Failed to stop agent ${spawn.id}`,
                "the run is still active, so there is no finished session to hand over yet",
              );
              return;
            }
            action.succeeded(`Stopped agent ${spawn.id}`);
            proceed();
          })();
        },
      }),
    );
  };

  return (spawn: AgentSpawn): void => {
    const from = spawn.execution.harness;
    // A run that never engaged a harness (still queued, or ended before it
    // launched) has no session and no target vocabulary; the shared fault is
    // the honest answer.
    if (from === undefined) {
      refuse(spawn, handoverExportFaultReason({ kind: "never-started" }));
      return;
    }
    // A harness with no record reader cannot be a handover source at all, so
    // the submenu would have nothing to offer.
    const harness = getHarnessRegistry().get(from);
    if (harness === undefined || !canReadHandoverRecords(harness)) {
      refuse(
        spawn,
        handoverExportFaultReason({
          kind: "harness-cannot-export-session",
          harness: from,
        }),
      );
      return;
    }
    // A run still in flight has no finished session: stopping it is the one
    // change this flow makes on its own, and it needs a confirmed stop.
    if (isActivePhase(spawn.lifecycle.phase)) {
      askStop(spawn, () => openSubmenu(spawn, from));
      return;
    }
    openSubmenu(spawn, from);
  };
}
