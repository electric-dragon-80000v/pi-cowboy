import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  CowboyAgentsSchema,
  type CowboyAgentParams,
} from "./agents/schemas/cowboy-agents.schema.js";
import { StopBatchSchema } from "./agents/schemas/stop-batch.schema.js";
import { CleanupBatchSchema } from "./agents/schemas/cleanup-batch.schema.js";
import { MergeBatchSchema } from "./agents/schemas/merge-batch.schema.js";
import { SteerBatchSchema } from "./agents/schemas/steer-batch.schema.js";
import { getAvailableTypes } from "./agents/agent-types.js";
import {
  executeAgentTool,
  executeStopAgentTool,
} from "./agents/tool-execution.js";
import { executeCleanupAgentTool } from "./agents/tool-cleanup.js";
import { executeMergeBranchTool } from "./agents/tool-merge.js";
import { executeSteerAgentTool } from "./agents/tool-steer.js";
import { type ToolResult } from "./agents/tool-result.js";
import type { StopItemOutcome } from "./agents/tool-execution.js";
import {
  isExtensionEnabled,
  syncExtensionIndicator,
} from "./extension-toggle.js";
import { getPiInstance, getStore } from "./shell.js";

/** The one place a tool name is spelled; the tools below are named from these. */
export const COWBOY_TOOLS = {
  agent: "cowboy_agent",
  stopAgent: "stop_cowboy_agent",
  mergeBranch: "merge_cowboy_branch",
  steerAgent: "steer_cowboy_agent",
  cleanupAgent: "cleanup_cowboy_agent",
} as const;

export const COWBOY_TOOL_NAMES: readonly string[] = Object.values(COWBOY_TOOLS);

// The /cowboy UI is imported lazily so none of it runs at boot.

// "prefer" falls back gracefully on providers without strict mode.
const CONSTRAINED_SAMPLING = {
  type: "json_schema",
  strict: "prefer",
} as const;

/**
 * Rebuild the per-item `agent_type` description so it lists the agent types
 * known at registration time. The shape — and therefore the derived type in
 * `cowboy-agents.schema.ts` — is unchanged; only the description text differs.
 */
function cowboyAgentsSchemaWithTypes(
  types: readonly string[],
): typeof CowboyAgentsSchema {
  const agentTypeDescription =
    types.length > 0
      ? `Optional agent type; when omitted the configured default agent type is used ("general-purpose" unless changed in settings). An unknown or ambiguous name is rejected before any agent in the batch spawns. Available: ${types.join(",")}`
      : `Optional agent type; when omitted the configured default agent type is used ("general-purpose" unless changed in settings). An unknown or ambiguous name is rejected before any agent in the batch spawns.`;

  const params = Type.Object(
    {
      prompt: CowboyAgentsSchema.properties.agents.items.properties.prompt,
      task_name:
        CowboyAgentsSchema.properties.agents.items.properties.task_name,
      agent_type: Type.Optional(
        Type.String({ description: agentTypeDescription }),
      ),
      model: CowboyAgentsSchema.properties.agents.items.properties.model,
    },
    { additionalProperties: false, required: ["prompt", "task_name"] },
  );

  return Type.Object(
    {
      agents: Type.Array(params, { minItems: 1 }),
      run_in_background: CowboyAgentsSchema.properties.run_in_background,
    },
    { additionalProperties: false, required: ["agents"] },
  );
}

/** Re-registers the agent tool once the session's agent types are known. */
export function registerAgentTool(pi: ExtensionAPI): void {
  const params = cowboyAgentsSchemaWithTypes(getAvailableTypes());

  const tool = {
    name: COWBOY_TOOLS.agent,
    label: COWBOY_TOOLS.agent,
    description:
      "Delegate one or more tasks to agents. Each agent gets an isolated worktree and a fresh pi process — pass a single-item `agents` array to delegate one task, or several to launch them in one call. Every item in `agents` requires its own short `task_name`; a name used twice in one call is rejected before anything spawns. Each agent is instructed to write its complete final response to a report file when it finishes — do not repeat reporting instructions in the `prompt`. Delegation is NON-BLOCKING by default: the call returns immediately with one agent id per item, and each result is delivered to you as a message when that agent settles — do not poll, do not re-delegate the task, do not duplicate the work. Pass `run_in_background: false` ONLY when `agents` has exactly one item AND you need that result inline in the same turn; a non-background call with multiple items is rejected before anything spawns. When an agent settles, the completion message names its `cow-` branch and says whether the worktree is kept and why. Merge the settled branch with merge_cowboy_branch when the work is good (or reject it), then call cleanup_cowboy_agent to remove it.",
    parameters: params,
    execute: executeAgentTool,
    constrainedSampling: CONSTRAINED_SAMPLING,
  };
  pi.registerTool(tool);
}

