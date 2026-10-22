/**
 * menu-spawn-options.ts — the spawn wizard's first screen: every option a run
 * makes before it has a worktree target, a name, or a prompt.
 *
 * The harness names which model catalogue and thinking vocabulary the Model and
 * Thinking level rows read, so a harness or type change re-seeds those two rows
 * rather than carrying a key or a token across catalogues.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import type { ModelChoice } from "../../types.js";
import type { Theme } from "../types.js";
import { selectable } from "../../availability.js";
import type { AnyHarnessId } from "../../agents/harness.js";
import { getAgentConfig, getAvailableTypes } from "../../agents/agent-types.js";
import {
  resolveDefaultAgentType,
  resolveHarnessType,
} from "../../agents/spawn-defaults.js";
import {
  modelKeysOf,
  type HarnessModelOptions,
} from "../../agents/harness/harness-registry.js";
import { agentBulletPrefix } from "../format.js";
import {
  getHarnessAvailability,
  getHarnessRegistry,
  getPiInstance,
  getSessionCtx,
  getStore,
} from "../../shell.js";
import {
  SEPARATOR_ID,
  buildSettingsListTheme,
  extractConfiguredModels,
  mergedModelsForHarness,
} from "./helpers.js";
import { CLOSED_SUBMENU, ScreenHost } from "./screen-host.js";
import { createModelSelectSubmenu } from "./submenus/model-select.js";
import { spawnChoices, THINKING_LEVEL_ROW_ID } from "./spawn-choice.js";
import {
  buildWorktreeRow,
  loadWorktreeChoices,
  type WorktreePick,
} from "./menu-spawn-worktree.js";
import { createInputSubmenu } from "./submenus/numeric-input.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";

/** Everything the config screen collects; the run starts once the prompts after it answer. */
export interface SpawnConfiguration {
  type: string;
  /** The harness this spawn launches under, as shown on the Harness row. */
  harness: AnyHarnessId;
  /** The model and its level, when this spawn names either. */
  modelChoice?: ModelChoice;
  worktreeChoice: WorktreePick;
  /** Empty means "derive from the prompt at spawn time". */
  description: string;
  fork: boolean;
  runInBackground: boolean;
}

