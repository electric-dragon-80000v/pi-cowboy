/**
 * menu-agent-export.ts — the status menu's export sub-flow.
 *
 * An export reads one run's session and keeps the result outside pi-cowboy: on
 * the clipboard, or in a file the user chooses. The read is the same one a
 * handover performs, so a run that is still working can be exported — its
 * harness is already writing the session the export reads. Nothing is stopped,
 * archived, or launched, and nothing is written back into the run.
 *
 * The menu closes only on a landed export. A read fault leaves the choice list
 * up and a write fault leaves the path field up, so a failed attempt never
 * takes away the state the user would correct it in.
 */

import {
  copyToClipboard,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  SelectList,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { AgentSpawn } from "../../types.js";
import {
  handoverFileExists,
  writeHandoverFile,
} from "../../agents/handover-file.js";
import {
  handoverExportFaultReason,
  handoverExportSeverity,
  type PreparedHandoverExport,
} from "../../agents/handover-export.js";
import { handoverLossClause } from "../../agents/handover.js";
import { getManagerOrNull } from "../../shell.js";
import type { Theme } from "../types.js";

import { createKeyConfirm } from "./submenus/confirm.js";
import { createNameField } from "./submenus/name-field.js";
import { actionReport, buildSelectListTheme, withVimKeys } from "./helpers.js";

/** What the sub-flow needs from the menu hosting it. */
export interface StatusExportDeps {
  ctx: ExtensionCommandContext;
  theme: Theme;
  /** Show `body` as this flow's dialog, in place of the level's own body. */
  show: (body: Component) => void;
  /** Leave the flow, back on the agent's actions; only a landed export calls this. */
  leave: () => void;
}

/**
 * Build the status menu's export entry point. The returned callback opens the
 * export choice for one spawn.
 */
export function createStatusExport(
  deps: StatusExportDeps,
): (spawn: AgentSpawn) => void {
  const { ctx, theme, show, leave } = deps;
  const action = actionReport(ctx.ui);

  /** The loss clause an export's report appends; empty when nothing was omitted. */
  const lossClause = (prepared: PreparedHandoverExport): string =>
    prepared.loss === undefined ? "" : handoverLossClause(prepared.loss);

  /** Write the artifact to `path`, staying on the path field if the write fails. */
  const writeTo = (
    spawn: AgentSpawn,
    prepared: PreparedHandoverExport,
    path: string,
  ): void => {
    try {
      writeHandoverFile(path, prepared.text);
    } catch (error) {
      action.failed(`Failed to export agent ${spawn.id} to ${path}`, error);
      showPathField(spawn, prepared, path);
      return;
    }
    action.outcome(
      handoverExportSeverity(prepared),
      `Exported handover for agent ${spawn.id} to ${path}.${lossClause(prepared)}`,
    );
    leave();
  };

  /**
   * Confirm replacing a file that is already at the entered path. Declining
   * returns to the path field, so the user can pick a different name.
   */
  const confirmOverwrite = (
    spawn: AgentSpawn,
    prepared: PreparedHandoverExport,
    path: string,
  ): void => {
    if (!handoverFileExists(path)) {
      writeTo(spawn, prepared, path);
      return;
    }
    show(
      createKeyConfirm({
        theme,
        message: `Overwrite ${path}?`,
        detail:
          "A file already exists there. Y replaces it with the current export; Esc keeps the existing file.",
        onYes: () => writeTo(spawn, prepared, path),
        onNo: () => showPathField(spawn, prepared, path),
      }),
    );
  };

  /** The editable path, prefilled with `path`; a rejected submit keeps the field up. */
  const showPathField = (
    spawn: AgentSpawn,
    prepared: PreparedHandoverExport,
    path: string,
  ): void => {
    show(
      createNameField<"empty">({
        prefill: path,
        notify: (message, kind) => ctx.ui.notify(message, kind),
        validate: (value) => (value === "" ? "empty" : null),
        describeProblem: () => "The export needs a file path.",
        onDone: (value) => confirmOverwrite(spawn, prepared, value),
        onCancel: () => showChoice(spawn),
      }),
    );
  };

  /** Copy the artifact, reporting a clipboard that refuses it. */
  const copyToClipboardAndReport = (
    spawn: AgentSpawn,
    prepared: PreparedHandoverExport,
  ): void => {
    void (async () => {
      try {
        await copyToClipboard(prepared.text);
      } catch (error) {
        action.failed(
          `Failed to export agent ${spawn.id} to the clipboard`,
          error,
        );
        return;
      }
      action.outcome(
        handoverExportSeverity(prepared),
        `Exported handover for agent ${spawn.id} to the clipboard.${lossClause(prepared)}`,
      );
      leave();
    })();
  };

  /**
   * Read the spawn's session once, then hand the artifact to `then`. A fault
   * stays on the choice list: the other option, or Esc, is still available.
   */
  const readExport = (
    spawn: AgentSpawn,
    then: (prepared: PreparedHandoverExport) => void,
  ): void => {
    const manager = getManagerOrNull();
    if (!manager) {
      action.failed(
        `Failed to export agent ${spawn.id}`,
        "manager unavailable",
      );
      return;
    }
    action.pending(`Reading the handover for agent ${spawn.id}`);
    void (async () => {
      const outcome = await manager.exportHandover(spawn.id);
      if (outcome.kind === "faulted") {
        action.outcome(
          handoverExportSeverity(outcome),
          `Agent ${spawn.id} ${handoverExportFaultReason(outcome.fault)}`,
        );
        return;
      }
      then(outcome);
    })();
  };

  /** The two ways to keep an export. */
  const showChoice = (spawn: AgentSpawn): void => {
    const items: SelectItem[] = [
      {
        value: "clipboard",
        label: "Export to clipboard",
        description: "Copy this run's handover text to the clipboard",
      },
      {
        value: "file",
        label: "Export to file",
        description: "Write the handover text to a file you choose",
      },
    ];
    const list = withVimKeys(
      new SelectList(items, 10, buildSelectListTheme(theme)),
    );
    list.onSelect = (item) => {
      if (item.value === "clipboard") {
        readExport(spawn, (prepared) =>
          copyToClipboardAndReport(spawn, prepared),
        );
        return;
      }
      // The default name carries the session id, so the read comes first.
      readExport(spawn, (prepared) =>
        showPathField(spawn, prepared, prepared.defaultPath),
      );
    };
    list.onCancel = () => leave();
    show(list);
  };

  return showChoice;
}
