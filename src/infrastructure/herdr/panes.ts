/**
 * panes.ts — Layer 2: pane and tab resources over the herdr transport.
 *
 * Every operation is one CLI call. Calls the caller must know about (creating or
 * focusing a tab) throw HerdrError; `closePane` and the renames are best effort
 * and log what they swallow, since a pane or tab that is already gone is
 * expected and anything else is not.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../logger.js";
import { errorMessage } from "../../utils.js";
import {
  HerdrError,
  HerdrTransport,
  herdrErrorCode,
  isPaneGoneError,
  isTabGoneError,
  objectField,
  strField,
} from "./herdr-transport.js";

const log = createLogger("herdr.panes");

/** Pane/tab command budget (ms). */
const PANE_COMMAND_TIMEOUT_MS = 15_000;

export interface CreateTabOptions {
  workspaceId: string;
  cwd: string;
  /** Label for the new tab. */
  label: string;
}

/**
 * A pane's name in herdr's UI: the label to show, or the explicit clear that
 * removes one. Clearing is its own case because herdr tells a nameless pane
 * apart from one carrying an empty label.
 */
export type PaneName = { kind: "label"; label: string } | { kind: "clear" };

/** Pane/tab resource namespace. */
export class HerdrPanes {
  constructor(private readonly transport: HerdrTransport) {}

  /**
   * Create a background tab for a subagent; the agent is started into its root
   * shell pane afterwards.
   */
  async createAgentTab(
    options: CreateTabOptions,
  ): Promise<{ tabId: string; paneId: string }> {
    const args = [
      "tab",
      "create",
      "--workspace",
      options.workspaceId,
      "--cwd",
      options.cwd,
      "--label",
      options.label,
      "--no-focus",
    ];

    const result = await this.transport.call(args);
    const tabId = strField(objectField(result, "tab"), "tab_id");
    const paneId = strField(objectField(result, "root_pane"), "pane_id");
    if (!tabId || !paneId) {
      throw new HerdrError(
        `herdr tab create returned no tab/pane ids (${JSON.stringify(result).slice(0, 300)})`,
        undefined,
      );
    }
    return { tabId, paneId };
  }

  /**
   * Close a pane (kills whatever runs in it). Non-fatal by intent: a pane that
   * herdr no longer has is the wanted outcome, while any other failure — an
   * unreachable server, a timed-out call — is logged so the teardown it belongs
   * to is not silently assumed to have succeeded.
   */
  async closePane(paneId: string): Promise<void> {
    try {
      await this.transport.call(["pane", "close", paneId], {
        timeoutMs: PANE_COMMAND_TIMEOUT_MS,
      });
    } catch (err) {
      if (isPaneGoneError(err)) {
        log.debug("pane already gone", { paneId });
        return;
      }
      log.warn("pane close failed", {
        paneId,
        code: herdrErrorCode(err),
        detail: errorMessage(err),
      });
    }
  }

  /**
   * Name a pane in herdr's UI. Best effort by intent: a label is cosmetic, so an
   * unreachable herdr or a pane that is already gone must not fail the placement
   * the name describes. Logged, so a discarded name is not silently assumed to
   * have landed.
   */
  async renamePane(paneId: string, name: PaneName): Promise<void> {
    const args = ["pane", "rename", paneId];
    if (name.kind === "clear") args.push("--clear");
    else args.push(name.label);
    try {
      await this.transport.call(args, { timeoutMs: PANE_COMMAND_TIMEOUT_MS });
    } catch (err) {
      if (isPaneGoneError(err)) {
        log.debug("pane already gone", { paneId });
        return;
      }
      log.warn("pane rename failed", {
        paneId,
        code: herdrErrorCode(err),
        detail: errorMessage(err),
      });
    }
  }

  /**
   * Label a tab in herdr's UI, best effort like `renamePane`. A tab can only be
   * named, never unnamed: herdr's `tab rename` takes no `--clear`.
   */
  async renameTab(tabId: string, label: string): Promise<void> {
    try {
      await this.transport.call(["tab", "rename", tabId, label], {
        timeoutMs: PANE_COMMAND_TIMEOUT_MS,
      });
    } catch (err) {
      if (isTabGoneError(err)) {
        log.debug("tab already gone", { tabId });
        return;
      }
      log.warn("tab rename failed", {
        tabId,
        code: herdrErrorCode(err),
        detail: errorMessage(err),
      });
    }
  }

  /**
   * Focus a subagent's tab. A tab address resolves even once the agent is gone,
   * so this also works when the pane is still open. Throws HerdrError.
   */
  async focusTab(tabId: string): Promise<void> {
    await this.transport.call(["tab", "focus", tabId], {
      timeoutMs: PANE_COMMAND_TIMEOUT_MS,
    });
  }

  /**
   * Run a shell command in the pane's own shell, so it sees that shell's
   * functions and environment. Fire-and-forget: the CLI reports nothing, so a
   * caller that needs the result observes it with `waitForPaneOutput`.
   */
  async runInPane(paneId: string, command: string): Promise<void> {
    await this.transport.call(["pane", "run", paneId, command], {
      timeoutMs: PANE_COMMAND_TIMEOUT_MS,
    });
  }

  /** Wait until the pane's output contains `match`; throw on timeout. Searches existing output first, then polls. */
  async waitForPaneOutput(
    paneId: string,
    match: string,
    timeoutMs: number,
  ): Promise<void> {
    await this.transport.call(
      [
        "pane",
        "wait-output",
        "--match",
        match,
        "--timeout",
        String(timeoutMs),
        paneId,
      ],
      { timeoutMs: timeoutMs + PANE_COMMAND_TIMEOUT_MS },
    );
  }
}

/** Pane namespace for one pi instance. */
function paneNamespace(pi: ExtensionAPI): HerdrPanes {
  return new HerdrPanes(new HerdrTransport(pi));
}

export async function createAgentTab(
  pi: ExtensionAPI,
  options: CreateTabOptions,
): Promise<{ tabId: string; paneId: string }> {
  return paneNamespace(pi).createAgentTab(options);
}

export async function closePane(
  pi: ExtensionAPI,
  paneId: string,
): Promise<void> {
  return paneNamespace(pi).closePane(paneId);
}

export async function renamePane(
  pi: ExtensionAPI,
  paneId: string,
  name: PaneName,
): Promise<void> {
  return paneNamespace(pi).renamePane(paneId, name);
}

export async function renameTab(
  pi: ExtensionAPI,
  tabId: string,
  label: string,
): Promise<void> {
  return paneNamespace(pi).renameTab(tabId, label);
}

export async function focusTab(pi: ExtensionAPI, tabId: string): Promise<void> {
  return paneNamespace(pi).focusTab(tabId);
}

export async function runInPane(
  pi: ExtensionAPI,
  paneId: string,
  command: string,
): Promise<void> {
  return paneNamespace(pi).runInPane(paneId, command);
}

export async function waitForPaneOutput(
  pi: ExtensionAPI,
  paneId: string,
  match: string,
  timeoutMs: number,
): Promise<void> {
  return paneNamespace(pi).waitForPaneOutput(paneId, match, timeoutMs);
}
