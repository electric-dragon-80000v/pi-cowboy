/**
 * menu-concurrency.ts — per-provider and per-model slot limits (ADR-0008 target levels).
 * Values carry [session]/[project] tags when they come from those layers.
 * Exports: showConcurrencySettingsMenu.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { getStore } from "../../shell.js";
import type { RawConcurrency } from "../../config/config-store.js";
import type { SelectOption } from "../searchable-select.js";
import type { Theme } from "../types.js";
import {
  SEPARATOR_ID,
  buildSettingsListTheme,
  buildModelOptions,
  createSearchableSelect,
  extractConfiguredModels,
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
import { ScreenHost } from "./screen-host.js";

export async function showConcurrencySettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const buildItems = (
    store: ReturnType<typeof getStore>,
    theme: Theme,
    modelOptions: string[],
  ): SettingItem[] => {
    const providers = [
      ...new Set(modelOptions.map((m) => m.split("/")[0])),
    ].sort();
    const items: SettingItem[] = [];
    const projectOffered = store.isProjectWritable;

    /** Whether the layer carries this concurrency entry. */
    const layerHas = (
      layer: RawConcurrency,
      section: "default" | "providers" | "models",
      key?: string,
    ): boolean =>
      section === "default"
        ? layer.default !== undefined
        : key !== undefined && layer[section]?.[key] !== undefined;

    /** Layers carrying this entry; drives the remove/clear pickers. */
    const entryLevels = (
      section: "default" | "providers" | "models",
      key?: string,
    ): AvailableLevels => ({
      session: layerHas(store.sessionConcurrency, section, key),
      global: layerHas(store.globalConcurrency, section, key),
      project: layerHas(store.projectConcurrency, section, key),
    });

    /** " [session]" / " [project]" when the effective value comes from that layer. */
    const limitTag = (
      section: "default" | "providers" | "models",
      key?: string,
    ): string => {
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

    // Searchable-pick an option, then target → numeric value.
    const addPickThenValueSubmenu =
      (
        items: SelectOption[],
        onPick: (key: string, target: SetTarget, parsed: number) => void,
      ): SettingItem["submenu"] =>
      (currentValue, done) =>
        createSearchableSelect(
          items,
          {
            // A limit needs a model key, so the inherit row cancels.
            onSelect: (key) => {
              if (key == null) return done();
              return targetThenValueSubmenu("1", (target, parsed) =>
                onPick(key, target, parsed),
              )(currentValue, done);
            },
            onCancel: () => done(),
          },
          theme,
        );

    items.push({
      id: "defaultConcurrency",
      label: "Default concurrency limit",
      currentValue: `${store.concurrency.default}${limitTag("default")}`,
      description: "Concurrent agents, whatever provider or model they use.",
      submenu: limitSubmenu(
        store.concurrency.default,
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

    items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
    items.push({
      id: SEPARATOR_ID,
      label: theme.bold(theme.fg("accent", "Per-provider limits")),
      currentValue: "",
    });
    const providerLimits = store.concurrency.providers;
    for (const provider of Object.keys(providerLimits)) {
      const limit = providerLimits[provider];
      items.push({
        id: `provider:${provider}`,
        label: provider,
        currentValue: `${limit} slots${limitTag("providers", provider)}`,
        description: `Concurrent slots reserved for agents using the ${provider} provider.`,
        submenu: limitSubmenu(
          limit,
          (target, parsed) => {
            store.mutate.concurrency.setProvider(provider, parsed, target);
            ctx.ui.notify(
              `${provider} concurrency set to ${parsed} (${target})`,
              "info",
            );
          },
          (target) => {
            store.mutate.concurrency.removeProvider(provider, target);
            ctx.ui.notify(
              `Removed per-provider limit for ${provider} (${target})`,
              "info",
            );
          },
          entryLevels("providers", provider),
        ),
      });
    }

    items.push({
      id: SEPARATOR_ID,
      label: "─────────────────────────",
      currentValue: "────────",
    });
    if (providers.length > 0) {
      items.push({
        id: "addProviderLimit",
        label: "Add per-provider limit...",
        currentValue: "",
        description: "Cap how many agents run at once for a single provider.",
        submenu: addPickThenValueSubmenu(
          providers.map((o) => ({ value: o, label: o })),
          (provider, target, parsed) => {
            store.mutate.concurrency.setProvider(provider, parsed, target);
            ctx.ui.notify(
              `${provider} concurrency set to ${parsed} (${target})`,
              "info",
            );
          },
        ),
      });
    }

    items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
    items.push({
      id: SEPARATOR_ID,
      label: theme.bold(theme.fg("accent", "Per-model limits")),
      currentValue: "",
    });
    const models = store.concurrency.models;
    for (const modelKey of Object.keys(models)) {
      const limit = models[modelKey];
      items.push({
        id: `model:${modelKey}`,
        label: modelKey,
        currentValue: `${limit} slots${limitTag("models", modelKey)}`,
        description: `Concurrent slots reserved for agents using the ${modelKey} model.`,
        submenu: limitSubmenu(
          limit,
          (target, parsed) => {
            store.mutate.concurrency.setModel(modelKey, parsed, target);
            ctx.ui.notify(
              `${modelKey} concurrency set to ${parsed} (${target})`,
              "info",
            );
          },
          (target) => {
            store.mutate.concurrency.removeModel(modelKey, target);
            ctx.ui.notify(
              `Removed per-model limit for ${modelKey} (${target})`,
              "info",
            );
          },
          entryLevels("models", modelKey),
        ),
      });
    }

    items.push({
      id: SEPARATOR_ID,
      label: "─────────────────────────",
      currentValue: "────────",
    });
    if (modelOptions.length > 0) {
      const configuredModels = extractConfiguredModels(
        store.agentConfigSnapshot(),
      );
      items.push({
        id: "addModelLimit",
        label: "Add per-model limit...",
        currentValue: "",
        description: "Cap how many agents run at once for a single model.",
        submenu: addPickThenValueSubmenu(
          buildModelOptions(modelOptions, undefined, configuredModels),
          (modelKey, target, parsed) => {
            store.mutate.concurrency.setModel(modelKey, parsed, target);
            ctx.ui.notify(
              `${modelKey} concurrency set to ${parsed} (${target})`,
              "info",
            );
          },
        ),
      });
    }

    items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
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
    const triggerRebuild = () =>
      rebuild?.(buildItems(getStore(), theme, modelOptions));
    const store = getStore();
    const items = buildItems(store, theme, modelOptions);
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
