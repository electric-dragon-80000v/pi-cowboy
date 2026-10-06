/**
 * Model settings screen: global default row, per-type override rows, and clear entries.
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
import { getAgentConfig, getAllTypes } from "../../agents/agent-types.js";
import type { Theme } from "../types.js";
import { agentBulletPrefix } from "../format.js";
import { getSessionCtx, getStore } from "../../shell.js";
import {
  buildModelGroups,
  hasExplicitPerTypeOverride,
  type AgentTypeModelConfig,
} from "../../models/model-groups.js";
import { findModelInRegistry } from "../../utils.js";
import type { SessionModelOverrides } from "../../models/model-precedence.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { asSubmenuComponent } from "./screen-host.js";
import {
  createClearAllSubmenu,
  type AvailableLevels,
  type TargetChoice,
} from "./submenus/target-select.js";
import { createModelSelectSubmenu } from "./submenus/model-select.js";
import {
  SEPARATOR_ID,
  buildSettingsListTheme,
  createSearchableSelect,
  headerItem,
  type Notify,
  type SubmenuFactory,
} from "./helpers.js";

/** Pad level labels so every row's tag aligns ("minimal" is the longest at 7 chars). */
const THINKING_COLUMN_WIDTH = 7;

/** Global-default display value. Tags mark the winning non-global layer (session > project); untagged means global won. */
function defaultRowValue(
  sessionDefault: string | null,
  effectiveDefault: string | null,
  hasProjectDefault: boolean,
  parentModelId: string | null,
): string {
  if (sessionDefault != null) return `${sessionDefault} [session]`;
  // Nothing configures a default, so the chain falls through to the parent's model.
  if (effectiveDefault == null)
    return parentModelId == null ? "(no model)" : "(inherits parent)";
  return hasProjectDefault ? `${effectiveDefault} [project]` : effectiveDefault;
}

