/**
 * menu-concurrency.ts — per-harness, per-provider, and per-model slot limits (ADR-0008 target levels).
 * Values carry [session]/[project] tags when they come from those layers.
 * Exports: showConcurrencySettingsMenu.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { getStore } from "../../shell.js";
import {
  harnessDisplayName,
  parseHarnessId,
  type HarnessId,
} from "../../agents/harness.js";
import type { HarnessModelOptions } from "../../agents/harness/registry.js";
import { parsePoolKey } from "../../concurrency-pools.js";
import type { RawConcurrency } from "../../config/config-store.js";
import { parseModelKey } from "../../utils.js";
import type { SelectOption } from "../searchable-select.js";
import type { Theme } from "../types.js";
import {
  SEPARATOR_ID,
  buildSettingsListTheme,
  buildModelOptions,
  createSearchableSelect,
  extractConfiguredModels,
  mergedModelsForHarness,
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

/** A concurrency level the menu reads and writes. */
type ConcurrencySection = "default" | "harnesses" | "providers" | "models";

/**
 * The config key one harness's entry is stored under: pi writes the bare key,
 * so existing pi config and pools are what the pi rows edit; every other
 * harness writes "<harness>:<provider>[/<model>]".
 */
function qualifiedKey(harness: HarnessId, bareKey: string): string {
  return harness === "pi" ? bareKey : `${harness}:${bareKey}`;
}

