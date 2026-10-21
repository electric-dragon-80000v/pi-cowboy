/**
 * Spawn agent wizard: options → worktree name (when new) → prompt → spawn.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import type { AgentWorktree, ModelChoice } from "../../types.js";
import type { Theme } from "../types.js";
import { getAgentConfig, getAvailableTypes } from "../../agents/agent-types.js";
import {
  resolveDefaultAgentType,
  resolveDefaultOrchestrator,
  resolveHarnessType,
  resolveWorktreeCheckoutType,
} from "../../agents/spawn-defaults.js";
import {
  modelKeysOf,
  type HarnessModelOptions,
} from "../../agents/harness/harness-registry.js";
import { agentBulletPrefix } from "../format.js";
import {
  getManager,
  getPiInstance,
  getSessionCtx,
  getStore,
  getCoordinator,
  getRuntime,
  getWorktreeMaterialization,
} from "../../shell.js";

import { AgentSandbox, formatLaunchCleanupNote } from "../../spawn/sandbox.js";
import {
  SEPARATOR_ID,
  actionReport,
  buildSettingsListTheme,
  extractConfiguredModels,
  mergedModelsForHarness,
} from "./helpers.js";
import { CLOSED_SUBMENU, ScreenHost } from "./screen-host.js";
import { createModelSelectSubmenu } from "./submenus/model-select.js";
import {
  choiceInvocation,
  spawnChoices,
  THINKING_LEVEL_ROW_ID,
} from "./spawn-choice.js";
import {
  buildWorktreeRow,
  loadWorktreeChoices,
  showWorktreeNameStep,
  type WorktreePick,
} from "./menu-spawn-worktree.js";
import { createInputSubmenu } from "./submenus/numeric-input.js";
import { createTextEditor } from "./submenus/text-editor.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";

/** The run's worktree, resolved once the name field has answered for a `new` choice. */
type WorktreeTarget =
  | { kind: "inherit" }
  | { kind: "picked"; path: string; branch: string }
  | { kind: "new"; branch: string };

/** Everything the config screen collects; the run starts once the prompts after it answer. */
interface SpawnConfiguration {
  type: string;
  /** The model and its level, when this spawn names either. */
  modelChoice?: ModelChoice;
  worktreeChoice: WorktreePick;
  /** Empty means "derive from the prompt at spawn time". */
  description: string;
  fork: boolean;
  runInBackground: boolean;
}

/** How much of the prompt a derived description keeps. */
const DERIVED_DESCRIPTION_MAX_LENGTH = 50;

