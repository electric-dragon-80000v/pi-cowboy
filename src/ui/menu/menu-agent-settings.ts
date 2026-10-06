/**
 * menu-agent-settings.ts — the spawn-options screen: spawn defaults, delivery,
 * worktrees, and tools.
 *
 * SettingsList keeps cursor state internally (ctx.ui.select resets it).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  SettingsList,
  SelectList,
  Input,
  type SettingItem,
  type Component,
} from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "../../types.js";
import type { Theme } from "../types.js";
import { VALID_THINKING_LEVELS } from "../../utils.js";
import { defaultWorktreeRoot } from "../../paths.js";
import {
  HARNESS_IDS,
  parseHarnessId,
  type HarnessId,
} from "../../agents/harness.js";
import {
  isAvailable,
  selectable,
  type Availability,
} from "../../availability.js";
import {
  parseWorktreeCheckoutType,
  parseWorktreeMaterialization,
  VALID_WORKTREE_CHECKOUT_TYPES,
  VALID_WORKTREE_MATERIALIZATIONS,
} from "../../spawn/worktree-policy.js";
import {
  getCowAvailability,
  getHarnessAvailability,
  getHarnessType,
  getPiInstance,
  getStore,
  getWorktreeMaterialization,
} from "../../shell.js";
import { refreshCowSupportProbe } from "../../cow-support-launch.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { ScreenHost } from "./screen-host.js";
import { createTargetSelectSubmenu } from "./submenus/target-select.js";
import {
  SEPARATOR_ID,
  buildSettingsListTheme,
  buildSelectListTheme,
  headerItem,
  withVimKeys,
} from "./helpers.js";

/**
 * The harness row's description. Narrows with the row: an unlaunchable harness is
 * named as missing rather than silently absent from the values.
 */
function harnessDescription(availability: Availability<HarnessId>): string {
  const base =
    "Harness that launches agents whose template omits harness_type. pi = the real pi binary; pig and pi-bolt = pi-compatible binaries launched through a shell function in the agent's own pane.";
  const missing = HARNESS_IDS.filter(
    (id) => id !== "pi" && !isAvailable(id, availability),
  );
  return missing.length === 0
    ? base
    : `${base} Not on PATH: ${missing.join(", ")}.`;
}

