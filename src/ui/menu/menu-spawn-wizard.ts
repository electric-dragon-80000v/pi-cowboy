/**
 * Spawn agent wizard: options → worktree name (when new) → prompt → spawn.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentWorktree } from "../../types.js";
import type { HarnessModelOptions } from "../../agents/harness/harness-registry.js";
import {
  resolveDefaultOrchestrator,
  resolveWorktreeCheckoutType,
} from "../../agents/spawn-defaults.js";
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
import { actionReport } from "./helpers.js";
import { ScreenHost } from "./screen-host.js";
import { choiceInvocation } from "./spawn-choice.js";
import { showWorktreeNameStep } from "./menu-spawn-worktree.js";
import { createTextEditor } from "./submenus/text-editor.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import {
  askSpawnConfiguration,
  type SpawnConfiguration,
} from "./menu-spawn-options.js";

/** The run's worktree, resolved once the name field has answered for a `new` choice. */
type WorktreeTarget =
  | { kind: "inherit" }
  | { kind: "picked"; path: string; branch: string }
  | { kind: "new"; branch: string };

/** How much of the prompt a derived description keeps. */
const DERIVED_DESCRIPTION_MAX_LENGTH = 50;

/** Multi-step spawn wizard: options → worktree name (when new) → prompt → spawn. */
export async function showSpawnAgentMenu(
  ctx: ExtensionCommandContext,
  harnessModelOptions: HarnessModelOptions,
): Promise<void> {
  const session = getSessionCtx();
  const store = getStore();
  const parentCwd = session.cwd;

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
        requestedHarness: configuration.harness,
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

  const configuration = await askSpawnConfiguration(ctx, harnessModelOptions);
  if (configuration === undefined) return;

  const host = new ScreenHost(ctx);
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
