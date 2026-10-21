/**
 * Model settings screen: pi's default row, one row per other harness's default,
 * per-type override rows, and clear entries.
 *
 * buildModelSettingsScreen: the screen as a Component (a submenu returns a Component, so it runs inside the caller's screen).
 * buildModelOverridesRow: the topmost menu's "Model overrides" row hosting that screen in place.
 *
 * Overrides here write the configured precedence layers only; a per-call cowboy_agent `model`
 * applies above them at the tool boundary and leaves no state here.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  SettingsList,
  type Component,
  type SettingItem,
} from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "../../types.js";
import type { ThinkingOffering } from "../../models/thinking-offering.js";
import { getAgentConfig, getAllTypes } from "../../agents/agent-types.js";
import { resolveHarnessType } from "../../agents/spawn-defaults.js";
import {
  harnessFamilyOf,
  modelKeysOf,
  type HarnessModelOptions,
} from "../../agents/harness/harness-registry.js";
import { isPiFamilyHarness, type AnyHarnessId } from "../../agents/harness.js";
import type { Theme } from "../types.js";
import { agentBulletPrefix } from "../format.js";
import {
  getSessionCtx,
  getStore,
  getHarnessAvailability,
  getHarnessRegistry,
} from "../../shell.js";
import {
  buildModelGroups,
  displayedThinking,
  hasExplicitPerTypeOverride,
  type AgentTypeModelConfig,
} from "../../models/model-groups.js";
import type {
  SessionModelOverrides,
  SessionThinkingOverrides,
} from "../../models/model-precedence.js";
import type { Availability } from "../../availability.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { asSubmenuComponent } from "./screen-host.js";
import {
  createClearAllSubmenu,
  createClearPickerSubmenu,
  createLevelPickerSubmenu,
  type AvailableLevels,
  type TargetChoice,
} from "./submenus/target-select.js";
import { createModelSelectSubmenu } from "./submenus/model-select.js";
import { createThinkingSelectSubmenu } from "./submenus/thinking-select.js";
import {
  buildHarnessDefaultThinkingRow,
  buildPiDefaultThinkingRow,
  thinkingOfferingForType,
} from "./model-thinking-rows.js";
import {
  SEPARATOR_ID,
  buildSettingsListTheme,
  createSearchableSelect,
  extractConfiguredModels,
  headerItem,
  mergedModelsForHarness,
  type Notify,
  type SubmenuFactory,
} from "./helpers.js";

/** Global-default display value. Tags mark the winning non-global layer (session > project); untagged means global won. */
function defaultRowValue(
  sessionDefault: string | null,
  effectiveDefault: string | null,
  hasProjectDefault: boolean,
): string {
  if (sessionDefault != null) return `${sessionDefault} [session]`;
  if (effectiveDefault == null) return "(none)";
  return hasProjectDefault ? `${effectiveDefault} [project]` : effectiveDefault;
}

/** Per-render plumbing shared by every row: the target+model submenu factory plus per-key layer availability. */
interface ModelOverridePlumbing {
  /**
   * Target + model picker submenu for one config key. `harnessId` names the
   * harness the row's spawn launches under, so the picker offers that harness's
   * list and, on pi's own rows, pi's configured models.
   */
  modelSubmenuFor: (
    typeName: string,
    harnessId: AnyHarnessId,
    effectiveModel: string | null,
    showClear: boolean,
    availableLevels?: AvailableLevels,
  ) => SubmenuFactory;
  /** Which layers carry a config key (drives the nested clear picker). */
  levelsFor: (key: string) => AvailableLevels;
}

/** What a model-override row needs from the screen hosting it. */
interface ModelOverrideRowOptions {
  store: ReturnType<typeof getStore>;
  theme: Theme;
  /** Each harness's own list, read once when the menu tree opened. */
  harnessModelOptions: HarnessModelOptions;
  notify: Notify;
  /**
   * Repaint the hosting list. Needed for (none) picks, which complete with no value
   * (SettingsList only rebuilds on a DEFINED value).
   */
  refresh: () => void;
}

