/**
 * protocol.ts — the delegation dialogue layer: intent parsing, the turn
 * (sandbox → spawn), and the spawned/queued/settled cues.
 *
 * Nothing happens before validation: `parse` resolves agent type,
 * orchestrator, and model (credential probe included) and can throw BEFORE
 * the turn provisions a sandbox — an unusable model never leaves a checkout
 * behind, and a duplicate task name is rejected with the existing attempt
 * left spawned. Every turn returns a dual payload — prose `message` plus
 * structured `details` — produced together, so one never ships without the
 * other. Shell getters are read at call time, never cached.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type {
  AgentLifecycleState,
  AgentPhase,
  AgentSpawn,
  ModelSelection,
} from "../types.js";
import {
  ACTIVE_AGENT_PHASES,
  hasOutcome,
  isActivePhase,
  lifecycleStartTime,
  lifecycleStatus,
} from "../types.js";
import type {
  CowboyAgentParams,
  CowboyAgents,
} from "../agents/schemas/cowboy-agents.schema.js";
import { BATCH_ITEM_SEPARATOR } from "../agents/batch.js";
import { getStatusNote } from "../status-note.js";
import {
  buildTaskSlug,
  buildWorktreeBranch,
  buildWorktreePath,
  resolveWorktreeRoot,
} from "../spawn/worktree-policy.js";
import {
  formatRetentionClause,
  resolveMainCheckout,
} from "../infrastructure/git-client.js";
import {
  getAgentConfig,
  resolveTypeOrDiscover,
} from "../agents/agent-types.js";
import {
  resolveAgentTypeParam,
  resolveDefaultOrchestrator,
} from "../agents/spawn-defaults.js";
import {
  readModelRequest,
  resolveModelRequest,
} from "../models/model-request.js";
import {
  getCoordinator,
  getManager,
  getPiInstance,
  getSessionCtx,
  getStore,
} from "../shell.js";
import { assertNever, parseThinkingLevel } from "../utils.js";
import type { OrchestratorConfig } from "./types.js";
import {
  queuedCueContext,
  settledCueContext,
  spawnCueContext,
  type SettledOutcome,
} from "./context.js";
import { renderCue } from "./cues.js";

// --- Intent ---

/** A validated delegation turn, fully resolved by `parse` before any side effect. The raw tool params are not retained, so a later args mutation cannot change the turn. */
interface DelegationIntent {
  ctx: ExtensionContext;
  /** Original tool_use id, stamped on the spawn for the call renderer. */
  toolCallId: string;
  /** Validated short task slug: dedup and branch identity. */
  taskSlug: string;
  prompt: string;
  description: string;
  /** Raw agent type (explicit param or configured default). */
  agentType: string;
  /** The registered type `agentType` resolves to; an unknown name never reaches a run. */
  resolvedType: string;
  orchestrator: OrchestratorConfig;
  /** Fork the parent session into the child; false means a fresh session. */
  fork: boolean;
  /** Absent means inherit the parent. */
  modelSelection?: ModelSelection;
  isBackground: boolean;
  /** Raw `thinking` override, possibly injected by the tool_call listener. */
  thinkingOverride: string | undefined;
}

/** A completed turn: prose `message` the orchestrating LLM reads plus structured `details`. */
interface DelegationResult {
  /** Spawned/queued acknowledgement for the orchestrating LLM. */
  message: string;
  /** Structured payload for JSON consumers. */
  details: Record<string, unknown>;
}

// --- Formatters ---

/** Manager surface the active-agent formatter reads. */
interface ToolManagerSurface {
  /** Retained spawns in the given phases (default: every phase). */
  listAgents(phases?: readonly AgentPhase[]): AgentSpawn[];
  getSpawn(id: string): AgentSpawn | undefined;
}

/** Compact one-line list of active agents: "id (type), id (type)". */
export function formatActiveAgents(
  manager: ToolManagerSurface = getManager(),
): string {
  const agents = manager
    .listAgents(ACTIVE_AGENT_PHASES)
    .filter((a) => isActivePhase(a.lifecycle.phase));

  if (agents.length === 0) return "none";

  return agents.map((a) => `${a.id} (${a.display.type})`).join(", ");
}

