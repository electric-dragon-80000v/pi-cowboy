import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  CowboyAgentsSchema,
  type CowboyAgentParams,
} from "./agents/schemas/cowboy-agents.schema.js";
import { getAvailableTypes } from "./agents/agent-types.js";
import { executeAgentTool, stopAgentTool } from "./agents/tool-execution.js";
import { cleanupAgentTool } from "./agents/tool-cleanup.js";
import { mergeBranchTool } from "./agents/tool-merge.js";
import { steerAgentTool } from "./agents/tool-steer.js";
import { handoverAgentTool } from "./agents/tool-handover.js";
import { withCowboyRenderer } from "./agents/tool-renderer.js";
import {
  COWBOY_TOOL_NAMES,
  COWBOY_TOOLS,
  CONSTRAINED_SAMPLING,
} from "./cowboy-tools.js";
import {
  isExtensionEnabled,
  syncExtensionIndicator,
} from "./extension-toggle.js";
import {
  beginUiFlow,
  getHarnessAvailability,
  getHarnessRegistry,
  getPiInstance,
  getRuntime,
  getStore,
  piModelCatalog,
} from "./shell.js";
import { NO_HOST_REASON } from "./host-multiplexer.js";
import type { HarnessModelOptions } from "./agents/harness/harness-registry.js";

export { COWBOY_TOOLS, COWBOY_TOOL_NAMES };

/** Tools this package entrypoint registers and may activate. */
export const REGISTERED_TOOL_NAMES: readonly string[] = COWBOY_TOOL_NAMES;

// The /cowboy UI is imported lazily so none of it runs at boot.

/**
 * Rebuild the per-item `agent_type` description so it lists the agent types
 * known at registration time — a session with the built-in types disabled and
 * no templates of its own has none to list. The shape mirrors
 * `cowboy-agents.schema.ts`, nullable union included, so the derived type holds.
 */
function cowboyAgentsSchemaWithTypes(
  types: readonly string[],
): typeof CowboyAgentsSchema {
  const params = Type.Object(
    {
      prompt: CowboyAgentsSchema.properties.agents.items.properties.prompt,
      task_name:
        CowboyAgentsSchema.properties.agents.items.properties.task_name,
      agent_type: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: `Optional agent type. Omit it, or pass null, to use the configured default agent type — never pass a type the user did not ask for. An unknown or ambiguous name is rejected before any agent in the batch spawns.${types.length > 0 ? ` Available: ${types.join(",")}` : ""}`,
        }),
      ),
      model: CowboyAgentsSchema.properties.agents.items.properties.model,
      harness_type:
        CowboyAgentsSchema.properties.agents.items.properties.harness_type,
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
  pi.registerTool(withCowboyRenderer(tool));
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
    ...new Set([...pi.getActiveTools(), ...REGISTERED_TOOL_NAMES]),
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

  pi.registerTool(withCowboyRenderer(stopAgentTool));
  pi.registerTool(withCowboyRenderer(mergeBranchTool));
  pi.registerTool(withCowboyRenderer(steerAgentTool));
  pi.registerTool(withCowboyRenderer(handoverAgentTool));
  pi.registerTool(withCowboyRenderer(cleanupAgentTool));

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
 * The models a spawn can be given, one list per harness this machine can run,
 * read once when the menu tree opens. Every picker under the menu selects the
 * list of the harness it configures, so no picker can offer another's models.
 */
async function harnessModelOptions(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<HarnessModelOptions> {
  const listing = await getHarnessRegistry().listModelOptions(
    { pi, modelCatalog: piModelCatalog(ctx.modelRegistry) },
    getHarnessAvailability(),
  );
  for (const notice of listing.notices) ctx.ui.notify(notice, "warning");
  return listing.options;
}

/** The one place the command name is spelled. */
const COWBOY_COMMAND = "cowboy";

/** The shorthand words `/cowboy` accepts for its subcommands. */
const COWBOY_SHORTHANDS: Readonly<Record<string, string>> = {
  wt: "worktree",
  sp: "spawn",
  st: "status",
};

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
      "Manage agents: status, spawn, settings. `status` lists spawned, queued and settled agents; `spawn` opens the spawn wizard; `worktree` creates one git worktree with no agent attached to it. `status`, `spawn` and `worktree` also answer to `st`, `sp` and `wt`. `enable`/`disable` load or unload the cowboy tools. Pass `model` (optionally a provider/model-id) to set the model agents use for this session — opens pi's model picker.",
    getArgumentCompletions: async (prefix: string) =>
      (await import("./ui/menu/model-picker.js")).cowboyCompletions(prefix),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      // This invocation owns the ui from here on: a flow it leaves pending (a
      // probe still running when the user opens another screen) must not mount
      // over the screen that newer command opened.
      beginUiFlow(ctx);
      // The first word names the subcommand and the rest is its inline argument,
      // so a tab or a run of spaces separates them exactly as one space does.
      const [rawWord, ...inline] = args.trim().split(/\s+/);
      // A shorthand resolves to the subcommand it abbreviates, so everything
      // below reads one name per subcommand.
      const word = COWBOY_SHORTHANDS[rawWord] ?? rawWord;
      const subcommand = [word, ...inline].join(" ");
      if (subcommand === "enable" || subcommand === "disable") {
        const enable = subcommand === "enable";
        // Enabling is what puts the tools in the active set; with no multiplexer
        // hosting the session there is no pane for them to work in.
        if (enable && getRuntime() === null) {
          ctx.ui.notify(NO_HOST_REASON, "warning");
          return;
        }
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
      // Every row below launches or inspects work in the session's panes, so a
      // session nothing hosts (see session-runtime.ts) has nothing to offer.
      if (getRuntime() === null) {
        ctx.ui.notify(NO_HOST_REASON, "warning");
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
        await showAgentsActionMenu(
          ctx,
          subcommand,
          await harnessModelOptions(pi, ctx),
        );
        return;
      }
      if (subcommand !== "") {
        ctx.ui.notify(
          `Unknown option "${rawWord}". Usage: /cowboy [status | spawn | worktree [<name>] | model [<provider/model-id>|clear] | enable | disable]`,
          "warning",
        );
        return;
      }
      const { showAgentsMainMenu } = await import("./ui/menu/menus.js");
      await showAgentsMainMenu(ctx, await harnessModelOptions(pi, ctx));
    },
  });
}
