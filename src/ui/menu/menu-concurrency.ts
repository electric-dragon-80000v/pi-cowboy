/**
 * menu-concurrency.ts — per-harness, per-provider, and per-model slot limits (ADR-0008 target levels).
 * Values carry [session]/[project] tags when they come from those layers.
 * Exports: showConcurrencySettingsMenu.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  SettingsList,
  type Component,
  type SettingItem,
} from "@earendil-works/pi-tui";
import { getStore } from "../../shell.js";
import type { AnyHarnessId } from "../../agents/harness.js";
import {
  harnessDisplayName,
  type HarnessModelOptions,
} from "../../agents/harness/registry.js";
import { parsePoolKey } from "../../concurrency-pools.js";
import type { RawConcurrency } from "../../config/config-store.js";
import { parseModelKey } from "../../utils.js";
import type { Theme } from "../types.js";
import { formatSlotLimit } from "../format.js";
import {
  buildSettingsListTheme,
  installSeparatorSkip,
  withVimKeys,
} from "./helpers.js";
import { createNumericSubmenu } from "./submenus/numeric-input.js";
import {
  buildLevelItems,
  createClearPickerSubmenu,
  createLevelPickerSubmenu,
  createTargetSelectSubmenu,
  createClearAllSubmenu,
  type AvailableLevels,
  type SetTarget,
  type TargetChoice,
} from "./submenus/target-select.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { asListFields, asSubmenuComponent, ScreenHost } from "./screen-host.js";

/** A concurrency level the menu reads and writes. */
type ConcurrencySection = "default" | "harnesses" | "providers" | "models";

/**
 * The config key one harness's entry is stored under: pi writes the bare key,
 * so existing pi config and pools are what the pi rows edit; every other
 * harness writes "<harness>:<provider>[/<model>]".
 */
function qualifiedKey(harness: AnyHarnessId, bareKey: string): string {
  return harness === "pi" ? bareKey : `${harness}:${bareKey}`;
}

/** Configured provider or model keys grouped by the harness each key names. */
function groupKeysByHarness(keys: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const harness = parsePoolKey(key)?.harness ?? "pi";
    const list = groups.get(harness);
    if (list) list.push(key);
    else groups.set(harness, [key]);
  }
  return groups;
}

/** The section order: probed harnesses first, then any harness only a configured key names. */
function sectionHarnesses(
  probed: readonly string[],
  configured: Map<string, string[]>,
): string[] {
  const ordered = [...probed];
  for (const harness of configured.keys()) {
    if (!ordered.includes(harness)) ordered.push(harness);
  }
  return ordered;
}