/** Details payload for one spawn: always type and description; includeStatus adds status and herdr location, includeRunInfo adds the model/thinking and elapsed time. A stop initiator is not a details field — the result note carries it. */
export function buildAgentDetails(
  spawn: AgentSpawn,
  opts?: { includeRunInfo?: boolean; includeStatus?: boolean },
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    type: spawn.display.type,
    description: spawn.display.description,
  };

  if (spawn.display.taskSlug) {
    details.taskSlug = spawn.display.taskSlug;
  }

  if (spawn.display.worktree) {
    details.worktreePath = spawn.display.worktree.path;
    details.worktreeBranch = spawn.display.worktree.branch;
  }
  if (spawn.display.worktree?.kind === "owned") {
    details.worktreeManaged = true;
  }
  const host = spawn.execution.host;
  if (host) {
    details.herdrAgent = host.name;
    details.herdrPane = host.paneId;
    details.herdrTab = host.tabId;
  }

  if (opts?.includeStatus) {
    details.status = lifecycleStatus(spawn.lifecycle);
  }

  if (opts?.includeRunInfo) {
    const elapsedMs = hasOutcome(spawn.lifecycle)
      ? spawn.lifecycle.completedAt - lifecycleStartTime(spawn.lifecycle)
      : 0;

    details.durationMs = elapsedMs;
    details.modelName = spawn.display.invocation?.modelName;
    details.modelId = spawn.display.invocation?.modelName;
    details.thinkingLevel = spawn.display.invocation?.thinkingLevel;
  }

  return details;
}

/** One cue outcome per lifecycle: completed carries its result, error its message, and a run that has not ended reads as a stop. */
function settledOutcome(lifecycle: AgentLifecycleState): SettledOutcome {
  // A cue rendered before the run ended has no result or error to render; the stop arm is the outcome shape that carries neither.
  if (!hasOutcome(lifecycle)) return { kind: "stopped" };
  switch (lifecycle.status) {
    case "completed":
      return { kind: "completed", result: lifecycle.result };
    case "error":
      return { kind: "failed", error: lifecycle.error };
    case "stopped":
      return { kind: "stopped" };
    default:
      return assertNever(lifecycle);
  }
}

/**
 * The settled report's headline: which agent, and how it ended. The settled cue
 * is the run's own report and names no id, so both deliveries — the blocking
 * call's return and the completion nudge — headline it the same way, and the
 * caller always leaves with the id it must still stop, merge and clean up.
 */
export function settledHeadline(spawn: AgentSpawn): string {
  return `[Cowboy agent "${spawn.display.type}" ${spawn.id} ${lifecycleStatus(spawn.lifecycle)}]`;
}

/** Result text plus status note, for display. Errors pass through verbatim. Worktree settles append a lifecycle note stating what remains and directing the orchestrator to call cleanup_cowboy_agent — removal is never implied to happen on its own. */
export function formatResultContent(spawn: AgentSpawn): string {
  const lifecycle = spawn.lifecycle;
  // A retention reason exists only on an ended run: it records a tree kept at settlement or by cleanup.
  const retention = hasOutcome(lifecycle)
    ? lifecycle.worktreeRetentionReason
    : undefined;
  const config = spawn.display.orchestration;
  const worktree =
    spawn.display.worktree?.kind === "owned"
      ? spawn.display.worktree
      : undefined;
  return renderCue(
    config.cues,
    "settled",
    settledCueContext({
      outcome: settledOutcome(lifecycle),
      statusNote: getStatusNote(lifecycle) || undefined,
      worktree: worktree
        ? {
            path: worktree.path,
            branch: worktree.branch,
            retention: retention ? formatRetentionClause(retention) : undefined,
            // Only a reported run leaves its process alive; a launch failure
            // never started one, and a stopped settle is interrupt-only.
            processAlive:
              lifecycle.phase === "settled" && lifecycle.status === "completed",
          }
        : undefined,
    }),
  );
}

// --- Protocol ---

/**
 * Per-item input the batch runner feeds to `DelegationProtocol.parse`.
 * `run_in_background` lives at the call level; the batch wrapper threads it
 * through here so a single-item call and a batch item go through the same
 * parse path.
 *
 * The `thinking` and `_configuredModel` fields are injected by the
 * `tool_call` listener — never authored by the LLM — so the JSON schema does
 * not name them.
 */
type PerItemParams = CowboyAgentParams & {
  run_in_background?: boolean;
  thinking?: string;
  _configuredModel?: string;
};

/** One delegation turn, bound to its validated intent. */
export class DelegationProtocol {
  /** The validated intent — fixed at parse time. */
  readonly intent: Readonly<DelegationIntent>;

  private constructor(intent: DelegationIntent) {
    this.intent = intent;
  }

