/**
 * menus.ts — /cowboy command dispatcher: the main menu and the settings menu.
 *
 * Every row that leads somewhere pushes a level onto the menu's stack: the
 * agent list, the spawn options, a settings screen. Nothing hands the screen
 * back and waits to be reopened, so Escape on any of them is the same one step
 * up, and the stack emptying is the menu closing.
 *
 * The Enabled switch repaints the list in place, and while the extension is off
 * it is the whole of the menu.
 *
 * Exports: showAgentsMainMenu, showAgentsActionMenu, showSettingsMenu,
 * showSpawnAgentMenu (re-export).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type SettingItem } from "@earendil-works/pi-tui";
import { getStore } from "../../shell.js";
import { setExtensionEnabled } from "../../registration.js";
import type { HarnessModelOptions } from "../../agents/harness/harness-registry.js";
import { setShowActiveIndicator } from "../../extension-toggle.js";
import { getPiDefaultThinkingLevel } from "../../pi-settings.js";
import { buildSettingsListTheme, type Notify } from "./helpers.js";
import { CLOSED_SUBMENU } from "./submenu-contract.js";
import { menuSettingsList, MenuSession } from "./menu-session.js";
import type { MenuLevel } from "./menu-levels.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { buildModelOverridesRow } from "./menu-model-settings.js";
import { concurrencySettingsLevel } from "./menu-concurrency.js";
import { agentStatusLevel } from "./menu-agent-status.js";
import { spawnOptionsLevel } from "./menu-agent-settings.js";
import {
  buildDefaultAgentTypeRow,
  buildDefaultOrchestratorRow,
} from "./menu-spawn-defaults.js";
import { systemPromptLevel } from "./menu-system-prompt.js";

import { showSpawnAgentMenu, spawnWizardLevel } from "./menu-spawn-wizard.js";
export { showSpawnAgentMenu };

/**
 * Settings list: the screens, then the indicator switches. Each screen row
 * pushes its level onto the menu the user is already in.
 */
export function settingsLevel(
  ctx: ExtensionCommandContext,
  harnessModelOptions: HarnessModelOptions,
): MenuLevel {
  return ({ theme, nav }) => {
    const store = getStore();
    const shown = store.agent.showActiveIndicator;
    const grazing = store.agent.grazingEnabled;
    const items: SettingItem[] = [
      flowRow(
        "concurrency",
        "Concurrency Settings",
        "Set per-model slot limits",
        () => nav.push(concurrencySettingsLevel(ctx, harnessModelOptions)),
      ),
      flowRow(
        "spawnoptions",
        "Agent behavior",
        "spawn defaults, results delivery, output, tools, worktrees",
        () => nav.push(spawnOptionsLevel(ctx)),
      ),
      flowRow(
        "systemprompt",
        "System prompt",
        "Prompt mode, AGENTS.md, skills, extensions",
        () => nav.push(systemPromptLevel(ctx)),
      ),
      {
        id: "showActiveIndicator",
        label: "Show cowboy 🤠",
        currentValue: shown ? "ON" : "OFF",
        values: ["ON", "OFF"],
      },
      {
        id: "grazingEnabled",
        label: "Grazing 🐄",
        currentValue: grazing ? "ON" : "OFF",
        values: ["ON", "OFF"],
      },
    ];
    const settingsList = menuSettingsList(
      items,
      10,
      buildSettingsListTheme(theme),
      (id, value) => {
        if (id === "showActiveIndicator") {
          setShowActiveIndicator(ctx.ui, value === "ON");
        } else if (id === "grazingEnabled") {
          store.mutate.agent.setGrazingEnabled(value === "ON");
        }
      },
      () => nav.pop(),
      nav,
      "Settings",
    );
    return new SettingsListWrapper(settingsList, {
      title: "Settings",
      theme,
      onCancel: () => nav.pop(),
    });
  };
}

export async function showSettingsMenu(
  ctx: ExtensionCommandContext,
  _harnessModelOptions: HarnessModelOptions,
): Promise<void> {
  await new MenuSession(ctx).run(settingsLevel(ctx, _harnessModelOptions));
}

/** The flows a `/cowboy status|spawn|settings` subcommand opens directly. */
export type AgentsMainAction = "status" | "spawn" | "settings";

/**
 * Runs the level a subcommand names as the menu's root: `/cowboy status` opens
 * the agent list on an otherwise empty stack, so Escape there is the menu
 * closing, exactly as it is for the main list.
 */