function createModelOverridePlumbing(
  options: ModelOverrideRowOptions,
): ModelOverridePlumbing {
  const { store, theme, harnessModelOptions, notify, refresh } = options;
  const projectOffered = store.isProjectWritable;
  const configuredModels = extractConfiguredModels(store.agentConfigSnapshot());

  // A null pick clears the key at the picked layer (ADR-0008 delete semantics).
  const modelOverrideOnSelect =
    (
      key: string,
      label: string,
    ): ((
      target: "session" | "global" | "project",
      model: string | null,
    ) => void) =>
    (target, model) => {
      const cleared = model === null;
      if (cleared) store.mutate.agent.clearModelOverride(key, target);
      else store.mutate.agent.setModelOverride(key, model, target);
      notify(
        cleared
          ? `${label} cleared (${target}) — the configured chain decides`
          : `${label} model set to ${model} (${target})`,
        "info",
      );
      if (cleared) refresh();
    };

  const clearOverrideOnSelect =
    (key: string, label: string): ((target: TargetChoice) => void) =>
    (target) => {
      store.mutate.agent.clearModelOverride(key, target);
      notify(`${label} override cleared (${target})`, "info");
    };

  return {
    // availableLevels filters the nested clear picker (the default and per-type
    // rows pass the levels where the key exists); set entries are never filtered.
    modelSubmenuFor: (
      typeName,
      harnessId,
      effectiveModel,
      showClear,
      availableLevels,
    ) => {
      const modelOptions = modelKeysOf(harnessModelOptions, harnessId);
      const mergedModels = mergedModelsForHarness(harnessId, configuredModels);
      const onSet = modelOverrideOnSelect(typeName, typeName);
      if (showClear) {
        return createModelSelectSubmenu({
          modelOptions,
          mergedModels,
          showClear: true,
          projectOffered,
          theme,
          currentModel: effectiveModel,
          availableLevels,
          onSet,
          onClear: clearOverrideOnSelect(typeName, typeName),
        });
      }
      return createModelSelectSubmenu({
        modelOptions,
        mergedModels,
        showClear: false,
        projectOffered,
        theme,
        currentModel: effectiveModel,
        availableLevels,
        onSet,
      });
    },
    levelsFor: (key) => store.modelOverrideLevels(key),
  };
}

/**
 * The harnesses that get a default-model row: every runnable harness outside the
 * pi family, which already has one row — pi runs the family's binary, so pig and
 * pi-bolt share pi's catalog and pi's default.
 */
function harnessDefaultRowIds(
  availability: Availability<AnyHarnessId>,
): AnyHarnessId[] {
  return getHarnessRegistry()
    .runnable(availability)
    .filter((id) => !isPiFamilyHarness(id));
}

/** What one harness's default-model row needs from the screen hosting it. */
interface HarnessDefaultRowOptions {
  harnessId: AnyHarnessId;
  /** Model keys that harness's `listModels` answered. */
  modelOptions: readonly string[];
  ctx: ExtensionCommandContext;
  store: ReturnType<typeof getStore>;
  theme: Theme;
  /**
   * Repaint the hosting list. Needed for inherit picks, which complete with no
   * value (SettingsList only rebuilds on a DEFINED value, and the picked value
   * is what the row shows).
   */
  refresh: () => void;
}

/**
 * One harness's default model, below the pi row. The value and its layer tags
 * read exactly like the pi row's, so the two rows differ only in which harness
 * they configure and which list their picker offers.
 */
