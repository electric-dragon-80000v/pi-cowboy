/**
 * menu-agent-status.ts — the agent list (active and settled) and per-agent
 * actions. Snapshot at construction; re-entry refreshes. Actions focus the
 * subagent's herdr pane instead of an in-extension viewer. The two-phase
 * cleanup flow — including the menu-only force override — lives in
 * menu-agent-status-cleanup.ts.
 * Exports: showAgentStatusMenu, buildAgentActionsList.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  SelectList,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SelectItem,
  type TUI,
} from "@earendil-works/pi-tui";
import type { AgentSpawn } from "../../types.js";
import {
  ALL_AGENT_PHASES,
  hasOutcome,
  isActivePhase,
  lifecycleResult,
  lifecycleStartTime,
  lifecycleStatus,
} from "../../types.js";

import { canReadHandoverRecords } from "../../agents/harness.js";
import { openableResultFile } from "../../agents/result-file-open.js";
import {
  branchMergeReadiness,
  mergeSeverity,
  mergeSingleBranch,
} from "../../agents/tool-merge.js";
import { subagentResultFileFor } from "../../paths.js";
import { errorMessage } from "../../utils.js";
import {
  getDisplayName,
  agentFieldSeparator,
  formatMs,
  statusIcon,
} from "../format.js";
import {
  getHarnessRegistry,
  getManagerOrNull,
  getPiInstance,
  getRuntime,
} from "../../shell.js";
import type { Theme } from "../types.js";
import { asListFields } from "./list-fields.js";
import { ScreenHost } from "./screen-host.js";
import { SwappableView } from "./swappable-view.js";
import { createStatusCleanup } from "./menu-agent-status-cleanup.js";
import { createStatusExport } from "./menu-agent-export.js";
import { createStatusHandover } from "./menu-agent-handover.js";
import type { MenuLevel } from "./menu-levels.js";
import { MenuSession } from "./menu-session.js";
import {
  SEPARATOR_ID,
  actionReport,
  agentSubject,
  buildSelectListTheme,
  installSeparatorSkip,
  withVimKeys,
} from "./helpers.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";

/** Focus the subagent's herdr tab. */
async function focusHerdrPane(
  ctx: ExtensionCommandContext,
  spawn: AgentSpawn,
): Promise<void> {
  const host = spawn.execution.host;
  if (!host) {
    ctx.ui.notify("Agent has no herdr pane yet (still queued)", "info");
    return;
  }
  const runtime = getRuntime();
  if (!runtime) {
    ctx.ui.notify("Agent runtime is not initialized", "warning");
    return;
  }
  // Focus the tab, not the agent: `agent focus` fails once the agent is gone
  // while its pane is still open. A rejection (e.g. closed tab) is reported.
  const action = actionReport(ctx.ui);
  action.pending(`Focusing agent ${spawn.id}'s herdr pane`);
  try {
    await runtime.view.focus(host);
    action.succeeded(`Focused agent ${spawn.id}'s herdr pane`);
  } catch (err) {
    action.failed(`Failed to focus agent ${spawn.id}'s herdr pane`, err);
  }
}

/**
 * Hand the run's report to macOS's default application. The row is offered only
 * for a file that exists, so a missing one here means it went away since the
 * list was built; the failure is reported rather than retried silently.
 */
async function openResultFile(
  ctx: ExtensionCommandContext,
  spawn: AgentSpawn,
): Promise<void> {
  const action = actionReport(ctx.ui);
  const file = openableResultFile(
    subagentResultFileFor(spawn.id),
    process.platform,
  );
  if (file === undefined) {
    action.failed(
      `Failed to open agent ${spawn.id}'s result file`,
      "the file is missing or empty",
    );
    return;
  }
  action.pending(`Opening agent ${spawn.id}'s result file`);
  try {
    const result = await getPiInstance().exec("open", [file]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `open exited ${result.code}`);
    }
    action.succeeded(`Opened agent ${spawn.id}'s result file ${file}`);
  } catch (err) {
    action.failed(`Failed to open agent ${spawn.id}'s result file`, err);
  }
}

