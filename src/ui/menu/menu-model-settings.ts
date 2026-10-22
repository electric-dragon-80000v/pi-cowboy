/**
 * Model settings screen: pi's default row, one row per other harness's default,
 * per-type override rows, and clear entries. A model and the thinking level it
 * runs at are one setting: each row shows the pair, and picking a model asks for
 * the level right after it and writes both at the same layer.
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
import { ThinkingLevelSchema, type ThinkingLevel } from "../../types.js";
import { getAgentConfig, getAllTypes } from "../../agents/agent-types.js";
import { resolveHarnessType } from "../../agents/spawn-defaults.js";
import {
  harnessFamilyOf,
  modelKeysOf,
  type HarnessModelOptions,
} from "../../agents/harness/harness-registry.js";
import { isPiFamilyHarness, type AnyHarnessId } from "../../agents/harness.js";
import type { ConfigLayerPresence } from "../../config/types.js";
import type { ConfigStore } from "../../config/config-store.js";
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
  type AvailableLevels,
  type SetTarget,
  type TargetChoice,
} from "./submenus/target-select.js";
import { createModelThinkingSubmenu } from "./submenus/model-select.js";
import { pairedRow, thinkingOfferingForModel } from "./model-pairing.js";
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

/**
 * The layer a resolved default carries: session wins over project, and a global
 * value is untagged.
 */
function layerTag(session: boolean, project: boolean): string {
  if (session) return " [session]";
  return project ? " [project]" : "";
}

/** A level's tag; a level no layer names belongs to no layer. */
function thinkingTagOf(
  levels: ConfigLayerPresence,
  thinking: string | null,
): string {
  if (thinking === null) return "";
  return layerTag(levels.session, levels.project);
}

/**
 * Write one harness's default level. A pi-family file layer holds the scalar
 * `agent.defaultThinking`, whose type is pi's own level union, so a token
 * outside that union cannot be stored there; the session slot takes any token
 * the model advertised.
 */
function writeHarnessDefaultThinking(
  store: ConfigStore,
  harnessId: AnyHarnessId,
  token: string | null,
  target: SetTarget,
): void {
  if (token === null) {
    store.mutate.agent.clearHarnessDefaultThinking(harnessId, target);
    return;
  }
  if (
    target !== "session" &&
    isPiFamilyHarness(harnessId) &&
    !ThinkingLevelSchema.safeParse(token).success
  ) {
    return;
  }
  store.mutate.agent.setHarnessDefaultThinking(harnessId, token, target);
}

/** Write one type's level at a layer; null leaves no entry there. */
function writeTypeThinking(
  store: ConfigStore,
  type: string,
  token: string | null,
  target: SetTarget,
): void {
  if (token === null) store.mutate.agent.clearThinkingOverride(type, target);
  else store.mutate.agent.setThinkingOverride(type, token, target);
}

/** What one row's pair picker is handed: the list it offers plus where writes land. */
interface PairSubmenuOptions {
  label: string;
  harnessId: AnyHarnessId;
  modelOptions: readonly string[];
  mergedModels: readonly string[];
  model: string | null;
  thinking: string | null;
  modelLevels: ConfigLayerPresence;
  thinkingLevels: ConfigLayerPresence;
  write: (target: SetTarget, model: string, token: string | null) => void;
  clear: (target: TargetChoice) => void;
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
 * The harnesses that get a default row: every runnable harness outside the
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
    const notify: Notify = (message, type) => ctx.ui.notify(message, type);
    const session = getSessionCtx();
    const parentModel = session.model ?? ctx.model;
    const parentModelId = parentModel
      ? `${parentModel.provider}/${parentModel.id}`
      : null;
    // The session's live level is the pi family's last chain step, and this
    // screen shows the level a launch would send.
    const parentThinking = session.thinkingLevel ?? null;
    const agentConfigSnapshot = store.agentConfigSnapshot();
    const configuredModels = extractConfiguredModels(agentConfigSnapshot);

    const refresh = (): void => {
      rebuild?.(buildItems(theme));
    };

    /** The thinking control a model of `harnessId` offers, in its vocabulary. */
    const offeringFor =
      (harnessId: AnyHarnessId) => (modelKey: string | null) =>
        thinkingOfferingForModel({
          harnessId,
          modelKey,
          entries: harnessModelOptions,
          registry: session.modelRegistry,
          // The model the chain would inherit, which ctx.model answers when the
          // session names none.
          parentModel,
        });