/** Per-render plumbing shared by every row: the target+model submenu factory plus per-key layer availability. */
interface ModelOverridePlumbing {
  /** Target + model picker submenu for one config key. */
  modelSubmenuFor: (
    typeName: string,
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
  modelOptions: string[];
  notify: Notify;
  /**
   * Repaint the hosting list. Needed for inherit picks, which complete with no value
   * (SettingsList only rebuilds on a DEFINED value).
   */
  refresh: () => void;
}

function createModelOverridePlumbing(
  options: ModelOverrideRowOptions,
): ModelOverridePlumbing {
  const { store, theme, modelOptions, notify, refresh } = options;
  const projectOffered = store.isProjectWritable;

  // Inherit picks null, which clears the key at the picked layer (ADR-0008 delete semantics).
  const modelOverrideOnSelect =
    (
      key: string,
      label: string,
    ): ((
      target: "session" | "global" | "project",
      model: string | null,
    ) => void) =>
    (target, model) => {
      const inherits = model === null;
      if (inherits) store.mutate.agent.clearModelOverride(key, target);
      else store.mutate.agent.setModelOverride(key, model, target);
      notify(
        inherits
          ? `${label} inherits parent model`
          : `${label} model set to ${model} (${target})`,
        "info",
      );
      if (inherits) refresh();
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
    modelSubmenuFor: (typeName, effectiveModel, showClear, availableLevels) => {
      const onSet = modelOverrideOnSelect(typeName, typeName);
      if (showClear) {
        return createModelSelectSubmenu({
          modelOptions,
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
        showClear: false,
        projectOffered,
        theme,
        currentModel: effectiveModel,
        availableLevels,
        onSet,
      });
    },
    levelsFor: (key) => ({
      session: store.sessionModelOverride(key) != null,
      global: store.hasGlobalModelKey(key),
      project: store.hasProjectModelKey(key),
    }),
  };
}

/** What the "Model Settings" screen reads from the row hosting it. */
interface ModelSettingsScreenOptions {
  /** Command context the screen reads its parent model and registry from. */
  ctx: ExtensionCommandContext;
  store: ReturnType<typeof getStore>;
  theme: Theme;
  modelOptions: string[];
  /** pi's default thinking level, resolved by the hosting menu (this screen's factory is synchronous). */
  piDefaultThinking: ThinkingLevel | undefined;
  /** Close back to the hosting menu (the host row's submenu `done`). */
  close: () => void;
}

/** The "Model Settings" screen as a Component a submenu can host in place. */
function buildModelSettingsScreen(
  options: ModelSettingsScreenOptions,
): Component {
  const { ctx, store, theme, modelOptions, piDefaultThinking, close } = options;
  let rebuild: ((items: SettingItem[]) => void) | undefined;

  const buildItems = (theme: Theme): SettingItem[] => {
    const items: SettingItem[] = [];
    const projectOffered = store.isProjectWritable;
    const { levelsFor, modelSubmenuFor } = createModelOverridePlumbing({
      store,
      theme,
      modelOptions,
      notify: (message, type) => ctx.ui.notify(message, type),
      // Inherit picks complete with no value, so refresh the row here.
      refresh: () => rebuild?.(buildItems(theme)),
    });

    const session = getSessionCtx();
    const parentModel = session.model ?? ctx.model;
    const parentModelId = parentModel
      ? `${parentModel.provider}/${parentModel.id}`
      : null;
    const agentConfigSnapshot = store.agentConfigSnapshot();
    const sessionDefault = store.sessionDefaultModel;
    const effectiveDefault = agentConfigSnapshot.default;
    const globalDisplayValue = defaultRowValue(
      sessionDefault,
      effectiveDefault,
      store.hasProjectModelKey("default"),
      parentModelId,
    );
    const defaultLevels = levelsFor("default");

    items.push({
      id: "defaultModel",
      label: "Global default model",
      currentValue: globalDisplayValue,
      description:
        "Model used when no session default, per-type override, or agent-template model applies.",
      submenu: modelSubmenuFor(
        "default",
        effectiveDefault,
        defaultLevels.session || defaultLevels.global || defaultLevels.project,
        defaultLevels,
      ),
    });

    // One group per resolved model with a listed row, alphabetical by model id.
    const registry = session.modelRegistry;
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

    const groups = buildModelGroups({
      types,
      agentConfigs,
      config: agentConfigSnapshot,
      sessionOverrides,
      hasProjectModelKey: (key) => store.hasProjectModelKey(key),
      parentModelId,
      piDefaultThinking,
      findModel: (modelId) => findModelInRegistry(modelId, registry, undefined),
    });

    for (const group of groups) {
      items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
      // A null model id means no layer sets a model and the parent has none to inherit.
      items.push(headerItem(theme, group.modelId ?? "(no model)"));
      for (const row of group.rows) {
        items.push({
          id: `type:${row.type}`,
          label: `${agentBulletPrefix(theme)}${row.type}`,
          currentValue: `${row.thinking.padEnd(THINKING_COLUMN_WIDTH)} ${row.tag}`,
          description: `Model for the ${row.type} agent type. Select to set or clear its override.`,
          // Listed rows always carry an explicit override, so Clear is always offered.
          submenu: modelSubmenuFor(
            row.type,
            group.modelId,
            true,
            levelsFor(row.type),
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
        ),
    );
    if (nonOverridden.length > 0) {
      items.push({
        id: "overrideType",
        label: "Override another type...",
        currentValue: "",
        description:
          "Add a model override for an agent type that currently inherits.",
        submenu: (_currentValue, subDone) =>
          createSearchableSelect(
            nonOverridden.map((typeName) => ({
              value: typeName,
              label: `${agentBulletPrefix(theme)}${typeName}`,
            })),
            {
              onSelect: (typeName) => {
                if (typeName == null) return subDone();
                const effectiveModel = store.modelFor(
                  typeName,
                  parentModelId,
                  getAgentConfig(typeName),
                );
                return modelSubmenuFor(
                  typeName,
                  effectiveModel,
                  false,
                  // The factory ignores its currentValue arg (pre-selection
                  // rides the closure above), so null needs no display form here.
                )(effectiveModel ?? "", subDone);
              },
              onCancel: () => subDone(),
            },
            theme,
          ),
      });
    }

    items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
    // Each level is offered only when it has model settings.
    const availableLevels: AvailableLevels = {
      session: store.hasSessionModelSettings,
      global: store.hasGlobalModelSettings,
      project: store.hasProjectModelSettings && projectOffered,
    };
    if (
      availableLevels.session ||
      availableLevels.global ||
      availableLevels.project
    ) {
      items.push({
        id: "clearAll",
        label: "Clear all model overrides...",
        currentValue: "",
        description:
          "Discard model overrides at the chosen level (session, global, project, or all).",
        submenu: createClearAllSubmenu({
          theme,
          projectOffered,
          availableLevels,
          message: (target) =>
            `Clear all model overrides at the ${target} level?`,
          onConfirm: (target) => {
            store.mutate.agent.clearAllModelOverrides(target);
            ctx.ui.notify(`Model overrides cleared (${target})`, "info");
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
  modelOptions: string[];
  /** pi's default thinking level, resolved once when the topmost menu opens. */
  piDefaultThinking: ThinkingLevel | undefined;
}

/** The topmost menu's "Model overrides" row, owning the whole model screen; its value summarizes the global default. */
export function buildModelOverridesRow(
  options: ModelOverridesRowOptions,
): SettingItem {
  const { ctx, store, theme, modelOptions, piDefaultThinking } = options;
  const defaultDisplay = () => {
    const session = getSessionCtx();
    const parentModel = session.model ?? ctx.model;
    return defaultRowValue(
      store.sessionDefaultModel,
      store.agentConfigSnapshot().default,
      store.hasProjectModelKey("default"),
      parentModel ? `${parentModel.provider}/${parentModel.id}` : null,
    );
  };

  return {
    id: "modelOverrides",
    label: "Model overrides",
    currentValue: defaultDisplay(),
    description:
      "Global default model plus per-type model overrides; opens the model settings screen.",
    submenu: (_currentValue, done) =>
      buildModelSettingsScreen({
        ctx,
        store,
        theme,
        modelOptions,
        piDefaultThinking,
        // Forward the fresh value so the row repaints without reopening the command.
        close: () => done(defaultDisplay()),
      }),
  };
}