export async function showAgentsActionMenu(
  ctx: ExtensionCommandContext,
  action: AgentsMainAction,
  harnessModelOptions: HarnessModelOptions,
): Promise<void> {
  await new MenuSession(ctx).run(actionRoot(ctx, action, harnessModelOptions));
}

function actionRoot(
  ctx: ExtensionCommandContext,
  action: AgentsMainAction,
  harnessModelOptions: HarnessModelOptions,
): MenuLevel {
  switch (action) {
    case "status":
      return agentStatusLevel(ctx);
    case "spawn":
      return spawnWizardLevel(ctx, harnessModelOptions);
    case "settings":
      return settingsLevel(ctx, harnessModelOptions);
  }
}

/** Row that pushes `enter`'s level and renders nothing in place (CLOSED_SUBMENU). */
function flowRow(
  id: string,
  label: string,
  description: string,
  enter: () => void,
): SettingItem {
  return {
    id,
    label,
    description,
    currentValue: "",
    submenu: () => {
      enter();
      return CLOSED_SUBMENU;
    },
  };
}

/** Topmost menu. */
export function mainLevel(
  ctx: ExtensionCommandContext,
  harnessModelOptions: HarnessModelOptions,
): MenuLevel {
  return async ({ tui, theme, nav }) => {
    // Read once per build: the model screen's row factory is synchronous.
    const piDefaultThinking = await getPiDefaultThinkingLevel(ctx.cwd);
    const buildItems = (): SettingItem[] => {
      const store = getStore();
      const notify: Notify = (message, type) => ctx.ui.notify(message, type);
      const enabled = store.agent.extensionEnabled;
      const switchRow: SettingItem = {
        id: "extensionEnabled",
        label: "Enabled",
        currentValue: enabled ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description: enabled
          ? "Unload the cowboy tools and stop subagent-result notifications. Persisted; active agents keep working."
          : "cowboy tools are unloaded and the rest of this menu is hidden. Active agents keep working.",
      };
      // Off, the switch is the whole menu: the other rows configure an
      // extension that is not running.
      if (!enabled) return [switchRow];
      return [
        buildModelOverridesRow({
          ctx,
          store,
          theme,
          harnessModelOptions,
          requestRender: () => tui.requestRender(),
          piDefaultThinking,
        }),
        buildDefaultOrchestratorRow({ store, theme, notify }),
        buildDefaultAgentTypeRow({ store, theme, notify }),
        flowRow(
          "status",
          "Status",
          "List spawned, queued and settled agents",
          () => nav.push(agentStatusLevel(ctx)),
        ),
        flowRow("spawn", "Spawn agent", "Manually spawn a new agent", () =>
          nav.push(spawnWizardLevel(ctx, harnessModelOptions)),
        ),
        flowRow(
          "settings",
          "Settings",
          "Concurrency, agent behavior, and system prompt settings",
          () => nav.push(settingsLevel(ctx, harnessModelOptions)),
        ),
        switchRow,
      ];
    };

    const items = buildItems();
    let rebuild: ((items: SettingItem[], focusId?: string) => void) | undefined;
    const settingsList = menuSettingsList(
      items,
      10,
      buildSettingsListTheme(theme),
      (id, value) => {
        const flipped = id === "extensionEnabled";
        if (flipped) {
          const enabled = value === "ON";
          setExtensionEnabled(ctx.ui, enabled);
          ctx.ui.notify(
            enabled ? "pi-cowboy enabled" : "pi-cowboy disabled",
            "info",
          );
        }
        // The row's handler already persisted, so the rebuild repaints the
        // values from the store — and after a flip, the rows it governs. The
        // switch sits at row 6 enabled and row 0 collapsed, so the flip asks
        // the rebuild to hold the cursor on it.
        rebuild?.(buildItems(), flipped ? "extensionEnabled" : undefined);
      },
      () => nav.close(),
      nav,
      "Agents",
    );
    return new SettingsListWrapper(settingsList, {
      title: "Agents",
      theme,
      onCancel: () => nav.close(),
      onRebuild: (r) => {
        rebuild = r;
      },
    });
  };
}

export async function showAgentsMainMenu(
  ctx: ExtensionCommandContext,
  harnessModelOptions: HarnessModelOptions,
): Promise<void> {
  await new MenuSession(ctx).run(mainLevel(ctx, harnessModelOptions));
}