    /**
     * The layer picker → model → level flow for one row, plus the notice each
     * write leaves. A clear removes the model and the level, so its picker
     * offers every layer carrying either.
     */
    const pairSubmenu = (args: PairSubmenuOptions): SubmenuFactory => {
      const clearLevels: AvailableLevels = {
        session: args.modelLevels.session || args.thinkingLevels.session,
        global: args.modelLevels.global || args.thinkingLevels.global,
        project: args.modelLevels.project || args.thinkingLevels.project,
      };
      return createModelThinkingSubmenu({
        modelOptions: args.modelOptions,
        mergedModels: args.mergedModels,
        projectOffered,
        theme,
        ctx,
        currentModel: args.model,
        currentThinking: args.thinking,
        showClear:
          clearLevels.session || clearLevels.global || clearLevels.project,
        availableLevels: clearLevels,
        offeringFor: offeringFor(args.harnessId),
        onSet: (target, model, token) => {
          args.write(target, model, token);
          notify(
            `${args.label} set to ${model} · ${token ?? "(none)"} (${target})`,
            "info",
          );
        },
        onClear: (target) => {
          args.clear(target);
          notify(`${args.label} cleared (${target})`, "info");
          refresh();
        },
      });
    };

    const agentConfigSnapshotModel = agentConfigSnapshot.default;
    const defaultLevels = store.modelOverrideLevels("default");
    const piThinkingLevels = store.harnessDefaultThinkingLevels("pi");
    const piThinking = store.defaultThinkingForHarness("pi");
    const piModel = store.sessionDefaultModel ?? agentConfigSnapshotModel;

    items.push({
      id: "defaultModel",
      label: "Pi Default Model",
      currentValue: pairedRow({
        model: piModel,
        modelTag: layerTag(
          defaultLevels.session,
          store.hasProjectModelKey("default"),
        ),
        thinking: piThinking,
        thinkingTag: thinkingTagOf(piThinkingLevels, piThinking),
      }),
      description:
        "Default model and thinking level applied when no session, per-type, or template override is set.",
      submenu: pairSubmenu({
        label: "Pi Default Model",
        harnessId: "pi",
        modelOptions: modelKeysOf(harnessModelOptions, "pi"),
        // pi's rows also offer the models the config already names, so a key a
        // session wrote stays pickable when the catalogue no longer lists it.
        mergedModels: mergedModelsForHarness("pi", configuredModels),
        model: piModel,
        thinking: piThinking,
        modelLevels: defaultLevels,
        thinkingLevels: piThinkingLevels,
        write: (target, model, token) => {
          store.mutate.agent.setModelOverride("default", model, target);
          writeHarnessDefaultThinking(store, "pi", token, target);
        },
        clear: (target) => {
          store.mutate.agent.clearModelOverride("default", target);
          store.mutate.agent.clearHarnessDefaultThinking("pi", target);
        },
      }),
    });