/** The branch the spawn's worktree carried, when it has one at all. */
function worktreeBranch(spawn: AgentSpawn): string | undefined {
  return spawn.display.worktree?.branch;
}

/**
 * Whether the merge row has anything to offer: the run is settled and its
 * branch still holds commits the main checkout's HEAD lacks. A probe git could
 * not answer keeps the row, so the merge reports its own refusal instead of the
 * action vanishing on a failed question.
 */
async function offerMerge(spawn: AgentSpawn, branch: string): Promise<boolean> {
  if (isActivePhase(spawn.lifecycle.phase)) return false;
  return (await branchMergeReadiness(branch)).kind !== "nothing";
}

/**
 * Merge the spawn's branch through the same path `merge_cowboy_branch` takes,
 * then rebuild the actions list: a merge that landed leaves nothing to merge.
 */
function mergeAgentBranch(
  ctx: ExtensionCommandContext,
  spawn: AgentSpawn,
  branch: string,
  reopen: () => void,
): void {
  const action = actionReport(ctx.ui);
  action.pending(`Merging agent ${spawn.id}'s branch ${branch}`);
  void (async () => {
    try {
      const merged = await mergeSingleBranch(ctx, { branch });
      action.outcome(mergeSeverity(merged.outcome), merged.text);
    } catch (err) {
      action.failed(
        `Failed to merge agent ${spawn.id}'s branch ${branch}`,
        err,
      );
    } finally {
      reopen();
    }
  })();
}