function buildHarnessDefaultRow(
  options: HarnessDefaultRowOptions,
): SettingItem {
  const { harnessId, modelOptions, ctx, store, theme, refresh } = options;
  const label = `${getHarnessRegistry().displayName(harnessId)} Default Model`;
  const notify: Notify = (message, type) => ctx.ui.notify(message, type);
  const harnessLevels = store.harnessDefaultModelLevels(harnessId);
  const effective = store.defaultModelForHarness(harnessId);

  return {
    id: `harness:${harnessId}`,
    label,
    currentValue: defaultRowValue(
      harnessLevels.session ? effective : null,
      effective,
      harnessLevels.project,
    ),
    description: `Model used when an agent launches under ${harnessId} and no session default, per-type override, or agent-template model applies.`,
    submenu: createModelSelectSubmenu({
      modelOptions,
      // A row exists only for a harness outside the pi family, so its own list
      // is the whole offering and nothing is merged ahead of it.
      mergedModels: [],
      showClear: true,
      projectOffered: store.isProjectWritable,
      theme,
      currentModel: effective,
      availableLevels: harnessLevels,
      onSet: (target, model) => {
        store.mutate.agent.setHarnessDefaultModel(harnessId, model, target);
        notify(
          model === null
            ? `${label} cleared (${target}) — the configured chain decides`
            : `${label} set to ${model} (${target})`,
          "info",
        );
        if (model === null) refresh();
      },
      onClear: (target) => {
        store.mutate.agent.clearHarnessDefaultModel(harnessId, target);
        notify(`${label} cleared (${target})`, "info");
      },
    }),
  };
}

/** What the "Model Settings" screen reads from the row hosting it. */
interface ModelSettingsScreenOptions {
  /** Command context the screen reads its parent model and registry from. */
  ctx: ExtensionCommandContext;
  store: ReturnType<typeof getStore>;
  theme: Theme;
  /** Each harness's own list, read once when the menu tree opened. */
  harnessModelOptions: HarnessModelOptions;
  /** pi's default thinking level, resolved by the hosting menu (this screen's factory is synchronous). */
  piDefaultThinking: ThinkingLevel | undefined;
  /** Close back to the hosting menu (the host row's submenu `done`). */
  close: () => void;
}

/**
 * The "Model Settings" screen as a Component a submenu can host in place.
 *
 * Every row's list comes from the per-harness structure read when the menu tree
 * opened, so the screen builds synchronously and no row offers a harness's
 * models to another.
 */
function buildModelSettingsScreen(
  options: ModelSettingsScreenOptions,
): Component {
  const harnessIds = harnessDefaultRowIds(getHarnessAvailability());
  return asSubmenuComponent(buildModelSettingsList(options, harnessIds));
}