export async function showSpawnOptionsMenu(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const store = getStore();
  /** " [project]" when the effective value comes from the project layer. */
  const projectTag = (key: string): string =>
    store.hasProjectModelKey(key) ? " [project]" : "";

  /** Submenu: pick a persisted layer (global or project), then edit the value. No session target. */
  const persistedTargetSubmenu = (
    theme: Theme,
    onPick: (
      target: "global" | "project",
      pickDone: (selectedValue?: string) => void,
    ) => Component | void,
  ) =>
    createTargetSelectSubmenu({
      theme,
      projectOffered: store.isProjectWritable,
      includeSession: false,
      // Narrow TargetChoice: only global/project are offered here.
      onPick: (target, pickDone) =>
        onPick(target as "global" | "project", pickDone),
    });

  const buildItems = (theme: Theme): SettingItem[] => {
    return [
      headerItem(theme, "Spawn defaults"),
      { id: SEPARATOR_ID, label: " ", currentValue: "" },
      {
        id: "defaultThinking",
        label: "Default thinking level",
        currentValue: `${store.agent.defaultThinking ?? "inherit"}${projectTag("defaultThinking")}`,

        submenu: persistedTargetSubmenu(theme, (target, pickDone) => {
          const levelItems = [...VALID_THINKING_LEVELS, "inherit"].map((v) => ({
            value: v,
            label: v,
          }));
          const list = withVimKeys(
            new SelectList(levelItems, 10, buildSelectListTheme(theme)),
          );
          list.onSelect = (item) => {
            store.mutate.agent.setDefaultThinking(
              item.value === "inherit"
                ? undefined
                : (item.value as ThinkingLevel),
              target,
            );
            ctx.ui.notify(
              `Default thinking level set to ${item.value} (${target})`,
              "info",
            );
            pickDone(item.value);
          };
          list.onCancel = () => pickDone();
          return list;
        }),
        description: "Thinking level applied when an agent template omits one.",
      },
      {
        id: "harnessType",
        label: "Default harness",
        currentValue: getHarnessType(),
        values: [...selectable(HARNESS_IDS, getHarnessAvailability())],
        description: harnessDescription(getHarnessAvailability()),
      },
      { id: SEPARATOR_ID, label: " ", currentValue: "" },
      headerItem(theme, "Worktrees"),
      {
        id: "worktreeRoot",
        label: "Worktree root",
        currentValue: store.agent.worktreeRoot ?? "(default)",
        submenu: (initialValue: string, done: (value?: string) => void) => {
          const input = new Input();
          input.setValue(initialValue === "(default)" ? "" : initialValue);
          input.onSubmit = (value: string) => {
            const trimmed = value.trim();
            store.mutate.agent.setWorktreeRoot(trimmed || undefined);
            // The new root may sit on another volume; the launch probe answered
            // for the old one, and nothing else refreshes it.
            refreshCowSupportProbe(getPiInstance());
            ctx.ui.notify(
              trimmed
                ? `Worktree root set to ${trimmed}`
                : "Worktree root cleared (default)",
              "info",
            );
            done(trimmed || "(default)");
          };
          input.onEscape = () => done();
          return input;
        },
        description: `Where worktrees are created. Blank = ${defaultWorktreeRoot()}.`,
      },
      {
        id: "worktreeMaterialization",
        label: "Worktree materialization",
        currentValue: getWorktreeMaterialization(),
        values: [
          ...selectable(VALID_WORKTREE_MATERIALIZATIONS, getCowAvailability()),
        ],
        description: isAvailable("copy-on-write", getCowAvailability())
          ? "Copy-on-write = clone of the parent working tree (shares node_modules, .env). checkout = git's classic checkout, nothing shared."
          : "This volume cannot clone, so copy-on-write is unavailable and new worktrees use git's classic checkout.",
      },
      {
        id: "worktreeCheckoutType",
        label: "Worktree checkout",
        currentValue: store.agent.worktreeCheckoutType,
        values: [...VALID_WORKTREE_CHECKOUT_TYPES],
        description:
          "Where a new worktree's checkout starts when the parent has uncommitted work. clean = tracked files come from HEAD and only ignored files like node_modules and .env are copied, leaving the parent's edits and untracked files out. dirty = the whole parent working tree is cloned, so its edits and untracked files ride along. A clean parent is always cloned whole, whichever value is set.",
      },
      { id: SEPARATOR_ID, label: " ", currentValue: "" },
      headerItem(theme, "Tools"),
      {
        id: "disableDefaultAgents",
        label: "Disable default agents",
        currentValue: store.agent.disableDefaultAgents ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description:
          "Skip auto-loading built-in agent types next session; only .pi/agents types load.",
      },
    ];
  };

  const onChange = (id: string, newValue: string) => {
    switch (id) {
      case "worktreeRoot":
        break;
      case "worktreeMaterialization": {
        const materialization = parseWorktreeMaterialization(newValue);
        if (materialization !== undefined) {
          store.mutate.agent.setWorktreeMaterialization(materialization);
          ctx.ui.notify(
            `Worktree materialization set to ${materialization}`,
            "info",
          );
        }
        break;
      }
      case "worktreeCheckoutType": {
        const policy = parseWorktreeCheckoutType(newValue);
        if (policy !== undefined) {
          store.mutate.agent.setWorktreeCheckoutType(policy);
          ctx.ui.notify(`Worktree checkout set to ${policy}`, "info");
        }
        break;
      }
      case "harnessType": {
        const harnessType = parseHarnessId(newValue);
        if (harnessType !== undefined) {
          store.mutate.agent.setHarnessType(harnessType);
          ctx.ui.notify(`Default harness set to ${harnessType}`, "info");
        }
        break;
      }
      case "disableDefaultAgents":
        store.mutate.agent.setDisableDefaultAgents(newValue === "ON");
        ctx.ui.notify(
          `Disable default agents ${newValue} (takes effect on next session)`,
          "info",
        );
        break;
    }
  };

  let rebuild: ((items: SettingItem[]) => void) | undefined;

  await new ScreenHost(ctx).open<void>(({ theme, close }) => {
    const items = buildItems(theme);
    const triggerRebuild = () => rebuild?.(buildItems(theme));
    const settingsList = new SettingsList(
      items,
      10,
      buildSettingsListTheme(theme),
      (id, newValue) => {
        onChange(id, newValue);
        // Submenu rows rebuild to refresh value + tag; toggle rows update in place (a rebuild would reset the cursor).
        if (items.some((i) => i.id === id && i.submenu)) triggerRebuild();
      },
      close,
    );
    return new SettingsListWrapper(settingsList, {
      title: "Agent settings",
      theme,
      onCancel: close,
      onRebuild: (r) => {
        rebuild = r;
      },
    });
  });
}