    for (const harnessId of harnessIds) {
      const label = `${getHarnessRegistry().displayName(harnessId)} Default Model`;
      const modelLevels = store.harnessDefaultModelLevels(harnessId);
      const thinkingLevels = store.harnessDefaultThinkingLevels(harnessId);
      const thinking = store.defaultThinkingForHarness(harnessId);
      items.push({
        id: `harness:${harnessId}`,
        label,
        currentValue: pairedRow({
          model: store.defaultModelForHarness(harnessId),
          modelTag: layerTag(modelLevels.session, modelLevels.project),
          thinking,
          thinkingTag: thinkingTagOf(thinkingLevels, thinking),
        }),
        description: `Default model and thinking level applied to agents launched under ${harnessId} when no session, per-type, or template override is set.`,
        submenu: pairSubmenu({
          label,
          harnessId,
          modelOptions: modelKeysOf(harnessModelOptions, harnessId),
          // A row outside the pi family offers its own list alone.
          mergedModels: [],
          model: store.defaultModelForHarness(harnessId),
          thinking,
          modelLevels,
          thinkingLevels,
          write: (target, model, token) => {
            store.mutate.agent.setHarnessDefaultModel(harnessId, model, target);
            writeHarnessDefaultThinking(store, harnessId, token, target);
          },
          clear: (target) => {
            store.mutate.agent.clearHarnessDefaultModel(harnessId, target);
            store.mutate.agent.clearHarnessDefaultThinking(harnessId, target);
          },
        }),
      });
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
        const configured = store.defaultThinkingForHarness(harnessId);
        if (configured !== null) return configured;
        // pi's own settings default is what the binary applies when no level
        // is sent, so it sits below the parent's level: a parent level, when
        // there is one, is sent explicitly and wins.
        return isPiFamilyHarness(harnessId) && parentThinking === null
          ? (piDefaultThinking ?? null)
          : null;
      },
      harnessFamilyFor: (type) => harnessFamilyOf(resolveHarnessType(type)),
      hasProjectModelKey: (key) => store.hasProjectModelKey(key),
      hasProjectThinkingKey: (type) => store.hasProjectThinkingKey(type),
      parentModelId,
      parentThinking,
    });

    /** The pair picker for one agent type: model and level at the picked layer. */
    const typeSubmenu = (
      type: string,
      harnessId: AnyHarnessId,
      model: string | null,
      thinking: string | null,
    ): SubmenuFactory =>
      pairSubmenu({
        label: type,
        harnessId,
        modelOptions: modelKeysOf(harnessModelOptions, harnessId),
        mergedModels: mergedModelsForHarness(harnessId, configuredModels),
        model,
        thinking,
        modelLevels: store.modelOverrideLevels(type),
        thinkingLevels: store.thinkingOverrideLevels(type),
        write: (target, picked, token) => {
          store.mutate.agent.setModelOverride(type, picked, target);
          writeTypeThinking(store, type, token, target);
        },
        clear: (target) => {
          store.mutate.agent.clearModelOverride(type, target);
          store.mutate.agent.clearThinkingOverride(type, target);
        },
      });

    for (const group of groups) {
      items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
      // A null model id means no layer sets a model and the parent has none to inherit.
      items.push(headerItem(theme, group.modelId ?? "(no model)"));
      // Widest thinking cell in this group, so the model tags line up under it.
      const thinkingWidth = Math.max(
        ...group.rows.map(
          (row) => `${row.thinking ?? "(none)"}${row.thinkingTag}`.length,
        ),
      );
      for (const row of group.rows) {
        const harnessId = resolveHarnessType(row.type);
        const thinkingDisplay = `${row.thinking ?? "(none)"}${row.thinkingTag}`;
        // The level's tag already names the model's layer when both were written
        // there, so the model tag is left off that row. The two tags carry
        // different leading-space conventions, hence the trim.
        const modelTag =
          row.thinking !== null && row.thinkingTag.trim() === row.tag.trim()
            ? ""
            : row.tag;
        items.push({
          id: `type:${row.type}`,
          label: `${agentBulletPrefix(theme)}${row.type}`,
          currentValue:
            `${thinkingDisplay.padEnd(thinkingWidth)} ${modelTag}`.trimEnd(),
          description: `Model and thinking level for the ${row.type} agent type.`,
          submenu: typeSubmenu(
            row.type,
            harnessId,
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
          "Configure model and thinking level overrides for an agent type currently using inherited defaults.",
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
                // The type inherits both values, so its picker opens on what
                // the launch would send and writes only what is picked.
                return typeSubmenu(
                  typeName,
                  harnessId,
                  effectiveModel,
                  displayedThinking({
                    type: typeName,
                    agentConfig: config,
                    harnessFamily: harnessFamilyOf(harnessId),
                    config: agentConfigSnapshot,
                    harnessDefault: store.defaultThinkingForHarness(harnessId),
                    parentThinking: parentThinking ?? undefined,
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
          "Remove model and thinking level overrides across a selected configuration layer (session, global, project, or all).",
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

/** The topmost menu's "Model overrides" row, owning the whole model screen; its value summarizes pi's default pair. */
export function buildModelOverridesRow(
  options: ModelOverridesRowOptions,
): SettingItem {
  const { ctx, store, theme, harnessModelOptions, piDefaultThinking } = options;
  const defaultDisplay = (): string => {
    const levels = store.modelOverrideLevels("default");
    const thinkingLevels = store.harnessDefaultThinkingLevels("pi");
    const thinking = store.defaultThinkingForHarness("pi");
    return pairedRow({
      model: store.sessionDefaultModel ?? store.agentConfigSnapshot().default,
      modelTag: layerTag(levels.session, store.hasProjectModelKey("default")),
      thinking,
      thinkingTag: thinkingTagOf(thinkingLevels, thinking),
    });
  };

  return {
    id: "modelOverrides",
    label: "Model overrides",
    currentValue: defaultDisplay(),
    description:
      "Pi's default model and thinking level, plus per-harness and per-type overrides; opens the model settings screen.",
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
