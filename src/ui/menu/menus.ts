/**
 * menus.ts — /cowboy command dispatcher: main menu and settings menu.
 * Picker rows host their submenu in place; the status/spawn/settings rows
 * close this list and hand off to a full-screen flow (cf. buildAgentActionsList),
 * which showAgentsActionMenu also opens for a `/cowboy status|spawn` subcommand.
 * The Enabled switch closes the main menu, and while the extension is off it is
 * the whole of it.
 * Exports: showAgentsMainMenu, showAgentsActionMenu, showSettingsMenu,
 * showSpawnAgentMenu (re-export).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { getStore } from "../../shell.js";
import { setExtensionEnabled } from "../../registration.js";
import { setShowActiveIndicator } from "../../extension-toggle.js";
import { getPiDefaultThinkingLevel } from "../../pi-settings.js";
import { buildSettingsListTheme, type Notify } from "./helpers.js";
import { CLOSED_SUBMENU, ScreenHost } from "./screen-host.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { buildModelOverridesRow } from "./menu-model-settings.js";
import { showConcurrencySettingsMenu } from "./menu-concurrency.js";
import { showAgentStatusMenu } from "./menu-agent-status.js";
import { showSpawnOptionsMenu } from "./menu-agent-settings.js";
import {
  buildDefaultAgentTypeRow,
  buildDefaultOrchestratorRow,
} from "./menu-spawn-defaults.js";
import { showSystemPromptMenu } from "./menu-system-prompt.js";

import { showSpawnAgentMenu } from "./menu-spawn-wizard.js";
export { showSpawnAgentMenu };

/** Rows of the Settings screen that hand off to a full-screen flow. */
type SettingsAction = "concurrency" | "spawnoptions" | "systemprompt";

/**
 * Settings list: the screens, then the indicator switches. Resolves with the
 * flow to open, or undefined on cancel.
 */
async function showSettingsList(
  ctx: ExtensionCommandContext,
): Promise<SettingsAction | undefined> {
  return await new ScreenHost(ctx).open<SettingsAction>(({ theme, close }) => {
    const handOff = (action: SettingsAction): void => close(action);
    const store = getStore();
    const shown = store.agent.showActiveIndicator;
    const grazing = store.agent.grazingEnabled;
    const items: SettingItem[] = [
      handOffRow(
        "concurrency",
        "Concurrency Settings",
        "Set per-model slot limits",
        handOff,
      ),
      handOffRow(
        "spawnoptions",
        "Agent behavior",
        "spawn defaults, results delivery, output, tools, worktrees",
        handOff,
      ),
      handOffRow(
        "systemprompt",
        "System prompt",
        "Prompt mode, AGENTS.md, skills, extensions",
        handOff,
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
    const settingsList = new SettingsList(
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
      close,
    );
    return new SettingsListWrapper(settingsList, {
      title: "Settings",
      theme,
      onCancel: close,
    });
  });
}

export async function showSettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  while (true) {
    const action = await showSettingsList(ctx);
    if (action === undefined) return;
    switch (action) {
      case "concurrency":
        await showConcurrencySettingsMenu(ctx, modelOptions);
        break;
      case "spawnoptions":
        await showSpawnOptionsMenu(ctx);
        break;
      case "systemprompt":
        await showSystemPromptMenu(ctx);
        break;
    }
  }
}

/** Rows that hand off to a full-screen flow. */
type AgentsMainAction = "status" | "spawn" | "settings";

/**
 * Opens the flow a topmost row hands off to, and the one a `/cowboy status` or
 * `/cowboy spawn` subcommand reaches directly.
 */
export async function showAgentsActionMenu(
  ctx: ExtensionCommandContext,
  action: AgentsMainAction,
  modelOptions: string[],
): Promise<void> {
  switch (action) {
    case "status":
      await showAgentStatusMenu(ctx);
      break;
    case "spawn":
      await showSpawnAgentMenu(ctx, modelOptions);
      break;
    case "settings":
      await showSettingsMenu(ctx, modelOptions);
      break;
  }
}

/** Row that resolves the list with `handOff` and renders nothing (CLOSED_SUBMENU). */
function handOffRow<A extends string>(
  action: A,
  label: string,
  description: string,
  handOff: (action: A) => void,
): SettingItem {
  return {
    id: action,
    label,
    description,
    currentValue: "",
    submenu: () => {
      handOff(action);
      return CLOSED_SUBMENU;
    },
  };
}

/** Topmost menu. Resolves with the action to run, or undefined on cancel. */
async function showAgentsMainList(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<AgentsMainAction | undefined> {
  // Resolved once here because the model screen's submenu factory is synchronous.
  const piDefaultThinking = await getPiDefaultThinkingLevel(ctx.cwd);
  let rebuild: ((items: SettingItem[], focusId?: string) => void) | undefined;

  return await new ScreenHost(ctx).open<AgentsMainAction>(
    ({ theme, close }) => {
      const handOff = (action: AgentsMainAction): void => close(action);
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
            modelOptions,
            piDefaultThinking,
          }),
          buildDefaultOrchestratorRow({ store, theme, notify }),
          buildDefaultAgentTypeRow({ store, theme, notify }),
          handOffRow(
            "status",
            "Status",
            "List spawned, queued and settled agents",
            handOff,
          ),
          handOffRow(
            "spawn",
            "Spawn agent",
            "Manually spawn a new agent",
            handOff,
          ),
          handOffRow(
            "settings",
            "Settings",
            "Concurrency, agent behavior, and system prompt settings",
            handOff,
          ),
          switchRow,
        ];
      };

      const settingsList = new SettingsList(
        buildItems(),
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
        close,
      );
      return new SettingsListWrapper(settingsList, {
        title: "Agents",
        theme,
        onCancel: close,
        onRebuild: (r) => {
          rebuild = r;
        },
      });
    },
  );
}

export async function showAgentsMainMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  while (true) {
    const action = await showAgentsMainList(ctx, modelOptions);
    if (action === undefined) return;
    await showAgentsActionMenu(ctx, action, modelOptions);
  }
}