  /** Validate a single spawn's params into its delegation intent. Throws for an unusable task name, agent type or model before anything is provisioned. */
  static async parse(
    params: PerItemParams,
    ctx: ExtensionContext,
    toolCallId: string,
  ): Promise<DelegationProtocol> {
    const agentType = resolveAgentTypeParam(params.agent_type);
    const prompt = params.prompt;

    // The orchestrator MUST name the task — the branch reads as the task, not the agent type. No derivation fallback.
    const taskName =
      typeof params.task_name === "string" ? params.task_name.trim() : "";
    if (!taskName) {
      throw new Error(
        `cowboy_agent requires a short 2-3 word task name (e.g. "fix login flow") via the \`task_name\` parameter — it names the agent's branch/tab/worktree/agent so you can recognize it at a glance.`,
      );
    }
    const taskSlug = buildTaskSlug(taskName);

    // A configured template name that no longer resolves degrades to `default` instead of failing the spawn.
    const orchestrator = resolveDefaultOrchestrator();

    // An unrunnable caller-supplied model fails here, before touching the in-flight attempt or leaving a checkout behind. Provenance is explicit (ModelRequest), never inferred from the args object.
    const requested = resolveModelRequest(
      readModelRequest(params as unknown as Record<string, unknown>),
      ctx.modelRegistry,
      ctx.model,
    );

    // Also scan the spawned worktree's .pi/agents/ — it can define a type the parent checkout lacks — unless the target is untrusted. The checkout is not provisioned yet, so only the parent project's directory is scanned here. The type resolves here rather than in `run`, so an unknown name fails the whole batch before any item spawns.
    const resolution = await resolveTypeOrDiscover(
      agentType,
      undefined,
      (message, kind) => {
        ctx.ui.notify(message, kind);
      },
    );
    if (resolution.kind === "ambiguous") {
      throw new Error(
        `Ambiguous agent type: ${agentType}. Candidates: ${resolution.candidates.join(", ")}. Use the exact registered name — nothing was spawned.`,
      );
    }
    if (resolution.kind === "not-found") {
      throw new Error(
        `Unknown agent type: ${agentType} — nothing was spawned. Use an exact registered name, or omit \`agent_type\` to use the configured default.`,
      );
    }

    // Background is the default — delegation never blocks the orchestrator's turn. Only an explicit run_in_background: false opts into foreground.
    const isBackground = params.run_in_background !== false;

    return new DelegationProtocol({
      ctx,
      toolCallId,
      taskSlug,
      prompt,
      description: prompt.split("\n")[0].slice(0, 80) || prompt.slice(0, 80),
      agentType,
      resolvedType: resolution.key,
      orchestrator,
      fork: getAgentConfig(agentType)?.fork ?? false,
      modelSelection:
        requested.kind === "resolved"
          ? { model: requested.model, key: requested.modelKey }
          : undefined,
      isBackground,
      thinkingOverride: params.thinking,
    });
  }

  /** Run the turn: compute the worktree the launch will provision, spawn through the coordinator, then project the spawn into the spawned or queued cue. Nothing is provisioned here — a queued run gets its worktree and pane only when it is granted a slot. */
  async run(signal: AbortSignal | undefined): Promise<DelegationResult> {
    const { ctx, isBackground, taskSlug, resolvedType } = this.intent;
    const pi = getPiInstance();

    // One id per spawn names the worktree branch AND the herdr agent. Minted through the manager, so it is unique against every retained spawn.
    const spawnId = getManager().mintSpawnId();
    // The checkout the launch will create, named by the same policy the sandbox uses, so the cue can name the branch the orchestrator merges without the worktree existing yet.
    const worktree = await this.expectedWorktree(pi, spawnId);

    const thinkingLevel =
      parseThinkingLevel(this.intent.thinkingOverride) ??
      getAgentConfig(resolvedType)?.thinkingLevel ??
      getStore().agent.defaultThinking;

    const modelName = this.intent.modelSelection?.model.id;

    const { agentId, spawn } = await getCoordinator().spawn(ctx, {
      spawnId,
      type: resolvedType,
      prompt: this.intent.prompt,
      description: this.intent.description,
      taskSlug,
      orchestration: this.intent.orchestrator,
      modelSelection: this.intent.modelSelection,
      thinkingLevel,
      fork: this.intent.fork,
      // Coordinates only: the launch provisions the checkout once the run holds a slot.
      worktree,
      invocation: {
        modelName,
        thinkingLevel,
        fork: this.intent.fork,
      },
      runInBackground: isBackground,
      signal: isBackground ? undefined : signal,
    });

    if (this.intent.toolCallId) {
      spawn.display.toolCallId = this.intent.toolCallId;
    }

    if (!isBackground) {
      const details = buildAgentDetails(spawn, { includeRunInfo: true });
      // Foreground results share the `{ agents: [...] }` shape with the batch
      // path so callers can read a single access pattern.
      details.agentId = agentId;
      if (hasOutcome(spawn.lifecycle) && spawn.lifecycle.status === "error") {
        throw new Error(
          `agent ${agentId} stopped with an error: ${spawn.lifecycle.error || "no error message was recorded"}`,
        );
      }
      return {
        message: `${settledHeadline(spawn)}\n\n${formatResultContent(spawn)}`,
        details,
      };
    }

    // The spawn-time cue is gated on the worktree the launch will provision, never on a spawn field: its branch names exactly the ref the orchestrator merges.
    const cueWorktree = worktree;
    if (spawn.lifecycle.phase === "queued") {
      const spawnedCount = getManager()
        .listAgents(ACTIVE_AGENT_PHASES)
        .filter((a) => a.lifecycle.phase === "spawned").length;
      const body = renderCue(
        this.intent.orchestrator.cues,
        "queued",
        queuedCueContext({
          agentId,
          worktree: cueWorktree,
          queueRunning: spawnedCount,
        }),
      );
      const details = buildAgentDetails(spawn);
      details.agentId = agentId;
      details.status = "queued";
      return { message: `[Agent queued] ${body}`, details };
    }
    const body = renderCue(
      this.intent.orchestrator.cues,
      "spawned",
      spawnCueContext({ agentId, worktree: cueWorktree }),
    );
    const details = buildAgentDetails(spawn);
    details.agentId = agentId;
    details.status = "spawned";
    return { message: `[Agent spawned] ${body}`, details };
  }