/** Configured provider or model keys grouped by the harness each key names. */
function groupKeysByHarness(keys: string[]): Map<HarnessId, string[]> {
  const groups = new Map<HarnessId, string[]>();
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
  probed: readonly HarnessId[],
  configured: Map<HarnessId, string[]>,
): HarnessId[] {
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
        return layer.harnesses?.[key as HarnessId] !== undefined;
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

    // Searchable-pick an option, then target → numeric value.
    const addPickThenValueSubmenu =
      (
        options: SelectOption[],
        onPick: (key: string, target: SetTarget, parsed: number) => void,
      ): SettingItem["submenu"] =>
      (currentValue, done) =>
        createSearchableSelect(
          options,
          {
            // A limit needs a key, so an inherit row cancels.
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

    /** One configured limit row: value, provenance tag, and set/clear flow. */
    const limitRow = (options: {
      id: string;
      label: string;
      description: string;
      limit: number;
      section: ConcurrencySection;
      key?: string;
      onSet: (target: SetTarget, parsed: number) => void;
      onRemove: (target: TargetChoice) => void;
    }): SettingItem => ({
      id: options.id,
      label: options.label,
      currentValue: `${options.limit} slots${limitTag(options.section, options.key)}`,
      description: options.description,
      submenu: limitSubmenu(
        options.limit,
        options.onSet,
        options.onRemove,
        entryLevels(options.section, options.key),
      ),
    });

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

    // ── Per-harness limits ──
    items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
    items.push({
      id: SEPARATOR_ID,
      label: theme.bold(theme.fg("accent", "Per-harness limits")),
      currentValue: "",
    });
    const harnessLimits = store.concurrency.harnesses;
    for (const key of Object.keys(harnessLimits)) {
      const harness = parseHarnessId(key);
      if (harness === undefined) continue;
      const limit = harnessLimits[harness];
      if (limit === undefined) continue;
      const label = harnessDisplayName(harness);
      items.push(
        limitRow({
          id: `harness:${harness}`,
          label,
          description: `Concurrent agents of every model launched under ${harness}.`,
          limit,
          section: "harnesses",
          key: harness,
          onSet: (target, parsed) => {
            store.mutate.concurrency.setHarness(harness, parsed, target);
            ctx.ui.notify(
              `${label} concurrency set to ${parsed} (${target})`,
              "info",
            );
          },
          onRemove: (target) => {
            store.mutate.concurrency.removeHarness(harness, target);
            ctx.ui.notify(
              `Removed per-harness limit for ${harness} (${target})`,
              "info",
            );
          },
        }),
      );
    }
    items.push({
      id: SEPARATOR_ID,
      label: "─────────────────────────",
      currentValue: "────────",
    });
    if (harnessIds.length > 0) {
      items.push({
        id: "addHarnessLimit",
        label: "Add per-harness limit...",
        currentValue: "",
        description: "Cap how many agents run at once under a single harness.",
        submenu: addPickThenValueSubmenu(
          harnessIds.map((id) => ({
            value: id,
            label: harnessDisplayName(id),
          })),
          (harnessId, target, parsed) => {
            const harness = harnessId as HarnessId;
            store.mutate.concurrency.setHarness(harness, parsed, target);
            ctx.ui.notify(
              `${harness} concurrency set to ${parsed} (${target})`,
              "info",
            );
          },
        ),
      });
    }

    // ── Per-provider limits, one section per harness ──
    items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
    items.push({
      id: SEPARATOR_ID,
      label: theme.bold(theme.fg("accent", "Per-provider limits")),
      currentValue: "",
    });
    const configuredProviders = groupKeysByHarness(
      Object.keys(store.concurrency.providers),
    );
    for (const harness of sectionHarnesses(harnessIds, configuredProviders)) {
      const configured = configuredProviders.get(harness) ?? [];
      const modelKeys = harnessModelOptions.get(harness) ?? [];
      const providerOptions = [
        ...new Set(
          modelKeys
            .map((key) => parseModelKey(key)?.provider)
            .filter((provider): provider is string => provider !== undefined),
        ),
      ].sort();
      if (configured.length === 0 && providerOptions.length === 0) continue;
      items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
      items.push({
        id: SEPARATOR_ID,
        label: theme.fg("muted", harnessDisplayName(harness)),
        currentValue: "",
      });
      for (const key of configured) {
        const limit = store.concurrency.providers[key];
        if (limit === undefined) continue;
        items.push(
          limitRow({
            id: `provider:${key}`,
            label: key,
            description: `Concurrent slots reserved for agents under ${harness} using the ${parsePoolKey(key)?.provider ?? key} provider.`,
            limit,
            section: "providers",
            key,
            onSet: (target, parsed) => {
              store.mutate.concurrency.setProvider(key, parsed, target);
              ctx.ui.notify(
                `${key} concurrency set to ${parsed} (${target})`,
                "info",
              );
            },
            onRemove: (target) => {
              store.mutate.concurrency.removeProvider(key, target);
              ctx.ui.notify(
                `Removed per-provider limit for ${key} (${target})`,
                "info",
              );
            },
          }),
        );
      }
      if (providerOptions.length > 0) {
        items.push({
          id: `addProviderLimit:${harness}`,
          label: `Add ${harnessDisplayName(harness)} provider limit...`,
          currentValue: "",
          description: `Cap how many agents run at once for a single provider under ${harness}.`,
          submenu: addPickThenValueSubmenu(
            providerOptions.map((o) => ({ value: o, label: o })),
            (provider, target, parsed) => {
              const key = qualifiedKey(harness, provider);
              store.mutate.concurrency.setProvider(key, parsed, target);
              ctx.ui.notify(
                `${key} concurrency set to ${parsed} (${target})`,
                "info",
              );
            },
          ),
        });
      }
    }

    // ── Per-model limits, one section per harness ──
    items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
    items.push({
      id: SEPARATOR_ID,
      label: theme.bold(theme.fg("accent", "Per-model limits")),
      currentValue: "",
    });
    const configuredModels = groupKeysByHarness(
      Object.keys(store.concurrency.models),
    );
    const agentConfiguredModels = extractConfiguredModels(
      store.agentConfigSnapshot(),
    );
    for (const harness of sectionHarnesses(harnessIds, configuredModels)) {
      const configured = configuredModels.get(harness) ?? [];
      const modelKeys = harnessModelOptions.get(harness) ?? [];
      if (configured.length === 0 && modelKeys.length === 0) continue;
      items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
      items.push({
        id: SEPARATOR_ID,
        label: theme.fg("muted", harnessDisplayName(harness)),
        currentValue: "",
      });
      for (const key of configured) {
        const limit = store.concurrency.models[key];
        if (limit === undefined) continue;
        const parsed = parsePoolKey(key);
        const modelName = parsed?.kind === "model" ? parsed.model : key;
        items.push(
          limitRow({
            id: `model:${key}`,
            label: key,
            description: `Concurrent slots reserved for agents under ${harness} using the ${modelName} model.`,
            limit,
            section: "models",
            key,
            onSet: (target, parsed) => {
              store.mutate.concurrency.setModel(key, parsed, target);
              ctx.ui.notify(
                `${key} concurrency set to ${parsed} (${target})`,
                "info",
              );
            },
            onRemove: (target) => {
              store.mutate.concurrency.removeModel(key, target);
              ctx.ui.notify(
                `Removed per-model limit for ${key} (${target})`,
                "info",
              );
            },
          }),
        );
      }
      if (modelKeys.length > 0) {
        items.push({
          id: `addModelLimit:${harness}`,
          label: `Add ${harnessDisplayName(harness)} model limit...`,
          currentValue: "",
          description: `Cap how many agents run at once for a single model under ${harness}.`,
          submenu: addPickThenValueSubmenu(
            buildModelOptions(
              modelKeys,
              null,
              mergedModelsForHarness(harness, agentConfiguredModels),
            ),
            (modelKey, target, parsed) => {
              const key = qualifiedKey(harness, modelKey);
              store.mutate.concurrency.setModel(key, parsed, target);
              ctx.ui.notify(
                `${key} concurrency set to ${parsed} (${target})`,
                "info",
              );
            },
          ),
        });
      }
    }

    // ── Clear all ──
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