/** The framed screen, built from the model lists each row's harness offers. */
function buildModelSettingsList(
  options: ModelSettingsScreenOptions,
  harnessIds: readonly string[],
): Component {
  const { ctx, store, theme, harnessModelOptions, piDefaultThinking, close } =
    options;
  let rebuild: ((items: SettingItem[]) => void) | undefined;

  const buildItems = (theme: Theme): SettingItem[] => {
    const items: SettingItem[] = [];
    const projectOffered = store.isProjectWritable;
    const { levelsFor, modelSubmenuFor } = createModelOverridePlumbing({
      store,
      theme,
      harnessModelOptions,
      notify: (message, type) => ctx.ui.notify(message, type),
      // A (none) pick completes with no value, so refresh the row here.
      refresh: () => rebuild?.(buildItems(theme)),
    });

    const notify: Notify = (message, type) => ctx.ui.notify(message, type);
    const session = getSessionCtx();
    const parentModel = session.model ?? ctx.model;
    const parentModelId = parentModel
      ? `${parentModel.provider}/${parentModel.id}`
      : null;
    /** The thinking control a type's model offers, in its harness's vocabulary. */
    const offeringFor = (
      harnessId: AnyHarnessId,
      modelKey: string | null,
    ): ThinkingOffering =>
      thinkingOfferingForType({
        harnessId,
        modelKey,
        entries: harnessModelOptions,
        registry: session.modelRegistry,
        // The model the chain would inherit, which ctx.model answers when the
        // session names none.
        parentModel,
      });

    const agentConfigSnapshot = store.agentConfigSnapshot();
    const sessionDefault = store.sessionDefaultModel;
    const effectiveDefault = agentConfigSnapshot.default;
    const globalDisplayValue = defaultRowValue(
      sessionDefault,
      effectiveDefault,
      store.hasProjectModelKey("default"),
    );
    const defaultLevels = levelsFor("default");

    items.push({
      id: "defaultModel",
      label: "Pi Default Model",
      currentValue: globalDisplayValue,
      description:
        "Model used when no session default, per-type override, or agent-template model applies.",
      submenu: modelSubmenuFor(
        "default",
        "pi",
        effectiveDefault,
        defaultLevels.session || defaultLevels.global || defaultLevels.project,
        defaultLevels,
      ),
    });

    items.push(buildPiDefaultThinkingRow({ ctx, store, theme }));

    for (const harnessId of harnessIds) {
      items.push(
        buildHarnessDefaultRow({
          harnessId,
          modelOptions: modelKeysOf(harnessModelOptions, harnessId),
          ctx,
          store,
          theme,
          refresh: () => rebuild?.(buildItems(theme)),
        }),
      );
      items.push(
        buildHarnessDefaultThinkingRow({
          harnessId,
          entries: harnessModelOptions.get(harnessId) ?? [],
          ctx,
          store,
          theme,
        }),
      );
    }

    // One group per resolved model with a listed row, alphabetical by model id.
    const types = getAllTypes();

    const sessionOverrides: SessionModelOverrides = {
      default: store.sessionDefaultModel,
    };
    const agentConfigs: Record<string, AgentTypeModelConfig | undefined> = {};
    for (const type of types) {
      // Null reads as absent downstream.
      sessionOverrides[type] = store.sessionModelOverride(type);
      agentConfigs[type] = getAgentConfig(type);
    }

    const sessionThinking: SessionThinkingOverrides = {};
    for (const type of types) {
      sessionThinking[type] = store.sessionThinkingOverride(type);
    }
    const groups = buildModelGroups({
      types,
      agentConfigs,
      config: agentConfigSnapshot,
      sessionOverrides,
      sessionThinking,
      harnessDefaultFor: (type) =>
        store.defaultModelForHarness(resolveHarnessType(type)),
      harnessDefaultThinkingFor: (type) => {
        const harnessId = resolveHarnessType(type);
        return (
          store.defaultThinkingForHarness(harnessId) ??
          // pi's own settings file sits below the config layers; a pi-family
          // launch reads it as its default when config names none.
          (isPiFamilyHarness(harnessId) ? (piDefaultThinking ?? null) : null)
        );
      },
      harnessFamilyFor: (type) => harnessFamilyOf(resolveHarnessType(type)),
      hasProjectModelKey: (key) => store.hasProjectModelKey(key),
      hasProjectThinkingKey: (type) => store.hasProjectThinkingKey(type),
      parentModelId,
    });

    /**
     * The per-type action sheet: either dimension, or both at one layer. A pick
     * that writes unwinds the sheet, so setting both takes two visits.
     */
    const typeSheetFor = (
      type: string,
      harnessId: AnyHarnessId,
      effectiveModel: string | null,
      effectiveThinking: string | null,
    ): SubmenuFactory => {
      const modelLevels = store.modelOverrideLevels(type);
      const thinkingLevels = store.thinkingOverrideLevels(type);
      const offering = offeringFor(harnessId, effectiveModel);
      const sheet: SettingItem[] = [
        {
          id: "model",
          label: "Model",
          currentValue: effectiveModel ?? "(none)",
          description: `Model for the ${type} agent type.`,
        },
        {
          id: "thinking",
          label: "Thinking level",
          currentValue: effectiveThinking ?? "inherit",
          description:
            offering.kind === "none"
              ? `${type} runs a model with no thinking control.`
              : `Reasoning effort for ${type}, from its harness's own list.`,
        },
      ];
      // "Clear the override" means both halves, so a layer carrying either is
      // a target the picker must offer.
      const clearLevels: AvailableLevels = {
        session: modelLevels.session || thinkingLevels.session,
        global: modelLevels.global || thinkingLevels.global,
        project: modelLevels.project || thinkingLevels.project,
      };
      if (clearLevels.session || clearLevels.global || clearLevels.project) {
        sheet.push({
          id: "clear",
          label: "Clear...",
          currentValue: "",
          description: `Remove ${type}'s model and thinking overrides at one layer.`,
        });
      }

      return createLevelPickerSubmenu({
        theme,
        items: sheet,
        onPick: (id, subDone) => {
          if (id === "model") {
            const anyModelLevel =
              modelLevels.session || modelLevels.global || modelLevels.project;
            return modelSubmenuFor(
              type,
              harnessId,
              effectiveModel,
              anyModelLevel,
              modelLevels,
            )(effectiveModel ?? "", subDone);
          }
          if (id === "thinking") {
            return createThinkingSelectSubmenu({
              theme,
              ctx,
              offering,
              current: effectiveThinking,
              projectOffered,
              showClear:
                thinkingLevels.session ||
                thinkingLevels.global ||
                thinkingLevels.project,
              availableLevels: thinkingLevels,
              onSet: (target, token) => {
                if (token === null) {
                  store.mutate.agent.clearThinkingOverride(type, target);
                } else {
                  store.mutate.agent.setThinkingOverride(type, token, target);
                }
                notify(
                  token === null
                    ? `${type} thinking level cleared (${target})`
                    : `${type} thinking level set to ${token} (${target})`,
                  "info",
                );
              },
              onClear: (target) => {
                store.mutate.agent.clearThinkingOverride(type, target);
                notify(`${type} thinking level cleared (${target})`, "info");
              },
            })("", subDone);
          }
          return createClearPickerSubmenu({
            theme,
            projectOffered,
            availableLevels: clearLevels,
            onClear: (target) => {
              store.mutate.agent.clearModelOverride(type, target);
              store.mutate.agent.clearThinkingOverride(type, target);
              notify(`${type} overrides cleared (${target})`, "info");
            },
          })("", subDone);
        },
      });
    };

    for (const group of groups) {
      items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
      // A null model id means no layer sets a model and the parent has none to inherit.
      items.push(headerItem(theme, group.modelId ?? "(no model)"));
      // Widest thinking cell in this group, so the model tags line up under it.
      const thinkingWidth = Math.max(
        ...group.rows.map(
          (row) => `${row.thinking ?? "inherit"}${row.thinkingTag}`.length,
        ),
      );
      for (const row of group.rows) {
        const thinkingDisplay = `${row.thinking ?? "inherit"}${row.thinkingTag}`;
        items.push({
          id: `type:${row.type}`,
          label: `${agentBulletPrefix(theme)}${row.type}`,
          currentValue: `${thinkingDisplay.padEnd(thinkingWidth)} ${row.tag}`,
          description: `Model and thinking level for the ${row.type} agent type. Select to set or clear either.`,
          submenu: typeSheetFor(
            row.type,
            resolveHarnessType(row.type),
            group.modelId,
            row.thinking,
          ),
        });
      }
    }

    items.push({
      id: SEPARATOR_ID,
      label: "─────────────────────────",
      currentValue: "────────",
    });
    const nonOverridden = types.filter(
      (type) =>
        !hasExplicitPerTypeOverride(
          sessionOverrides,
          agentConfigSnapshot,
          type,
          sessionThinking,
        ),
    );
    if (nonOverridden.length > 0) {
      items.push({
        id: "overrideType",
        label: "Override another type...",
        currentValue: "",
        description:
          "Add a model or thinking override for an agent type that currently inherits.",
        submenu: (_currentValue, subDone) =>
          createSearchableSelect(
            nonOverridden.map((typeName) => ({
              value: typeName,
              label: `${agentBulletPrefix(theme)}${typeName}`,
            })),
            {
              onSelect: (typeName) => {
                if (typeName == null) return subDone();
                const harnessId = resolveHarnessType(typeName);
                const config = getAgentConfig(typeName);
                const effectiveModel = store.modelFor(
                  typeName,
                  parentModelId,
                  config,
                  harnessId,
                );
                // Nothing is written yet, so the sheet offers only sets: its
                // Clear row appears once a layer carries one of the two keys.
                return typeSheetFor(
                  typeName,
                  harnessId,
                  effectiveModel,
                  displayedThinking({
                    type: typeName,
                    agentConfig: config,
                    harnessFamily: harnessFamilyOf(harnessId),
                    config: agentConfigSnapshot,
                    harnessDefault: store.defaultThinkingForHarness(harnessId),
                    sessionThinking,
                  }).level,
                )("", subDone);
              },
              onCancel: () => subDone(),
            },
            theme,
          ),
      });
    }

    items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
    // Each level is offered only when it carries model or thinking settings.
    const modelLevels = store.modelSettingsLevels();
    const availableLevels: AvailableLevels = {
      ...modelLevels,
      project: modelLevels.project && projectOffered,
    };
    if (
      availableLevels.session ||
      availableLevels.global ||
      availableLevels.project
    ) {
      items.push({
        id: "clearAll",
        label: "Clear all model and thinking overrides...",
        currentValue: "",
        description:
          "Discard model and thinking overrides at the chosen level (session, global, project, or all).",
        submenu: createClearAllSubmenu({
          theme,
          projectOffered,
          availableLevels,
          message: (target) =>
            `Clear all model and thinking overrides at the ${target} level?`,
          onConfirm: (target) => {
            store.mutate.agent.clearAllModelOverrides(target);
            notify(`Model and thinking overrides cleared (${target})`, "info");
          },
        }),
      });
    }

    return items;
  };

  const settingsList = new SettingsList(
    buildItems(theme),
    15,
    buildSettingsListTheme(theme),
    (_id, _v) => rebuild?.(buildItems(theme)),
    close,
  );
  const screen = new SettingsListWrapper(settingsList, {
    title: "Model Settings",
    theme,
    onCancel: close,
    onRebuild: (r) => {
      rebuild = r;
    },
  });
  return asSubmenuComponent(screen);
}