  /**
   * The worktree the launch will create for `spawnId`, or undefined outside a
   * repository. Pure naming: it applies the sandbox's own root resolution and
   * branch policy so the cue names the exact path the checkout will land on,
   * but creates nothing.
   */
  private async expectedWorktree(
    pi: ExtensionAPI,
    spawnId: string,
  ): Promise<{ kind: "owned"; path: string; branch: string } | undefined> {
    const repoRoot = await resolveMainCheckout(pi, getSessionCtx().cwd).catch(
      () => undefined,
    );
    if (repoRoot === undefined) return undefined;
    const root = resolveWorktreeRoot(getStore().agent.worktreeRoot, repoRoot);
    return {
      kind: "owned",
      path: buildWorktreePath(root, this.intent.taskSlug, spawnId),
      branch: buildWorktreeBranch(this.intent.taskSlug, spawnId),
    };
  }
}

/**
 * Run a batch delegation: one validated call shape, one or more spawns.
 *
 * The single-item blocking guard lives here, not in the schema: a
 * non-background call must have exactly one item, and the check fires before
 * any item parses or any side effect runs. Every item parses — task name,
 * model and agent type — before any item runs, so a bad item fails the whole
 * call with no worktree, pane or spawn behind it. Two items sharing a task
 * name are refused for the same reason.
 *
 * Spawns run in parallel; the coordinator's registry caps concurrency and
 * queues overflow, so a 10-item batch against a 4-slot cap still fans out
 * cleanly without any new queuing in this layer.
 */
export async function runDelegationBatch(
  callParams: CowboyAgents,
  ctx: ExtensionContext,
  toolCallId: string,
  signal: AbortSignal | undefined,
): Promise<DelegationResult> {
  if (callParams.agents.length > 1 && callParams.run_in_background === false) {
    throw new Error("run_in_background: false requires exactly one agent");
  }

  // The call-level blocking flag threads into every per-item parse so the
  // single-item and batch paths share one validation rule.
  const itemInputs: PerItemParams[] = callParams.agents.map((item) => ({
    ...item,
    run_in_background: callParams.run_in_background,
  }));

  // Every item parses before any item runs, so one bad item fails the whole
  // call while nothing is provisioned.
  const protocols = await Promise.all(
    itemInputs.map((item) => DelegationProtocol.parse(item, ctx, toolCallId)),
  );
  rejectRepeatedTaskSlugs(protocols);

  const results = await Promise.all(protocols.map((p) => p.run(signal)));

  // Single-item foreground still nests its details under `agents[0]` so
  // every cowboy_agent return shape is `{ message, details: { agents: [...] } }`
  // — callers should never branch on the spawn count.
  const message = results.map((r) => r.message).join(BATCH_ITEM_SEPARATOR);
  const details = {
    agents: results.map((r) => r.details),
  };
  return { message, details };
}

/** A task name used twice in one call can never succeed: the first item is in flight by the time the second is admitted, so the registry refuses it and the call fails with the first agent's id lost. Refuse the repeat here instead, while nothing has spawned. */
function rejectRepeatedTaskSlugs(
  protocols: readonly DelegationProtocol[],
): void {
  const slugs = protocols.map((protocol) => protocol.intent.taskSlug);
  const repeated = slugs.filter((slug, index) => slugs.indexOf(slug) !== index);
  if (repeated.length === 0) return;
  throw new Error(
    `cowboy_agent received the same task_name more than once: ${[...new Set(repeated)].join(", ")} — nothing was spawned. Give every item in \`agents\` its own task_name.`,
  );
}