/** Opens the options screen; resolves undefined when the user cancelled. */
export async function askSpawnConfiguration(
  ctx: ExtensionCommandContext,
  harnessModelOptions: HarnessModelOptions,
): Promise<SpawnConfiguration | undefined> {
  const types = getAvailableTypes();
  if (types.length === 0) {
    ctx.ui.notify("No agent types available", "error");
    return undefined;
  }

  // The configured default leads; a value that no longer resolves falls to the first type.
  const configuredType = resolveDefaultAgentType();
  let selectedType = types.includes(configuredType) ? configuredType : types[0];

  const session = getSessionCtx();
  // No cwd, or a cwd outside git, leaves the screen without a Worktree row.
  const worktrees = await loadWorktreeChoices(getPiInstance(), session.cwd);

  const store = getStore();
  const parentModelId = session.model
    ? `${session.model.provider}/${session.model.id}`
    : null;

  /** The harnesses the row offers: registered in this session and launchable here. */
  const harnessChoices: AnyHarnessId[] = [
    ...selectable(getHarnessRegistry().ids(), getHarnessAvailability()),
  ];

  /** Effective model for a type under a harness, resolved per call so a change re-derives it. */
  const modelFor = (type: string, harness: AnyHarnessId): string =>
    store.modelFor(type, parentModelId, getAgentConfig(type), harness) ?? "";

  /** The choices this spawn makes, against the lists this menu tree loaded. */
  const choices = spawnChoices({
    entries: harnessModelOptions,
    registry: session.modelRegistry,
    parentModel: session.model,
  });

  /**
   * The type's configured token, carried as the chain resolved it. A token the
   * model's own list does not contain still rides the spawn — the resolved
   * level is what the other spawn paths send, and a harness that knows its
   * vocabulary warns rather than refusing.
   */
  const seedThinking = (
    type: string,
    harness: AnyHarnessId,
  ): string | undefined =>
    store.thinkingFor(type, getAgentConfig(type), harness);

  let selectedHarness = resolveHarnessType(selectedType);
  let currentModelStr = modelFor(selectedType, selectedHarness);
  let currentThinking = seedThinking(selectedType, selectedHarness);
  let currentBackground: boolean = true;
  let forkState: boolean = getAgentConfig(selectedType)?.fork ?? false;
  // A new worktree is the default, and its name is asked after Spawn.
  let worktreeChoice: WorktreePick = worktrees
    ? { kind: "new" }
    : { kind: "inherit" };
  let currentDescription = "";

  /** Launch defaults follow the type, the harness included: its template names one first. */
  const applyType = (type: string): void => {
    selectedType = type;
    selectedHarness = resolveHarnessType(type);
    currentModelStr = modelFor(type, selectedHarness);
    currentThinking = seedThinking(type, selectedHarness);
    forkState = getAgentConfig(type)?.fork ?? false;
  };

  /**
   * A harness switch re-seeds the model and the level rather than carrying them:
   * a key belongs to one harness's catalogue, and a token to one vocabulary.
   */
  const applyHarness = (harness: AnyHarnessId): void => {
    selectedHarness = harness;
    currentModelStr = modelFor(selectedType, harness);
    currentThinking = seedThinking(selectedType, harness);
  };

  const buildItems = (): SettingItem[] => {
    // Empty when the whole chain is unset and the parent has no model either.
    const displayModel = currentModelStr || "(no model)";
    return [
      {
        id: "spawn",
        label: "Spawn",
        currentValue: "",
        description: "Ask for the worktree name and prompt, then launch",
        submenu: (_v, subDone) => {
          const result = choices.choice(
            selectedHarness,
            currentModelStr,
            currentThinking,
          );
          if (result.kind === "missing") {
            ctx.ui.notify(`Model not found: ${result.modelKey}`, "error");
            subDone();
            return CLOSED_SUBMENU;
          }

          closeConfig({
            type: selectedType,
            harness: selectedHarness,
            modelChoice:
              result.kind === "chosen" ? result.modelChoice : undefined,
            worktreeChoice,
            description: currentDescription,
            fork: forkState,
            runInBackground: currentBackground,
          });
          return CLOSED_SUBMENU;
        },
      },
      {
        id: SEPARATOR_ID,
        label: " ",
        currentValue: "",
      },
      {
        id: "type",
        label: "Type",
        currentValue: selectedType,
        description: getAgentConfig(selectedType)?.description ?? "Agent type",
        submenu: (_v: string, outerDone: (value?: string) => void) => {
          const list = new SettingsList(
            types.map((type) => ({
              id: type,
              label: `${agentBulletPrefix(theme)}${type}`,
              currentValue: type,
              description: getAgentConfig(type)?.description ?? "Agent type",
              submenu: (_tv: string, _subDone: (value?: string) => void) => {
                outerDone(type);
                return CLOSED_SUBMENU;
              },
            })),
            10,
            buildSettingsListTheme(theme),
            () => {},
            () => outerDone(),
            { enableSearch: true },
          );
          // Reopening the row lands on the type in force, not the top of the list.
          list.selectItem(selectedType);
          return list;
        },
      },
      {
        id: "harness",
        label: "Harness",
        currentValue: selectedHarness,
        description:
          "Harness that launches this agent. A change re-seeds the model and thinking level from that harness's own defaults: both belong to the harness that reads them.",
        submenu: (_v: string, outerDone: (value?: string) => void) => {
          const list = new SettingsList(
            harnessChoices.map((id) => ({
              id,
              label: `${agentBulletPrefix(theme)}${id}`,
              currentValue: id,
              submenu: (_hv: string, _subDone: (value?: string) => void) => {
                outerDone(id);
                return CLOSED_SUBMENU;
              },
            })),
            10,
            buildSettingsListTheme(theme),
            () => {},
            () => outerDone(),
            { enableSearch: true },
          );
          // Reopening the row lands on the harness in force.
          list.selectItem(selectedHarness);
          return list;
        },
      },
      {
        id: "model",
        label: "Model",
        currentValue: displayModel,
        description: "Override the default model for this agent",
        submenu: createModelSelectSubmenu({
          modelOptions: modelKeysOf(harnessModelOptions, selectedHarness),
          mergedModels: mergedModelsForHarness(
            selectedHarness,
            extractConfiguredModels(store.agentConfigSnapshot()),
          ),
          showClear: false,
          projectOffered: store.isProjectWritable,
          theme,
          onSet: (_target, model) => {
            currentModelStr = model ?? "";
            // A token belongs to the model it was picked for: the new one may
            // have no control, or a closed list that does not contain it.
            currentThinking = choices.clamp(
              selectedHarness,
              currentModelStr,
              currentThinking,
            );
            // Rebuild so the row shows the model just picked.
            rebuild?.(buildItems());
          },
        }),
      },
      {
        id: "background",
        label: "Background",
        currentValue: currentBackground ? "ON" : "OFF",
        description: "Run the agent in the background",
        values: ["ON", "OFF"],
      },
      {
        id: "fork",
        label: "Fork session",
        currentValue: forkState ? "Yes" : "No",
        description: "Fork the parent session context into the subagent",
        values: ["Yes", "No"],
      },
      ...(worktrees
        ? [
            buildWorktreeRow(worktrees, {
              current: worktreeChoice,
              theme,
              onPick: (pick) => {
                worktreeChoice = pick;
              },
            }),
          ]
        : []),
      choices.row(selectedHarness, currentModelStr, currentThinking, {
        ctx,
        theme,
      }),
      { id: SEPARATOR_ID, label: " ", currentValue: "" },
      {
        id: "description",
        label: "Description",
        currentValue: currentDescription,
        description:
          "Short label shown in the agents list; derived from the prompt when left empty",
        submenu: createInputSubmenu(ctx),
      },
    ];
  };

  let theme: Theme;
  let closeConfig: (result?: SpawnConfiguration) => void;
  let rebuild: ((items: SettingItem[]) => void) | undefined;

  return await new ScreenHost(ctx).open<SpawnConfiguration>(
    ({ theme: screenTheme, close }) => {
      theme = screenTheme;
      closeConfig = close;

      const onChange = (id: string, newValue: string) => {
        switch (id) {
          case "type":
            applyType(newValue);
            break;
          case "harness": {
            // The row offers only harnesses this session registered and this
            // machine can launch, so a picked value is launchable as offered.
            const harness = harnessChoices.find((id) => id === newValue);
            if (harness !== undefined) applyHarness(harness);
            break;
          }
          case THINKING_LEVEL_ROW_ID:
            currentThinking = newValue === "inherit" ? undefined : newValue;
            break;
          case "background":
            currentBackground = newValue === "ON";
            break;
          case "fork":
            forkState = newValue === "Yes";
            break;
          case "description":
            currentDescription = newValue;
            break;
        }
        // Rebuild so displayed values stay in sync after any change.
        rebuild?.(buildItems());
      };
      const settingsList = new SettingsList(
        buildItems(),
        15,
        buildSettingsListTheme(theme),
        onChange,
        close,
      );
      return new SettingsListWrapper(settingsList, {
        title: "Spawn Options",
        theme,
        onCancel: close,
        onRebuild: (r) => {
          rebuild = r;
        },
      });
    },
  );
}