/** What the topmost agents menu gives the "Model overrides" row. */
interface ModelOverridesRowOptions {
  /** Command context the hosted screen reads its ui sink, parent model, and registry from. */
  ctx: ExtensionCommandContext;
  store: ReturnType<typeof getStore>;
  theme: Theme;
  /** Each harness's own list, read once when the menu tree opened. */
  harnessModelOptions: HarnessModelOptions;
  /** pi's default thinking level, resolved once when the topmost menu opens. */
  piDefaultThinking: ThinkingLevel | undefined;
}

/** The topmost menu's "Model overrides" row, owning the whole model screen; its value summarizes the global default. */
export function buildModelOverridesRow(
  options: ModelOverridesRowOptions,
): SettingItem {
  const { ctx, store, theme, harnessModelOptions, piDefaultThinking } = options;
  const defaultDisplay = () => {
    return defaultRowValue(
      store.sessionDefaultModel,
      store.agentConfigSnapshot().default,
      store.hasProjectModelKey("default"),
    );
  };

  return {
    id: "modelOverrides",
    label: "Model overrides",
    currentValue: defaultDisplay(),
    description:
      "Pi's default model plus per-harness and per-type model overrides; opens the model settings screen.",
    submenu: (_currentValue, done) =>
      buildModelSettingsScreen({
        ctx,
        store,
        theme,
        harnessModelOptions,
        piDefaultThinking,
        // Forward the fresh value so the row repaints without reopening the command.
        close: () => done(defaultDisplay()),
      }),
  };
}