export type { CowboyAgentParams };

/**
 * Persists the switch and runs the half the new value calls for. The tools are
 * registered once at extension initialization, so the switch only moves their
 * names in and out of the active set.
 */
export function setExtensionEnabled(
  ui: ExtensionUIContext,
  enabled: boolean,
): void {
  getStore().mutate.agent.setExtensionEnabled(enabled);
  if (enabled) activateExtension(ui);
  else deactivateExtension(ui);
}

/**
 * Puts the Cowboy tools in the active set, re-registering the agent tool so its
 * `agent_type` list carries the types this session scanned, and shows the
 * presence marker in the top-right corner.
 */
export function activateExtension(ui: ExtensionUIContext): void {
  const pi = getPiInstance();
  registerAgentTool(pi);
  pi.setActiveTools([
    ...new Set([...pi.getActiveTools(), ...COWBOY_TOOL_NAMES]),
  ]);
  syncExtensionIndicator(ui);
}

/**
 * Takes the Cowboy tools out of the active set and clears the presence marker.
 * pi has no way to unregister a tool, so an inactive name is what keeps the
 * model from being offered one — and pi rejects a call to it.
 */
export function deactivateExtension(ui: ExtensionUIContext): void {
  const pi = getPiInstance();
  pi.setActiveTools(
    pi.getActiveTools().filter((name) => !COWBOY_TOOL_NAMES.includes(name)),
  );
  syncExtensionIndicator(ui);
}