export async function showConcurrencySettingsMenu(
  ctx: ExtensionCommandContext,
  harnessModelOptions: HarnessModelOptions,
): Promise<void> {
  // Every runnable harness is its own pool namespace, so each gets its own
  // section and its picker offers only the models that harness can run.
  const harnessIds = [...harnessModelOptions.keys()];
  const buildItems = (
    store: ReturnType<typeof getStore>,
    theme: Theme,
  ): SettingItem[] => {
    const items: SettingItem[] = [];
    const projectOffered = store.isProjectWritable;

    /** Whether the layer carries this concurrency entry. */
    const layerHas = (
      layer: RawConcurrency,
      section: ConcurrencySection,
      key?: string,
    ): boolean => {
      if (section === "default") return layer.default !== undefined;
      if (key === undefined) return false;
      if (section === "harnesses") {
        return layer.harnesses?.[key] !== undefined;
      }
      return layer[section]?.[key] !== undefined;
    };

    /** Layers carrying this entry; drives the remove/clear pickers. */
    const entryLevels = (
      section: ConcurrencySection,
      key?: string,
    ): AvailableLevels => ({
      session: layerHas(store.sessionConcurrency, section, key),
      global: layerHas(store.globalConcurrency, section, key),
      project: layerHas(store.projectConcurrency, section, key),
    });

    /** " [session]" / " [project]" when the effective value comes from that layer. */
    const limitTag = (section: ConcurrencySection, key?: string): string => {
      if (layerHas(store.sessionConcurrency, section, key)) return " [session]";
      if (layerHas(store.projectConcurrency, section, key)) return " [project]";
      return "";
    };

    // Target level, then numeric value.
    const targetThenValueSubmenu =
      (initial: string, onPick: (target: SetTarget, parsed: number) => void) =>
      (currentValue: string, done: (selectedValue?: string) => void) =>
        createTargetSelectSubmenu({
          theme,
          projectOffered,
          onPick: (target, pickDone) =>
            createNumericSubmenu(ctx, {
              kind: "optional",
              min: 1,
              onValid: (parsed) => onPick(target as SetTarget, parsed),
            })(initial, pickDone),
        })(currentValue, done);

    // Set at a target level, or Clear via a nested per-level picker.
    const limitSubmenu =
      (
        currentLimit: number,
        onSet: (target: SetTarget, parsed: number) => void,
        onRemove: (target: TargetChoice) => void,
        availableLevels: AvailableLevels,
      ): SettingItem["submenu"] =>
      (currentValue, done) => {
        // A fresh default has an effective value but no raw key, so Clear needs a carrier.
        const items = buildLevelItems({
          offered: { session: true, global: true, project: projectOffered },
          includeClear:
            availableLevels.session ||
            availableLevels.global ||
            availableLevels.project,
        });
        return createLevelPickerSubmenu({
          theme,
          items,
          onPick: (id, subDone) => {
            if (id === "clear") {
              return createClearPickerSubmenu({
                theme,
                projectOffered,
                availableLevels,
                onClear: onRemove,
              })("", subDone);
            }
            const target = id as SetTarget;
            return createNumericSubmenu(ctx, {
              kind: "optional",
              min: 1,
              onValid: (parsed) => onSet(target, parsed),
            })(String(currentLimit), subDone);
          },
        })(currentValue, done);
      };

    /**
     * A nested SettingsList hosted as one row's submenu. Inner picks rebuild
     * the nested list in place; closing it completes with a value so the
     * hosting list repaints (e.g. the clear-all row appears after a first set).
     */
    const nestedListSubmenu =
      (buildNested: () => SettingItem[]): SettingItem["submenu"] =>
      (_currentValue, done) => {
        const buildFresh = (): SettingItem[] => buildNested();
        // Assigned after construction; the onSelect closure refreshes in place.
        let list: SettingsList;
        const listComponent = withVimKeys(
          new SettingsList(
            buildFresh(),
            15,
            buildSettingsListTheme(theme),
            (_id, _value) => {
              const fields = asListFields<SettingItem>(
                list as unknown as Component,
              );
              const fresh = buildFresh();
              fields.items = fresh;
              fields.filteredItems = fresh;
              fields.submenuComponent = null;
              fields.selectedIndex = 0;
            },
            () => done("closed"),
          ),
        );
        list = listComponent as unknown as SettingsList;
        installSeparatorSkip(
          asListFields<SettingItem>(list as unknown as Component),
        );
        return asSubmenuComponent(listComponent);
      };

    /** One harness's row inside the per-harness list, set or unset. */
    const harnessLimitRow = (harness: AnyHarnessId): SettingItem => {
      const live = getStore();
      const limit = live.concurrency.harnesses[harness];
      const label = harnessDisplayName(harness);
      const description = `Concurrent agents of every model launched under ${harness}.`;
      if (limit === undefined) {
        return {
          id: `harness:${harness}`,
          label,
          currentValue: "unset",
          description,
          submenu: targetThenValueSubmenu("", (target, parsed) => {
            getStore().mutate.concurrency.setHarness(harness, parsed, target);
            ctx.ui.notify(
              `${harness} concurrency set to ${parsed} (${target})`,
              "info",
            );
          }),
        };
      }
      const tag = layerHas(live.sessionConcurrency, "harnesses", harness)
        ? " [session]"
        : layerHas(live.projectConcurrency, "harnesses", harness)
          ? " [project]"
          : "";
      return {
        id: `harness:${harness}`,
        label,
        currentValue: formatSlotLimit(limit, tag),
        description,
        submenu: limitSubmenu(
          limit,
          (target, parsed) => {
            getStore().mutate.concurrency.setHarness(harness, parsed, target);
            ctx.ui.notify(
              `${label} concurrency set to ${parsed} (${target})`,
              "info",
            );
          },
          (target) => {
            getStore().mutate.concurrency.removeHarness(harness, target);
            ctx.ui.notify(
              `Removed per-harness limit for ${harness} (${target})`,
              "info",
            );
          },
          {
            session: layerHas(live.sessionConcurrency, "harnesses", harness),
            global: layerHas(live.globalConcurrency, "harnesses", harness),
            project: layerHas(live.projectConcurrency, "harnesses", harness),
          },
        ),
      };
    };

    /**
     * Harnesses for the per-harness list: runnable plus already-configured. The
     * configured keys are taken raw — the vocabulary is open, so a limit left
     * behind by a plugin that is no longer installed still gets a row, which is
     * the only place it can be cleared from.
     */
    const harnessListItems = (): SettingItem[] => {
      const live = getStore();
      const ordered = [...harnessIds];
      for (const key of Object.keys(live.concurrency.harnesses)) {
        if (key.trim() !== "" && !ordered.includes(key)) {
          ordered.push(key);
        }
      }
      return ordered.map((harness) => harnessLimitRow(harness));
    };

    /** Candidate provider names for one harness, from its own model list. */
    const providerOptionsFor = (harness: AnyHarnessId): string[] => {
      const modelKeys = harnessModelOptions.get(harness) ?? [];
      return [
        ...new Set(
          modelKeys
            .map((key) => parseModelKey(key)?.provider)
            .filter((provider): provider is string => provider !== undefined),
        ),
      ].sort();
    };

    /** One provider row inside a harness's provider list, set or unset. */
    const providerLimitRow = (
      harness: AnyHarnessId,
      key: string,
    ): SettingItem => {
      const live = getStore();
      const limit = live.concurrency.providers[key];
      const description = `Concurrent slots reserved for agents under ${harness} using the ${parsePoolKey(key)?.provider ?? key} provider.`;
      if (limit === undefined) {
        return {
          id: `provider:${key}`,
          label: key,
          currentValue: "unset",
          description,
          submenu: targetThenValueSubmenu("", (target, parsed) => {
            getStore().mutate.concurrency.setProvider(key, parsed, target);
            ctx.ui.notify(
              `${key} concurrency set to ${parsed} (${target})`,
              "info",
            );
          }),
        };
      }
      const tag = layerHas(live.sessionConcurrency, "providers", key)
        ? " [session]"
        : layerHas(live.projectConcurrency, "providers", key)
          ? " [project]"
          : "";
      return {
        id: `provider:${key}`,
        label: key,
        currentValue: formatSlotLimit(limit, tag),
        description,
        submenu: limitSubmenu(
          limit,
          (target, parsed) => {
            getStore().mutate.concurrency.setProvider(key, parsed, target);
            ctx.ui.notify(
              `${key} concurrency set to ${parsed} (${target})`,
              "info",
            );
          },
          (target) => {
            getStore().mutate.concurrency.removeProvider(key, target);
            ctx.ui.notify(
              `Removed per-provider limit for ${key} (${target})`,
              "info",
            );
          },
          {
            session: layerHas(live.sessionConcurrency, "providers", key),
            global: layerHas(live.globalConcurrency, "providers", key),
            project: layerHas(live.projectConcurrency, "providers", key),
          },
        ),
      };
    };

    /** A harness's provider list: candidates plus already-configured keys. */
    const providerListItems = (harness: AnyHarnessId): SettingItem[] => {
      const live = getStore();
      const configured =
        groupKeysByHarness(Object.keys(live.concurrency.providers)).get(
          harness,
        ) ?? [];
      const candidates = providerOptionsFor(harness).map((provider) =>
        qualifiedKey(harness, provider),
      );
      const keys = [...new Set([...candidates, ...configured])].sort();
      return keys.map((key) => providerLimitRow(harness, key));
    };

    /** One model row inside a harness's model list, set or unset. */
    const modelLimitRow = (harness: AnyHarnessId, key: string): SettingItem => {
      const live = getStore();
      const limit = live.concurrency.models[key];
      const parsed = parsePoolKey(key);
      const modelName = parsed?.kind === "model" ? parsed.model : key;
      const description = `Concurrent slots reserved for agents under ${harness} using the ${modelName} model.`;
      if (limit === undefined) {
        return {
          id: `model:${key}`,
          label: key,
          currentValue: "unset",
          description,
          submenu: targetThenValueSubmenu("", (target, parsedValue) => {
            getStore().mutate.concurrency.setModel(key, parsedValue, target);
            ctx.ui.notify(
              `${key} concurrency set to ${parsedValue} (${target})`,
              "info",
            );
          }),
        };
      }
      const tag = layerHas(live.sessionConcurrency, "models", key)
        ? " [session]"
        : layerHas(live.projectConcurrency, "models", key)
          ? " [project]"
          : "";
      return {
        id: `model:${key}`,
        label: key,
        currentValue: formatSlotLimit(limit, tag),
        description,
        submenu: limitSubmenu(
          limit,
          (target, parsedValue) => {
            getStore().mutate.concurrency.setModel(key, parsedValue, target);
            ctx.ui.notify(
              `${key} concurrency set to ${parsedValue} (${target})`,
              "info",
            );
          },
          (target) => {
            getStore().mutate.concurrency.removeModel(key, target);
            ctx.ui.notify(
              `Removed per-model limit for ${key} (${target})`,
              "info",
            );
          },
          {
            session: layerHas(live.sessionConcurrency, "models", key),
            global: layerHas(live.globalConcurrency, "models", key),
            project: layerHas(live.projectConcurrency, "models", key),
          },
        ),
      };
    };

    /** A harness's model list: candidates plus already-configured keys. */
    const modelListItems = (harness: AnyHarnessId): SettingItem[] => {
      const live = getStore();
      const configured =
        groupKeysByHarness(Object.keys(live.concurrency.models)).get(harness) ??
        [];
      const candidates = (harnessModelOptions.get(harness) ?? []).map((key) =>
        qualifiedKey(harness, key),
      );
      const keys = [...new Set([...candidates, ...configured])].sort();
      return keys.map((key) => modelLimitRow(harness, key));
    };

    /** Harness picker rows; each opens that harness's provider or model list. */
    const harnessPickerItems = (
      kind: "providers" | "models",
    ): SettingItem[] => {
      const live = getStore();
      const configured =
        kind === "providers"
          ? groupKeysByHarness(Object.keys(live.concurrency.providers))
          : groupKeysByHarness(Object.keys(live.concurrency.models));
      return sectionHarnesses(harnessIds, configured)
        .filter((harness) => {
          const hasConfigured = (configured.get(harness) ?? []).length > 0;
          if (kind === "providers")
            return hasConfigured || providerOptionsFor(harness).length > 0;
          return (
            hasConfigured || (harnessModelOptions.get(harness) ?? []).length > 0
          );
        })
        .map((harness) => ({
          id: `${kind}-harness:${harness}`,
          label: harnessDisplayName(harness),
          currentValue: "",
          description:
            kind === "providers"
              ? `Provider limits under ${harness}.`
              : `Model limits under ${harness}.`,
          submenu: nestedListSubmenu(() =>
            kind === "providers"
              ? providerListItems(harness)
              : modelListItems(harness),
          ),
        }));
    };

    // ── Global default ──
    const defaultLimit = store.concurrency.default;
    items.push({
      id: "defaultConcurrency",
      label: "Default concurrency limit",
      currentValue: `${defaultLimit}${limitTag("default")}`,
      description:
        "Concurrent agents, whatever harness, provider, or model they use.",
      submenu: limitSubmenu(
        defaultLimit,
        (target, parsed) => {
          store.mutate.concurrency.setDefault(parsed, target);
          ctx.ui.notify(
            `Default concurrency set to ${parsed} (${target})`,
            "info",
          );
        },
        (target) => {
          store.mutate.concurrency.removeDefault(target);
          ctx.ui.notify(
            `Removed default concurrency limit (${target})`,
            "info",
          );
        },
        entryLevels("default"),
      ),
    });

    // ── Nested limit sections ──
    items.push({
      id: "harnessLimits",
      label: "Per-harness limits",
      currentValue: "",
      description: "Cap how many agents run at once under a single harness.",
      submenu: nestedListSubmenu(harnessListItems),
    });
    items.push({
      id: "providerLimits",
      label: "Per-provider limits",
      currentValue: "",
      description: "Cap how many agents run at once for a single provider.",
      submenu: nestedListSubmenu(() => harnessPickerItems("providers")),
    });
    items.push({
      id: "modelLimits",
      label: "Per-model limits",
      currentValue: "",
      description: "Cap how many agents run at once for a single model.",
      submenu: nestedListSubmenu(() => harnessPickerItems("models")),
    });

    // ── Clear all ──
    // One level is offered only when it carries entries; the row hides when none do.
    const availableLevels: AvailableLevels = {
      session: store.hasSessionConcurrencySettings,
      global: store.hasGlobalConcurrencySettings,
      project: store.hasProjectConcurrencySettings && projectOffered,
    };
    if (
      availableLevels.session ||
      availableLevels.global ||
      availableLevels.project
    ) {
      items.push({
        id: "resetAll",
        label: "Clear all concurrency limits...",
        currentValue: "",
        description:
          "Remove concurrency overrides at the chosen level (session, global, project, or all).",
        submenu: createClearAllSubmenu({
          theme,
          projectOffered,
          availableLevels,
          message: (target) =>
            `Clear all concurrency limits at the ${target} level?`,
          onConfirm: (target) => {
            store.mutate.concurrency.clearAll(target);
            ctx.ui.notify(`Concurrency limits cleared (${target})`, "info");
          },
        }),
      });
    }

    return items;
  };

  let rebuild: ((items: SettingItem[]) => void) | undefined;

  await new ScreenHost(ctx).open<void>(({ theme, close }) => {
    const triggerRebuild = () => rebuild?.(buildItems(getStore(), theme));
    const store = getStore();
    const items = buildItems(store, theme);
    const settingsList = new SettingsList(
      items,
      15,
      buildSettingsListTheme(theme),
      (_id, _v) => triggerRebuild(),
      close,
    );
    return new SettingsListWrapper(settingsList, {
      title: "Concurrency Settings",
      theme,
      onCancel: close,
      onRebuild: (r) => {
        rebuild = r;
      },
    });
  });
}
