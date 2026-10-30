/**
 * menu-agent-handover.ts — the status menu's handover sub-flow.
 *
 * A settled agent's session can be carried to another harness, or written to a
 * file and launched by hand. The submenu only chooses: which targets exist, why
 * a source cannot produce a session, and how an outcome reads are all answered
 * by the same modules `handover_cowboy_agent` uses, so the menu cannot offer a
 * handover the tool would refuse.
 *
 * Nothing here changes the agent during a listing or an export; only a target
 * selection hands the environment over, and it does so off-menu.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  SelectList,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { AgentSpawn } from "../../types.js";
import {
  writeHandoverFile,
  handoverFileExists,
} from "../../agents/handover-file.js";
import {
  handoverExportFaultReason,
  handoverExportSeverity,
  type PreparedHandoverExport,
} from "../../agents/handover-export.js";
import { handoverLossClause, handoverSeverity } from "../../agents/handover.js";
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
import type { SwappableView } from "./screen-host.js";
import { createKeyConfirm } from "./submenus/confirm.js";
import { actionReport, buildSelectListTheme, withVimKeys } from "./helpers.js";

/** What the sub-flow needs from the screen hosting it. */
export interface StatusHandoverDeps {
  ctx: ExtensionCommandContext;
  theme: Theme;
  /** The swapping view the overwrite confirmation is shown in. */
  view: SwappableView;
  /** Close the status menu; a handover or an export then finishes off-menu. */
  close: () => void;
  /** Repaint the screen: a body swapped from an async pass has no keypress to ride. */
  requestRender: () => void;
}

/**
 * Build the status menu's handover entry point. The returned callback opens the
 * submenu for one settled spawn and runs whichever action is picked.
 */
export function createStatusHandover(
  deps: StatusHandoverDeps,
): (spawn: AgentSpawn) => void {
  const { ctx, theme, view, close, requestRender } = deps;
  const action = actionReport(ctx.ui);

  /** Swap the body and repaint (a swap with no keypress behind it gets no repaint). */
  const show = (body: Component): void => {
    view.activate(body);
    requestRender();
  };

  /** Report why the source run has no session to offer, and leave the menu. */
  const refuse = (spawn: AgentSpawn, reason: string): void => {
    close();
    action.outcome("warning", `Agent ${spawn.id} ${reason}`);
  };

  /** Write the prepared artifact and report the path, at the loss's severity. */
  const writeAndReport = (
    id: string,
    prepared: PreparedHandoverExport,
  ): void => {
    try {
      writeHandoverFile(prepared.path, prepared.text);
    } catch (error) {
      action.failed(`Failed to export agent ${id} to ${prepared.path}`, error);
      return;
    }
    const loss =
      prepared.loss === undefined ? "" : handoverLossClause(prepared.loss);
    action.outcome(
      handoverExportSeverity(prepared),
      `Exported handover for agent ${id} to ${prepared.path}.${loss}`,
    );
  };

  /** Confirm the one destructive case: replacing an existing export. */
  const askOverwrite = (id: string, prepared: PreparedHandoverExport): void => {
    show(
      createKeyConfirm({
        theme,
        message: `Overwrite ${prepared.path}?`,
        detail:
          "An export of this run already exists there. Y replaces it with the current export; Esc keeps the existing file.",
        onYes: () => {
          close();
          writeAndReport(id, prepared);
        },
        onNo: () => {
          close();
          action.outcome(
            "warning",
            `Did not export agent ${id}: kept the existing file at ${prepared.path}`,
          );
        },
      }),
    );
  };

  /** Read the run's session and either ask about a collision or write the file. */
  const runExport = (spawn: AgentSpawn): void => {
    const manager = getManagerOrNull();
    if (!manager) {
      close();
      action.failed(
        `Failed to export agent ${spawn.id}`,
        "manager unavailable",
      );
      return;
    }
    action.pending(`Exporting handover for agent ${spawn.id}`);
    void (async () => {
      const outcome = await manager.exportHandover(spawn.id);
      if (outcome.kind === "faulted") {
        close();
        action.outcome(
          handoverExportSeverity(outcome),
          `Agent ${spawn.id} ${handoverExportFaultReason(outcome.fault)}`,
        );
        return;
      }
      if (handoverFileExists(outcome.path)) {
        askOverwrite(spawn.id, outcome);
        return;
      }
      close();
      writeAndReport(spawn.id, outcome);
    })();
  };

  /** Hand the run to another harness, off-menu, and report the tool's sentence. */
  const runHandover = (spawn: AgentSpawn, harness: AnyHarnessId): void => {
    const manager = getManagerOrNull();
    close();
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

  /** The submenu: one row per target harness, then the export. */
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
    items.push({
      value: "export",
      label: "Export",
      description:
        "Write the handover file to /tmp (nothing is stopped or launched)",
    });

    const list = withVimKeys(
      new SelectList(items, 10, buildSelectListTheme(theme)),
    );
    list.onSelect = (item) => {
      if (item.value === "export") {
        runExport(spawn);
        return;
      }
      runHandover(spawn, item.value.slice("harness:".length));
    };
    list.onCancel = () => close();
    show(list);
  };

  return (spawn: AgentSpawn): void => {
    const from = spawn.execution.harness;
    // A settled run that never engaged a harness has no session and no target
    // vocabulary; the shared fault is the honest answer.
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
    openSubmenu(spawn, from);
  };
}