async function showTextViewer(
  ctx: ExtensionCommandContext,
  spawn: AgentSpawn,
  kind: "result" | "error",
  text: string,
): Promise<void> {
  const titleSuffix = kind === "result" ? spawn.id : "Error";
  const textLines = text.split("\n");
  const displayName = getDisplayName(spawn.display.type);
  const chromeLines = 5; // top border + title + sep + footer + bottom border
  const MIN_VIEWPORT = 3;
  const VIEWPORT_HEIGHT_PCT = 70;
  let scrollOffset = 0;
  let autoScroll = true;

  await new ScreenHost(ctx).openOverlay<void>(({ tui, theme, close }) => {
    const border = theme.fg("border", "│");

    const viewportHeight = () => {
      const maxRows = Math.floor(
        (tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100,
      );
      return Math.max(MIN_VIEWPORT, maxRows - chromeLines);
    };

    return {
      invalidate() {},
      render(width: number) {
        const innerW = width - 4;
        const out: string[] = [
          theme.fg("border", `\u256d${"\u2500".repeat(width - 2)}\u256e`),
        ];

        const titleStr = theme.bold(
          theme.fg("accent", `${displayName} \u00b7 ${titleSuffix}`),
        );
        const titlePad = Math.max(0, innerW - visibleWidth(titleStr));
        out.push(
          `${border} ${truncateToWidth(titleStr + " ".repeat(titlePad), innerW, "...", true)} ${border}`,
        );

        out.push(
          `${border} ${theme.fg("dim", "\u2500".repeat(innerW))} ${border}`,
        );

        const vp = viewportHeight();
        const maxScroll = Math.max(0, textLines.length - vp);
        if (autoScroll) scrollOffset = maxScroll;
        const vs = Math.min(scrollOffset, maxScroll);
        const visible = textLines.slice(vs, vs + vp);

        for (let i = 0; i < vp; i++) {
          const line = visible[i] ?? "";
          const truncated = truncateToWidth(line, innerW, "...", true);
          const padLen = Math.max(0, innerW - visibleWidth(truncated));
          out.push(`${border} ${truncated}${" ".repeat(padLen)} ${border}`);
        }

        const scrollPct =
          textLines.length <= vp
            ? "100%"
            : `${Math.round(((vs + vp) / textLines.length) * 100)}%`;
        const count = theme.fg(
          "dim",
          `${textLines.length} lines \u00b7 ${scrollPct}`,
        );
        const footerText = theme.fg("dim", "q/Esc close");
        const gap = Math.max(
          1,
          innerW - visibleWidth(count) - visibleWidth(footerText),
        );
        out.push(`${border} ${count}${" ".repeat(gap)}${footerText} ${border}`);

        out.push(
          theme.fg("border", `\u2570${"\u2500".repeat(width - 2)}\u256f`),
        );
        return out;
      },
      handleInput(data: string) {
        if (matchesKey(data, "q") || matchesKey(data, "escape")) {
          close();
          return;
        }

        const vp = viewportHeight();
        const maxScroll = Math.max(0, textLines.length - vp);

        if (matchesKey(data, "up")) {
          scrollOffset = Math.max(0, scrollOffset - 1);
          autoScroll = scrollOffset >= maxScroll;
        } else if (matchesKey(data, "down")) {
          scrollOffset = Math.min(maxScroll, scrollOffset + 1);
          autoScroll = scrollOffset >= maxScroll;
        } else if (matchesKey(data, "pageUp")) {
          scrollOffset = Math.max(0, scrollOffset - vp);
          autoScroll = false;
        } else if (matchesKey(data, "pageDown")) {
          scrollOffset = Math.min(maxScroll, scrollOffset + vp);
          autoScroll = scrollOffset >= maxScroll;
        } else if (matchesKey(data, "home") || data === "g") {
          scrollOffset = 0;
          autoScroll = false;
        } else if (data === "G") {
          scrollOffset = maxScroll;
          autoScroll = true;
        }
      },
    };
  });
}

/**
 * Stop agents without holding the menu open, and report the outcome once each
 * stop settles. A stop waits on herdr's registry and the run's settle pass, so
 * callers hand the UI back first and read the verdict here.
 */
function stopAgentsOffMenu(
  ctx: ExtensionCommandContext,
  ids: readonly string[],
): void {
  const manager = getManagerOrNull();
  const subject = agentSubject(ids);
  const action = actionReport(ctx.ui);
  if (!manager) {
    action.failed(`Failed to stop ${subject}`, "manager unavailable");
    return;
  }
  void (async () => {
    let stopped = 0;
    const notStopped: { id: string; reason: string }[] = [];
    for (const id of ids) {
      try {
        if (await manager.abort(id, "user")) stopped += 1;
        // A false verdict means the run settled before the stop reached it.
        else notStopped.push({ id, reason: "already settled" });
      } catch (err) {
        notStopped.push({ id, reason: errorMessage(err) });
      }
    }
    if (notStopped.length === 0) {
      action.succeeded(
        ids.length === 1
          ? `Stopped ${ids[0]}`
          : `Stopped ${ids.length} agent(s)`,
      );
      return;
    }
    const summary = notStopped
      .map(({ id, reason }) =>
        ids.length === 1 ? reason : `${id} (${reason})`,
      )
      .join(", ");
    if (stopped > 0) {
      action.succeeded(
        `Stopped ${stopped} of ${ids.length} agent(s); ${summary}`,
        "warning",
      );
    } else {
      action.failed(`Failed to stop ${subject}`, summary);
    }
  })();
}

/**
 * Per-agent actions submenu for a delegating component.
 * @param done — return to the parent agent list.
 * @param onClose — close the entire menu.
 * @param beginCleanup — start the two-phase cleanup flow over these ids.
 * @param beginHandover — open the handover sub-flow for this agent.
 * @param beginExport — open the export sub-flow for this agent.
 * @param offerMerge — show the merge row: the branch still has commits to merge.
 * @param reopen — rebuild this list from the spawn's current state.
 */
export function buildAgentActionsList(
  ctx: ExtensionCommandContext,
  spawn: AgentSpawn,
  theme: Theme,
  done: () => void,
  onClose: () => void,
  beginCleanup: (ids: readonly string[]) => void,
  beginHandover: (spawn: AgentSpawn) => void,
  beginExport: (spawn: AgentSpawn) => void,
  offerMerge: boolean,
  reopen: () => void,
): SelectList {
  const items: SelectItem[] = [];
  // Spawn id is the full handle — printed whole, never sliced.
  const id = spawn.id;
  const activeSpawn = isActivePhase(spawn.lifecycle.phase);
  const hasHerdrPane = spawn.execution.host !== undefined;
  // Result/error exist only on the settled outcome.
  const resultText = lifecycleResult(spawn.lifecycle);
  const errorText =
    hasOutcome(spawn.lifecycle) && spawn.lifecycle.status === "error"
      ? spawn.lifecycle.error
      : "";
  const hasResult = resultText.length > 0;
  const hasError = errorText.length > 0;
  // Only a harness with a record reader can produce an export, and only a run
  // that launched one has a session to read.
  const harness =
    spawn.execution.harness === undefined
      ? undefined
      : getHarnessRegistry().get(spawn.execution.harness);
  const canExport =
    hasHerdrPane && harness !== undefined && canReadHandoverRecords(harness);
  const branch = worktreeBranch(spawn);

  if (hasHerdrPane) {
    items.push({
      value: "focus-pane",
      label: "View shell",
      description: "Focus the subagent's herdr pane",
    });
  }
  if (hasResult) {
    items.push({ value: "view-result", label: "View result" });
  }
  if (hasError) {
    items.push({ value: "view-error", label: "View error" });
  }
  // Opening the report hands it to the desktop, so it is offered only where
  // macOS's `open` exists and the run has actually written something.
  if (
    openableResultFile(subagentResultFileFor(id), process.platform) !==
    undefined
  ) {
    items.push({
      value: "open-result-file",
      label: "Open result file",
      description: "Open the agent's result file in the default application",
    });
  }
  if (offerMerge && branch !== undefined) {
    items.push({
      value: "merge",
      label: "Merge",
      description: "Merge its branch into main (same as merge_cowboy_branch)",
    });
  }
  // Handover is offered for every agent: a run still in flight is stopped
  // first, after the sub-flow's confirmation.
  items.push({
    value: "handover",
    label: "Handover",
    description: "Hand this run's session to another harness",
  });
  // Export never touches the agent, so a live run is exported as it works.
  if (canExport) {
    items.push({
      value: "export",
      label: "Export",
      description:
        "Copy this run's handover text to the clipboard or write it to a file",
    });
  }
  if (activeSpawn) {
    items.push({ value: "stop", label: "Stop" });
  } else {
    items.push({
      value: "cleanup",
      label: "Clean up",
      description: "Close its pane and remove its worktree and merged branch",
    });
  }

  if (items.length === 0) {
    ctx.ui.notify(`Agent ${id} — no actions available`, "info");
    done();
    return new SelectList([], 5, buildSelectListTheme(theme));
  }

  const list = withVimKeys(
    new SelectList(items, 10, buildSelectListTheme(theme)),
  );
  list.onSelect = async (item) => {
    if (item.value === "focus-pane") {
      await focusHerdrPane(ctx, spawn);
    } else if (item.value === "view-result") {
      await showTextViewer(ctx, spawn, "result", resultText);
    } else if (item.value === "view-error") {
      await showTextViewer(ctx, spawn, "error", errorText);
    } else if (item.value === "open-result-file") {
      await openResultFile(ctx, spawn);
    } else if (item.value === "merge" && branch !== undefined) {
      // The merge reports its own outcome, then rebuilds this list: a landed
      // merge leaves the row nothing to merge.
      mergeAgentBranch(ctx, spawn, branch, reopen);
    } else if (item.value === "stop") {
      actionReport(ctx.ui).pending(`Stopping agent ${id}`);
      done();
      stopAgentsOffMenu(ctx, [spawn.id]);
    } else if (item.value === "cleanup") {
      // The flow keeps the menu open for the force decision, then hands the
      // teardown back to run off-menu; it reports every outcome itself.
      beginCleanup([spawn.id]);
    } else if (item.value === "handover") {
      // The sub-flow keeps the menu open through the target choice and the
      // overwrite confirmation; a target closes it before anything moves.
      beginHandover(spawn);
    } else if (item.value === "export") {
      // Export keeps the menu open until something has actually been exported.
      beginExport(spawn);
    }
  };
  list.onCancel = () => done();
  return list;
}

/** A body that shows nothing while a level has yet to build its own. */
const EMPTY_BODY: Component = {
  invalidate() {},
  render: (): string[] => [],
  handleInput: () => {},
};

/**
 * One level's body, with the dialogs a flow shows in its place.
 *
 * `mount` takes the level's own body, `show` puts a dialog where that body was,
 * and `restore` puts it back — so a flow is a state of the screen it was
 * started from, never a place of its own, and a dialog's pages are the same
 * screen's pages rather than levels to rewind one by one. Both swaps step
 * aside once that screen is gone: a flow the user left changes nothing, which
 * leaves the work it started with only its outcome to report.
 */
interface LevelFlow {
  /** Show `content` as the level's body, and hand back what the level mounts. */
  mount: (content: Component) => Component;
  /** Show `dialog` in place of that body; false when the screen is gone. */
  show: (dialog: Component) => boolean;
  /** Put the level's own body back; false when the screen is gone. */
  restore: () => boolean;
}

function createFlow(tui: TUI, stillHere: () => boolean): LevelFlow {
  const view = new SwappableView(EMPTY_BODY);
  let own: Component = EMPTY_BODY;
  const swap = (body: Component): boolean => {
    if (!stillHere()) return false;
    view.activate(body);
    tui.requestRender();
    return true;
  };
  return {
    mount: (content) => {
      own = content;
      view.activate(content);
      return view;
    },
    show: swap,
    restore: () => swap(own),
  };
}

/** The agent list (the level's root) and one agent's actions above it. */
export function agentStatusLevel(ctx: ExtensionCommandContext): MenuLevel {
  return ({ tui, theme, nav, stillHere }) => {
    // Settled spawns outlive their session, so list them here.
    const initial = getManagerOrNull()?.listAgents(ALL_AGENT_PHASES) ?? [];
    if (initial.length === 0) {
      ctx.ui.notify("No agents have been spawned this session", "info");
      // Nothing to show: the level the row pushed is stepped out of.
      nav.pop();
      return EMPTY_BODY;
    }

    // Re-read on every build: a cleanup drops the spawns whose artifacts it removed.
    const agents = initial;
    const activeAgents = (): AgentSpawn[] =>
      agents.filter((r) => isActivePhase(r.lifecycle.phase));
    const finishedAgents = (): AgentSpawn[] =>
      agents.filter((r) => !isActivePhase(r.lifecycle.phase));
    const completedAgents = (): AgentSpawn[] =>
      agents.filter(
        (r) => hasOutcome(r.lifecycle) && r.lifecycle.status === "completed",
      );

    const buildAgentItems = (): SelectItem[] => {
      // One timestamp for every row keeps durations mutually consistent.
      const now = Date.now();
      const items: SelectItem[] = agents.map((spawn) => {
        // Finished runs freeze at completion (completedAt is stamped on every terminal path).
        const status = lifecycleStatus(spawn.lifecycle);
        const active = isActivePhase(spawn.lifecycle.phase);
        const end = hasOutcome(spawn.lifecycle)
          ? spawn.lifecycle.completedAt
          : now;
        const duration = formatMs(end - lifecycleStartTime(spawn.lifecycle));
        const icon = statusIcon(status, theme);
        const headline = spawn.display.description
          ? spawn.display.description
          : "";
        // A queued spawn has not engaged a harness yet.
        const harness = spawn.execution.harness;
        const worktree = spawn.display.worktree;
        const fields = [
          `${icon} ${spawn.id}`,
          ...(harness === undefined ? [] : [harness]),
          spawn.display.type,
          status,
          duration,
          ...(worktree === undefined ? [] : [`wt:${worktree.branch}`]),
          ...(headline === "" ? [] : [`\u2014 ${headline}`]),
          ...(active ? [] : [`${formatMs(now - end)} ago`]),
        ];
        return {
          value: spawn.id,
          label: fields.join(agentFieldSeparator(theme)),
        };
      });
      const active = activeAgents();
      const finished = finishedAgents();
      const completed = completedAgents();
      if (active.length > 0) {
        items.push({ value: SEPARATOR_ID, label: " " });
        items.push({
          value: "__stop-all",
          label: `Stop ${active.length} active agent(s)`,
        });
      }
      if (finished.length > 0) {
        items.push({ value: SEPARATOR_ID, label: " " });
        items.push({
          value: "__cleanup-finished",
          label: `Clean up ${finished.length} settled agent(s)`,
        });
        // The completed-only filter over the same path; only when one exists.
        if (completed.length > 0) {
          items.push({
            value: "__cleanup-completed",
            label: `Clean up ${completed.length} completed agent(s)`,
          });
        }
      }
      return items;
    };

    const agentList = withVimKeys(
      new SelectList(buildAgentItems(), 15, buildSelectListTheme(theme)),
    );
    // SelectList never lands on separators itself.
    installSeparatorSkip(asListFields<SelectItem>(agentList));

    /** Show the agent list again, rebuilt from the fleet as it is now. */
    const rerunList = (): void => nav.refresh();

    /** Leave one agent's actions, back on the list. */
    const backToList = (): void => nav.pop();

    const flow = createFlow(tui, stillHere);

    const beginCleanupFromList = (ids: readonly string[]): void => {
      // The dialogs show where the list was, so leaving the flow and showing
      // the list again are one step — rebuilt, because the rows it swept are
      // gone — and only while that list is still the screen the user is on.
      const leaveToList = (): void => {
        if (!stillHere()) return;
        rerunList();
      };
      createStatusCleanup({
        ctx,
        theme,
        show: flow.show,
        showList: leaveToList,
        back: leaveToList,
      })(ids);
    };

    /** One agent's actions: the second level. */
    const actionsLevel =
      (spawn: AgentSpawn): MenuLevel =>
      async ({ stillHere: stillOnActions }) => {
        const branch = worktreeBranch(spawn);
        const merge = branch !== undefined && (await offerMerge(spawn, branch));
        if (!stillOnActions()) return EMPTY_BODY;
        const flow = createFlow(tui, stillOnActions);

        const beginCleanupFromActions = (ids: readonly string[]): void => {
          createStatusCleanup({
            ctx,
            theme,
            show: flow.show,
            // A declined offer ends on the list, whose row carries the reason.
            showList: () => {
              if (!stillOnActions()) return;
              nav.pop();
              rerunList();
            },
            // A sweep is settled: the actions it was asked from are back.
            back: flow.restore,
          })(ids);
        };

        const beginHandover = (target: AgentSpawn): void => {
          createStatusHandover({
            ctx,
            theme,
            show: flow.show,
            leave: flow.restore,
          })(target);
        };

        const beginExport = (target: AgentSpawn): void => {
          createStatusExport({
            ctx,
            theme,
            show: flow.show,
            leave: flow.restore,
          })(target);
        };

        return flow.mount(
          buildAgentActionsList(
            ctx,
            spawn,
            theme,
            backToList,
            () => nav.close(),
            beginCleanupFromActions,
            beginHandover,
            beginExport,
            merge,
            () => nav.refresh(),
          ),
        );
      };

    agentList.onSelect = (item) => {
      if (item.value === "__stop-all") {
        const active = activeAgents();
        actionReport(ctx.ui).pending(`Stopping ${active.length} agent(s)`);
        // The list is the level the stop was asked from: one step up is out.
        nav.pop();
        stopAgentsOffMenu(
          ctx,
          active.map((r) => r.id),
        );
        return;
      }
      if (item.value === "__cleanup-finished") {
        beginCleanupFromList(finishedAgents().map((r) => r.id));
        return;
      }
      if (item.value === "__cleanup-completed") {
        beginCleanupFromList(completedAgents().map((r) => r.id));
        return;
      }
      const spawn = agents.find((r) => r.id === item.value);
      if (spawn) {
        nav.push(actionsLevel(spawn));
      }
    };
    agentList.onCancel = () => nav.pop();

    return flow.mount(
      new SettingsListWrapper(agentList, {
        title: "Status",
        theme,
        passthroughKeys: true,
      }),
    );
  };
}

/** The `/cowboy status` command: the agent list on a menu of its own. */
export async function showAgentStatusMenu(
  ctx: ExtensionCommandContext,
): Promise<void> {
  await new MenuSession(ctx).run(agentStatusLevel(ctx));
}
