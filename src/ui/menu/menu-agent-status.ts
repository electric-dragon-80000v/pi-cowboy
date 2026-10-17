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
  type SelectItem,
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

import { errorMessage } from "../../utils.js";
import {
  getDisplayName,
  agentBulletPrefix,
  formatMs,
  statusIcon,
} from "../format.js";
import { getManagerOrNull, getRuntime } from "../../shell.js";
import type { Theme } from "../types.js";
import { ScreenHost, SwappableView, asListFields } from "./screen-host.js";
import { createStatusCleanup } from "./menu-agent-status-cleanup.js";
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
 */
export function buildAgentActionsList(
  ctx: ExtensionCommandContext,
  spawn: AgentSpawn,
  theme: Theme,
  done: () => void,
  onClose: () => void,
  beginCleanup: (ids: readonly string[]) => void,
): SelectList {
  const items: SelectItem[] = [];
  // Spawn id is the full handle — printed whole, never sliced.
  const id = spawn.id;
  const activeSpawn = isActivePhase(spawn.lifecycle.phase);
  const hasHerdrPane = !!spawn.execution.host;
  // Result/error exist only on the settled outcome.
  const resultText = lifecycleResult(spawn.lifecycle);
  const errorText =
    hasOutcome(spawn.lifecycle) && spawn.lifecycle.status === "error"
      ? spawn.lifecycle.error
      : "";
  const hasResult = resultText.length > 0;
  const hasError = errorText.length > 0;

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
    } else if (item.value === "stop") {
      actionReport(ctx.ui).pending(`Stopping agent ${id}`);
      done();
      stopAgentsOffMenu(ctx, [spawn.id]);
    } else if (item.value === "cleanup") {
      // The flow keeps the menu open for the force decision, then hands the
      // teardown back to run off-menu; it reports every outcome itself.
      beginCleanup([spawn.id]);
    }
  };
  list.onCancel = () => done();
  return list;
}

export async function showAgentStatusMenu(
  ctx: ExtensionCommandContext,
): Promise<void> {
  // Settled spawns outlive their session, so list them here.
  if ((getManagerOrNull()?.listAgents(ALL_AGENT_PHASES) ?? []).length === 0) {
    ctx.ui.notify("No agents have been spawned this session", "info");
    return;
  }

  await new ScreenHost(ctx).open<void>(({ tui, theme, close }) => {
    // Re-read on refresh: a cleanup drops the spawns whose artifacts it removed.
    let agents = getManagerOrNull()?.listAgents(ALL_AGENT_PHASES) ?? [];
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
        const ago = active ? "" : ` ${formatMs(now - end)} ago`;
        const icon = statusIcon(status, theme);
        const headline = spawn.display.description
          ? spawn.display.description
          : "";
        const suffix = headline ? ` \u2014 ${headline}` : "";
        const bullet = agentBulletPrefix(theme);
        const wtInfo = spawn.display.worktree
          ? `  wt:${spawn.display.worktree.branch}`
          : "";
        return {
          value: spawn.id,
          label: `${icon} ${spawn.id}  ${bullet}${spawn.display.type}  ${status}  ${duration}${wtInfo}${suffix}${ago}`,
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

    const view = new SwappableView(agentList);

    /** Repaint: pi-tui redraws on input, but a swap driven by an async pass has none. */
    const requestRender = (): void => tui.requestRender();

    /** Re-read the fleet and rebuild the rows in place (removed agents drop out), keeping the cursor on `focusId` when it survives. */
    const refresh = (focusId?: string): void => {
      agents = getManagerOrNull()?.listAgents(ALL_AGENT_PHASES) ?? [];
      const fields = asListFields<SelectItem>(agentList);
      const items = buildAgentItems();
      fields.items = items;
      fields.filteredItems = items;
      const at = focusId
        ? items.findIndex((item) => item.value === focusId)
        : -1;
      agentList.setSelectedIndex(at >= 0 ? at : 0);
      view.activate(agentList);
      requestRender();
    };

    // The two-phase cleanup flow owns the force dialogs; the menu stays open
    // through the decision and only a clean sweep (or a confirmed force) closes.
    const beginCleanup = createStatusCleanup({
      ctx,
      theme,
      view,
      refresh,
      close,
      requestRender,
    });

    agentList.onSelect = async (item) => {
      if (item.value === "__stop-all") {
        const active = activeAgents();
        actionReport(ctx.ui).pending(`Stopping ${active.length} agent(s)`);
        close();
        stopAgentsOffMenu(
          ctx,
          active.map((r) => r.id),
        );
        return;
      }
      if (item.value === "__cleanup-finished") {
        beginCleanup(finishedAgents().map((r) => r.id));
        return;
      }
      if (item.value === "__cleanup-completed") {
        beginCleanup(completedAgents().map((r) => r.id));
        return;
      }
      const spawn = agents.find((r) => r.id === item.value);
      if (spawn) {
        view.activate(
          buildAgentActionsList(
            ctx,
            spawn,
            theme,
            () => refresh(spawn.id),
            () => close(),
            beginCleanup,
          ),
        );
      }
    };
    agentList.onCancel = () => close();

    return new SettingsListWrapper(view, {
      title: "Status",
      theme,
      passthroughKeys: true,
    });
  });
}
