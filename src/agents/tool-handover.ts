/**
 * tool-handover.ts — handover_cowboy_agent tool implementation.
 *
 * The handler resolves the request before it touches anything (target
 * harness, then model), hands the agent to its session through the manager,
 * and reports the outcome. A fault is data: the tool answers with one line
 * naming what happened, and that line is the only channel — a second,
 * identical notification would say nothing the result does not.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isAvailable, selectable } from "../availability.js";
import { COWBOY_TOOLS, CONSTRAINED_SAMPLING } from "../cowboy-tools.js";
import {
  modelChoiceFor,
  readModelRequest,
  readThinkingRequest,
  resolveSpawnModel,
} from "../models/model-request.js";
import {
  getHarnessAvailability,
  getHarnessRegistry,
  getManager,
  getPiInstance,
  piModelCatalog,
} from "../shell.js";
import type { ModelChoice } from "../types.js";
import { errorMessage } from "../utils.js";
import {
  modelListEntries,
  modelListNotice,
  type AnyHarnessId,
} from "./harness.js";
import {
  handoverSeverity,
  type HandoverFault,
  type HandoverOutcome,
} from "./handover.js";
import {
  HandoverAgentSchema,
  type HandoverAgentParams,
} from "./schemas/handover.schema.js";
import { resultWithSeverity, type ToolResult } from "./tool-result.js";

/** The request once it is known to be askable: a target harness and, if named, a model for it. */
type HandoverIntent =
  | {
      readonly kind: "ready";
      readonly harness: AnyHarnessId;
      readonly modelChoice?: ModelChoice;
    }
  | { readonly kind: "faulted"; readonly fault: HandoverFault };

/**
 * The target harness, held to a handover's own rule: required, registered
 * here, and launchable on this machine — never a fallback. A spawn's refusal
 * text offers the template and configured default, which a handover does not
 * have, so its messages are its own.
 */
function resolveTargetHarness(raw: string): HandoverIntent {
  const value = raw.trim();
  if (value === "") {
    return {
      kind: "faulted",
      fault: {
        kind: "request-refused",
        detail:
          "`harness_type` is required — name the harness that runs the next run. Nothing was changed.",
      },
    };
  }
  const harnesses = getHarnessRegistry();
  if (harnesses.get(value) === undefined) {
    return {
      kind: "faulted",
      fault: {
        kind: "request-refused",
        detail: `Unknown harness_type "${value}": this session registered ${harnesses.ids().join(", ")}. Nothing was changed — name a registered harness that runs the next run.`,
      },
    };
  }
  const availability = getHarnessAvailability();
  if (!isAvailable(value, availability)) {
    return {
      kind: "faulted",
      fault: {
        kind: "request-refused",
        detail: `Harness "${value}" cannot be launched on this machine — this machine can launch ${selectable(harnesses.ids(), availability).join(", ")}. Nothing was changed.`,
      },
    };
  }
  return { kind: "ready", harness: value };
}

/**
 * Validate the target harness and resolve the model against it, before any
 * state changes. A model key belongs to the harness that will run it, so both
 * answers come from the same harness.
 */
async function resolveIntent(
  params: HandoverAgentParams,
  ctx: ExtensionContext,
): Promise<HandoverIntent> {
  const target = resolveTargetHarness(params.harness_type);
  if (target.kind === "faulted") return target;
  const harness = target.harness;

  const args = params as unknown as Record<string, unknown>;
  try {
    const resolved = await resolveSpawnModel(readModelRequest(args), {
      harness,
      registry: ctx.modelRegistry,
      parent: ctx.model,
      thinking: readThinkingRequest(args),
      listModels: async (foreign) => {
        const list = await getHarnessRegistry()
          .require(foreign)
          .listModels({
            pi: getPiInstance(),
            modelCatalog: piModelCatalog(ctx.modelRegistry),
          });
        const notice = modelListNotice(list);
        if (notice !== undefined && ctx.hasUI) ctx.ui.notify(notice, "warning");
        return modelListEntries(list);
      },
    });
    // Resolution reports, the caller shows: a level outside the vocabulary is
    // a warning, and the next run launches with the level as written.
    for (const notice of resolved.notices) {
      if (ctx.hasUI) ctx.ui.notify(notice, "warning");
    }
    return {
      kind: "ready",
      harness,
      modelChoice: modelChoiceFor(resolved.resolved),
    };
  } catch (error) {
    return {
      kind: "faulted",
      fault: { kind: "request-refused", detail: errorMessage(error) },
    };
  }
}