/** Multi-step spawn wizard: options → worktree name (when new) → prompt → spawn. */
export async function showSpawnAgentMenu(
  ctx: ExtensionCommandContext,
  harnessModelOptions: HarnessModelOptions,
): Promise<void> {
  const types = getAvailableTypes();
  if (types.length === 0) {
    ctx.ui.notify("No agent types available", "error");
    return;
  }

  // The configured default leads; a value that no longer resolves falls to the first type.
  const configuredType = resolveDefaultAgentType();
  let selectedType = types.includes(configuredType) ? configuredType : types[0];

  const session = getSessionCtx();
  const parentCwd = session.cwd;
  // No cwd, or a cwd outside git, leaves the wizard without a Worktree row.
  const worktrees = await loadWorktreeChoices(getPiInstance(), parentCwd);

  const store = getStore();
  const parentModelId = session.model
    ? `${session.model.provider}/${session.model.id}`
    : null;

  /** Effective model for a type, resolved per call so a type change re-derives it. */
  const modelForType = (type: string): string =>
    store.modelFor(
      type,
      parentModelId,
      getAgentConfig(type),
      resolveHarnessType(type),
    ) ?? "";

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
  const seedThinking = (type: string): string | undefined =>
    store.thinkingFor(type, getAgentConfig(type), resolveHarnessType(type));

  let currentModelStr = modelForType(selectedType);
  let currentThinking = seedThinking(selectedType);
  let currentBackground: boolean = true;
  let forkState: boolean = getAgentConfig(selectedType)?.fork ?? false;
  // A new worktree is the default, and its name is asked after Spawn.
  let worktreeChoice: WorktreePick = worktrees
    ? { kind: "new" }
    : { kind: "inherit" };
  let currentDescription = "";

  /** Launch defaults follow the type, as they did when the type led the wizard. */
  const applyType = (type: string): void => {
    selectedType = type;
    currentModelStr = modelForType(type);
    currentThinking = seedThinking(type);
    forkState = getAgentConfig(type)?.fork ?? false;
  };

  const buildItems = (): SettingItem[] => {
    // The harness the selected type's spawn will launch under, so the Model
    // row offers exactly the list that launch would use.
    const selectedHarness = resolveHarnessType(selectedType);
    // Empty when the whole chain is unset and the parent has no model either.
    const displayModel = currentModelStr || "(no model)";
    const items: SettingItem[] = [
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

    return items;
  };

  let theme: Theme;
  let closeConfig: (result?: SpawnConfiguration) => void;
  let rebuild: ((items: SettingItem[]) => void) | undefined;

  /** Creates the named worktree for `agentType`; undefined when it could not be created (already notified). */
  const allocateWorktree = async (
    branch: string,
    agentType: string,
  ): Promise<AgentSandbox | undefined> => {
    try {
      return await AgentSandbox.allocate(getPiInstance(), {
        naming: { kind: "explicit", branch },
        parentCwd,
        worktreeRoot: store.agent.worktreeRoot,
        materialization: getWorktreeMaterialization(),
        dirtyCheckout: resolveWorktreeCheckoutType(agentType),
        notify: (message, kind) => ctx.ui.notify(message, kind),
        host: getRuntime()!.host,
      });
    } catch (err) {
      ctx.ui.notify(
        `Worktree creation failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return undefined;
    }
  };

  /** Launches the configured run; a `new` worktree is created here so a cancelled wizard leaves none behind. */
  const launch = async (
    configuration: SpawnConfiguration,
    worktree: WorktreeTarget,
    prompt: string,
  ): Promise<void> => {
    const pi = getPiInstance();
    // Minted before the worktree so the in-progress line names the handle
    // stop, cleanup, and steer will take.
    const spawnId = getManager().mintSpawnId();
    actionReport(ctx.ui).pending(
      `Spawning agent ${spawnId} (${configuration.type})`,
    );
    let sandbox: AgentSandbox | undefined;
    if (worktree.kind === "new") {
      sandbox = await allocateWorktree(worktree.branch, configuration.type);
      if (!sandbox) return;
    }

    // The run's worktree: the one just allocated, or a picked pre-existing one
    // (which the run works inside without owning). Absent for parent-cwd runs.
    const created = sandbox?.worktree;
    const runWorktree: AgentWorktree | undefined =
      created !== undefined
        ? { kind: "owned", path: created.path, branch: created.branch }
        : worktree.kind === "picked"
          ? {
              kind: "picked",
              path: worktree.path,
              branch: worktree.branch,
            }
          : undefined;

    const description =
      configuration.description.trim() !== ""
        ? configuration.description
        : (prompt.split("\n", 1)[0] ?? "").slice(
            0,
            DERIVED_DESCRIPTION_MAX_LENGTH,
          );

    const coordinator = getCoordinator();
    const orchestration = resolveDefaultOrchestrator();
    try {
      await coordinator.spawn(session, {
        spawnId,
        type: configuration.type,
        prompt,
        description,
        orchestration,
        modelChoice: configuration.modelChoice,
        worktree: runWorktree,
        hostRef: sandbox?.hostRef,
        projectTrusted: sandbox?.projectTrusted,
        invocation: {
          ...choiceInvocation(configuration.modelChoice),
          runInBackground: configuration.runInBackground,
          fork: configuration.fork,
        },
        runInBackground: configuration.runInBackground,
        fork: configuration.fork,
      });
    } catch (err) {
      const message = `Spawn failed: ${err instanceof Error ? err.message : String(err)}`;
      if (!sandbox) {
        ctx.ui.notify(message, "error");
        return;
      }
      // The worktree the spawn would have owned is cleaned up here.
      const outcome = await sandbox.teardown(pi);
      ctx.ui.notify(
        `${message}\n\n${formatLaunchCleanupNote(outcome)}`,
        "error",
      );
    }
  };

  const host = new ScreenHost(ctx);
  const configuration = await host.open<SpawnConfiguration>(
    ({ theme: screenTheme, close }) => {
      theme = screenTheme;
      closeConfig = close;

      const onChange = (id: string, newValue: string) => {
        switch (id) {
          case "type":
            applyType(newValue);
            break;
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
  if (configuration === undefined) return;

  // A "New worktree" choice is only a decision; its name arrives here, on the way
  // to the run, so the config screen never holds a half-answered target.
  let worktree: WorktreeTarget;
  if (configuration.worktreeChoice.kind === "new") {
    const branch = await showWorktreeNameStep(host, (message, kind) =>
      ctx.ui.notify(message, kind),
    );
    if (branch === undefined) return;
    worktree = { kind: "new", branch };
  } else {
    worktree = configuration.worktreeChoice;
  }

  // Optional: an empty prompt launches the agent with no task to start on.
  const prompt = await host.open<string>(
    ({ tui, theme: screenTheme, keybindings, close }) =>
      new SettingsListWrapper(
        createTextEditor({
          prefill: "",
          onDone: (text) => close(text),
          onCancel: () => close(),
          tui,
          theme: screenTheme,
          keybindings,
        }),
        {
          title: "Agent Prompt (optional)",
          theme: screenTheme,
          passthroughKeys: true,
        },
      ),
  );
  if (prompt === undefined) return;

  await launch(configuration, worktree, prompt);
}