/** The Cowboy tools — registered once at extension initialization. */
export function registerTools(pi: ExtensionAPI): void {
  registerAgentTool(pi);

  const stopAgentTool = {
    name: COWBOY_TOOLS.stopAgent,
    label: COWBOY_TOOLS.stopAgent,
    description:
      "Stop one or more active agents in one call: pass every id in `agent_ids`. Each id is handled independently in input order — stopped, reported as already settled, or reported unknown — and one id's outcome never blocks the rest. A repeated id in `agent_ids` is rejected before anything is stopped — pass each id once. Stopping interrupts the pi process (its pane is left in place) and settles the agent as stopped. Nothing is removed — the worktree and branch are preserved.",
    parameters: StopBatchSchema,
    execute: executeStopAgentTool,
    constrainedSampling: CONSTRAINED_SAMPLING,
    renderResult: (
      result: ToolResult<{ agents: StopItemOutcome[] }>,
      _options: { expanded?: boolean },
      theme: Theme,
      context: { isError?: boolean },
    ) => {
      const isError = context.isError ?? false;
      const content = result.content.at(0);
      const text = content?.type === "text" ? content.text : "";
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      return new Text(`${icon} ${text}`, 0, 0);
    },
  };
  // @ts-expect-error — matching pi's exact generic would force an import this repo avoids.
  pi.registerTool(stopAgentTool);

  const mergeBranchTool = {
    name: COWBOY_TOOLS.mergeBranch,
    label: COWBOY_TOOLS.mergeBranch,
    description:
      "Merge one or more settled agent branches in one call: pass every branch in `branches` (the `cow-<task>-<id>` branches from the cowboy_agent result notes). `target` and `repo` apply to the whole call. A repeated branch in `branches` is rejected before anything merges — pass each branch once. The repo's main checkout must be on the target branch and clean: the merge refuses when it is not on the target (a merge anywhere else would land on the wrong branch) and refuses when the checkout is dirty. Already-merged branches are reported without running a merge (the checkout is left untouched), and conflicts are never auto-resolved. Branches merge sequentially in input order; a conflict halts the batch — the conflicted merge is left in progress with the file list so you can resolve it, and the remaining branches are reported as not attempted.",
    parameters: MergeBatchSchema,
    execute: executeMergeBranchTool,
    constrainedSampling: CONSTRAINED_SAMPLING,
  };
  pi.registerTool(mergeBranchTool);

  const steerAgentTool = {
    name: COWBOY_TOOLS.steerAgent,
    label: COWBOY_TOOLS.steerAgent,
    description:
      "Send one message to one or more agents in one call: pass every id in `agent_ids` and the single `message` delivered to each. Each id is handled independently in input order — delivered, or refused with its reason — and one id's refusal never blocks the rest. A repeated id in `agent_ids` is rejected before anything is delivered — pass each id once. A spawned agent receives the message before its next model call; a SETTLED one is REVIVED — spawned again, given the message, and it sends you another completion message when it settles again. That second result arrives only as that completion message: the spawn's result promise closed with the first turn and never opens again. Delivery is fire-and-forget: nothing here waits for an agent to act on it, so do not poll for a reply. The message is entered into the agent's pi session, so it can also be a bash command: `!command` runs the command and sends its output to the agent's context; `!!command` runs it without adding the output to the agent's context. A QUEUED agent cannot be steered — it has no pane yet; wait for a concurrency slot first. An agent whose pane is gone (cleaned up) cannot be steered either, and neither can an agent being TORN DOWN — wait for its report. Every refusal states its reason and what to do about it.",
    parameters: SteerBatchSchema,
    execute: executeSteerAgentTool,
    constrainedSampling: CONSTRAINED_SAMPLING,
  };
  pi.registerTool(steerAgentTool);

  const cleanupAgentTool = {
    name: COWBOY_TOOLS.cleanupAgent,
    label: COWBOY_TOOLS.cleanupAgent,
    description:
      "Remove one or more SETTLED agents' artifacts in one call: pass every id in `agent_ids`. Each id is handled independently in input order — located, cleaned up, and reported with its own agent status / pane / worktree / branch block — and one id's outcome never blocks the rest. A repeated id in `agent_ids` is rejected before anything is removed — pass each id once. Removes the herdr pane/tab, the worktree, and the cow- branch when it is merged into the parent HEAD. Gated on a reported result — an agent that is still active is REFUSED for its item only: nothing is stopped, removed, or released, and the report says why (stop it with stop_cowboy_agent, then clean up once it has settled). Best effort — each item's result is a structured report of what was done. A worktree with uncommitted changes, or whose state cannot be verified, is KEPT with the reason rather than destroyed (clean it, then retry). An unmerged branch does NOT block removal — the branch and its commits live in the repo, so the worktree is removed and the branch is kept for you to merge later. A torn-down run also loses its staging directory (<tmpdir>/pi-cowboy/<id>/) — those files may carry secrets, so they go with the run; a cleanup that keeps the worktree, and a refusal, removes nothing. An agent whose spawning session was replaced (/new, /resume, /fork) is still tracked, so pass the original full agent id from its spawn or completion result — and an id whose record did not survive a /reload is not rejected outright either: the artifacts themselves are located (herdr's worktree/pane registries, then the worktree root on disk by id) and cleaned up when the run is established as over. That recovered report marks the agent status `unrecorded` and states the evidence its verdict rests on: it refuses, keeping everything, while herdr still reports the pane `working` or when the pane cannot be read at all, and it refuses when two artifacts answer to the id (listing them). The recovered path is the one exception to the staging-directory removal: it has no record of the run, so it reports the agent's deliverable (<tmpdir>/pi-cowboy/<id>/result.md) instead of deleting it, and nothing the agent wrote is lost silently.",
    parameters: CleanupBatchSchema,
    execute: executeCleanupAgentTool,
    constrainedSampling: CONSTRAINED_SAMPLING,
  };
  pi.registerTool(cleanupAgentTool);

  pi.registerMessageRenderer("subagent-result", (message, _options, theme) => {
    const content =
      typeof message === "object" &&
      typeof (message as { content?: unknown }).content === "string"
        ? (message as { content: string }).content
        : "";
    const isError = /\b(error|stopped)\b/.test(content.slice(0, 200));
    const icon = theme.fg(isError ? "error" : "success", isError ? "✗" : "✓");
    return new Text(`${icon} ${content}`, 0, 0);
  });
}