/** The line the model reads back for one handover, in the tool's own voice. */
export function renderHandoverOutcome(
  agentId: string,
  outcome: HandoverOutcome,
): string {
  return `Agent ${agentId} ${handoverReport(outcome)}`;
}

/**
 * What happened, phrased to read after the agent id. `renderHandoverOutcome`
 * supplies the id once, so a branch cannot produce a message naming no agent.
 */
function handoverReport(outcome: HandoverOutcome): string {
  if (outcome.kind === "handed-over") {
    return `handed over from "${outcome.from}" to "${outcome.to}". The ended run is archived; the next one runs in the same checkout and reports when it settles.`;
  }
  switch (outcome.fault.kind) {
    case "agent-unknown":
      return "not found — check the id from its spawn or completion result.";
    case "agent-not-settled":
      return outcome.fault.status === "queued"
        ? "is still queued — it has not started, so there is no session to hand over. Wait for a concurrency slot (or stop it). Nothing was changed."
        : `is still ${outcome.fault.status} — stop it with stop_cowboy_agent and hand it over once it has settled. Nothing was changed.`;
    case "harness-cannot-export-session":
      return `was not handed over: harness "${outcome.fault.harness}" cannot export its own session, so there is nothing to hand over. Nothing was stopped or changed.`;
    case "never-started":
      return "was not handed over: it never started, so there is no session to export.";
    case "stop-failed":
      return `was not handed over: its run could not be stopped (${outcome.fault.detail}). Nothing was changed.`;
    case "session-empty":
      return `was not handed over: harness "${outcome.fault.harness}" returned an empty session. Nothing was changed: the run was not stopped.`;
    case "session-export-failed":
      return `was not handed over: harness "${outcome.fault.harness}" could not export its session (${outcome.fault.detail}). Nothing was changed: the run was not stopped.`;
    case "request-refused":
      return `was not handed over: ${outcome.fault.detail}`;
    case "launch-failed":
      return `ended its previous run but its next one did not start (${outcome.fault.detail}). It stays tracked and can be cleaned up.`;
  }
}

/**
 * handover_cowboy_agent handler. One agent per call: a handover replaces a run,
 * so a batch would have nothing to gain and every run's pane to lose. The
 * source harness's capability is checked by the session; this resolves the
 * target and reports the outcome in the result.
 */
export async function executeHandoverAgentTool(
  _toolCallId: string,
  params: HandoverAgentParams,
  _signal: AbortSignal | undefined,
  _onUpdate:
    | ((
        update: ToolResult<{ agentId: string; outcome: HandoverOutcome }>,
      ) => void)
    | undefined,
  ctx: ExtensionContext,
): Promise<ToolResult<{ agentId: string; outcome: HandoverOutcome }>> {
  const agentId = params.agent_id;
  const intent = await resolveIntent(params, ctx);
  const outcome: HandoverOutcome =
    intent.kind === "faulted"
      ? { kind: "faulted", fault: intent.fault }
      : await getManager().handover(agentId, {
          harness: intent.harness,
          modelChoice: intent.modelChoice,
        });

  return resultWithSeverity(
    handoverSeverity(outcome),
    renderHandoverOutcome(agentId, outcome),
    { agentId, outcome },
  );
}

/** The handover tool: one agent, one target harness. */
export const handoverAgentTool = {
  name: COWBOY_TOOLS.handoverAgent,
  label: COWBOY_TOOLS.handoverAgent,
  description:
    "Hand over one SETTLED agent to another harness in one call: pass its `agent_id` and the `harness_type` that runs its next run. The ended run is stopped, its session exported by the source harness, the run archived, and the next one launched in the same checkout with that session and its id quoted as its task — so the work continues under the new harness instead of starting over. Nothing is removed: the ended run's pane and harness state stay until cleanup_cowboy_agent, which tears every run down at its own address. A live agent is REFUSED, never stopped — stop it with stop_cowboy_agent first. `harness_type` is required and, unlike a configured default, never falls back: an id this session did not register, or one this machine cannot launch, refuses the call before anything is stopped. The source harness must be able to export its own session; a harness that cannot is reported in the result, naming the harness, and nothing is stopped or changed. The next run reports through its own completion message; this call returns when that run has started, not when it finishes.",
  parameters: HandoverAgentSchema,
  execute: executeHandoverAgentTool,
  constrainedSampling: CONSTRAINED_SAMPLING,
};