/**
 * The model keys a spawn can be given: the session's scoped models when any are
 * scoped, otherwise every model the registry offers.
 */
function subagentModelOptions(ctx: ExtensionCommandContext): string[] {
  // Empty array means no scoping. Cast through unknown: the field is
  // absent from older ExtensionCommandContext typings.
  const scoped = (
    ctx as unknown as {
      scopedModels?: ReadonlyArray<{
        model: { provider: string; id: string };
      }>;
    }
  ).scopedModels;
  return scoped?.length
    ? scoped.map((s) => `${s.model.provider}/${s.model.id}`)
    : ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
}

/** The one place the command name is spelled. */
const COWBOY_COMMAND = "cowboy";

/**
 * The `/cowboy` command in its unavailable mode: a prerequisite the entry point
 * could not meet means every invocation reports the reason instead of opening a
 * menu. Registered so the human reads the reason on the command they would have
 * used.
 */
export function registerUnavailableCowboyCommand(
  pi: ExtensionAPI,
  reason: string,
): void {
  pi.registerCommand(COWBOY_COMMAND, {
    description: reason,
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(reason, "warning");
    },
  });
}

/** The /cowboy command — the human surface that turns the extension back on. */
export function registerCowboyCommand(pi: ExtensionAPI): void {
  // Named cowboy so it never clashes with other subagent extensions' /agents.
  pi.registerCommand(COWBOY_COMMAND, {
    description:
      "Manage agents: status, spawn, settings. `status` lists spawned, queued and settled agents; `spawn` opens the spawn wizard; `worktree` creates one git worktree with no agent attached to it. `enable`/`disable` load or unload the cowboy tools. Pass `model` (optionally a provider/model-id) to set the model agents use for this session — opens pi's model picker.",
    getArgumentCompletions: async (prefix: string) =>
      (await import("./ui/menu/model-picker.js")).cowboyCompletions(prefix),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const subcommand = args.trim();
      // The first word names the subcommand and the rest is its inline argument,
      // so a tab or a run of spaces separates them exactly as one space does.
      const [word, ...inline] = subcommand.split(/\s+/);
      if (subcommand === "enable" || subcommand === "disable") {
        const enable = subcommand === "enable";
        if (isExtensionEnabled() === enable) {
          ctx.ui.notify(
            `pi-cowboy is already ${enable ? "enabled" : "disabled"}`,
            "info",
          );
          return;
        }
        setExtensionEnabled(ctx.ui, enable);
        ctx.ui.notify(
          enable ? "pi-cowboy enabled" : "pi-cowboy disabled",
          "info",
        );
        return;
      }
      if (word === "worktree") {
        // Off, the switch is the whole menu — but a worktree is a git artifact
        // that needs none of the cowboy tools, so this one still runs.
        const { showWorktreeCommandMenu } =
          await import("./ui/menu/menu-worktree-command.js");
        await showWorktreeCommandMenu(ctx, inline.join(" "));
        return;
      }
      // Off, the switch is the whole menu: the rows these three open are
      // unreachable, so the subcommands that open them are refused the same way.
      const opensAHiddenRow =
        word === "model" || subcommand === "spawn" || subcommand === "status";
      if (opensAHiddenRow && !isExtensionEnabled()) {
        ctx.ui.notify(
          "pi-cowboy is disabled. Run /cowboy enable first.",
          "warning",
        );
        return;
      }
      if (word === "model") {
        const { handleModelArg } = await import("./ui/menu/model-picker.js");
        await handleModelArg(inline.join(" "), ctx);
        return;
      }
      if (subcommand === "spawn" || subcommand === "status") {
        const { showAgentsActionMenu } = await import("./ui/menu/menus.js");
        await showAgentsActionMenu(ctx, subcommand, subagentModelOptions(ctx));
        return;
      }
      if (subcommand !== "") {
        ctx.ui.notify(
          `Unknown option "${word}". Usage: /cowboy [status | spawn | worktree [<name>] | model [<provider/model-id>|clear] | enable | disable]`,
          "warning",
        );
        return;
      }
      const { showAgentsMainMenu } = await import("./ui/menu/menus.js");
      await showAgentsMainMenu(ctx, subagentModelOptions(ctx));
    },
  });
}
