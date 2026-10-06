/**
 * spawn-defaults.ts — what an omitted cowboy_agent param resolves to, read at
 * call time over the live config store.
 *
 * - agent type: explicit `agent_type` → configured `defaultAgentType` →
 *   built-in `general-purpose`;
 * - orchestrator: configured `defaultOrchestrator` → built-in `default`,
 *   resolved at spawn time by every spawn path;
 * - worktree dirty-checkout policy: the agent template's key → the config
 *   setting;
 * - harness: the agent template's `harness_type` → the config setting, then
 *   narrowed to the harnesses this machine can launch.
 *
 * A configured value that no longer resolves degrades to the built-in
 * fallback instead of failing the spawn.
 */

import { DEFAULT_AGENT_TYPE, DEFAULT_ORCHESTRATOR_NAME } from "../types.js";
import { getHarnessAvailability, getStore } from "../shell.js";
import { DEFAULT_ORCHESTRATORS } from "../orchestrators/default-orchestrators.js";
import { resolveOrchestrator } from "../orchestrators/orchestrator-types.js";
import type { OrchestratorConfig } from "../orchestrators/types.js";
import type { WorktreeCheckoutType } from "../spawn/worktree-policy.js";
import { resolveHarness, type HarnessId } from "./harness.js";

import { getAgentConfig, resolveType } from "./agent-types.js";

/** Unset/blank configured string. `""` is the only blank form the store writes. */
function configuredString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Configured `defaultAgentType` → built-in fallback. Returns the canonical registered key. */
export function resolveDefaultAgentType(): string {
  const configured = configuredString(getStore().agent.defaultAgentType);
  if (configured === undefined) return DEFAULT_AGENT_TYPE;
  const resolution = resolveType(configured);
  return resolution.kind === "resolved" ? resolution.key : DEFAULT_AGENT_TYPE;
}

/** Configured `defaultOrchestrator` → built-in `default`, returned as written. */
export function resolveDefaultOrchestratorName(): string {
  const configured = configuredString(getStore().agent.defaultOrchestrator);
  if (configured === undefined) return DEFAULT_ORCHESTRATOR_NAME;
  if (configured === DEFAULT_ORCHESTRATOR_NAME) return configured;
  return resolveOrchestrator(configured)
    ? configured
    : DEFAULT_ORCHESTRATOR_NAME;
}

/** Explicit non-empty `agent_type` wins verbatim; anything else falls back to the configured default. Shared with the `tool_call` listener so both halves see the same type. */
export function resolveAgentTypeParam(raw: unknown): string {
  return typeof raw === "string" && raw !== ""
    ? raw
    : resolveDefaultAgentType();
}

/** Configured default → code `default`. Pure registry lookup — call before any worktree resolution. Returns the canonical config. */
export function resolveDefaultOrchestrator(): OrchestratorConfig {
  const requested = resolveDefaultOrchestratorName();
  const resolved =
    resolveOrchestrator(requested) ??
    (requested === DEFAULT_ORCHESTRATOR_NAME
      ? DEFAULT_ORCHESTRATORS[DEFAULT_ORCHESTRATOR_NAME]
      : undefined);
  return resolved ?? DEFAULT_ORCHESTRATORS[DEFAULT_ORCHESTRATOR_NAME];
}

/** Whether a dirty parent's WIP starts in this agent's worktree: the agent template's key wins over the config setting, read at call time like the other spawn defaults. */
export function resolveWorktreeCheckoutType(
  agentType: string,
): WorktreeCheckoutType {
  return (
    getAgentConfig(agentType)?.worktreeCheckoutType ??
    getStore().agent.worktreeCheckoutType
  );
}

/** Which harness launches this agent: the agent template's `harness_type` wins over the config setting, read at call time like the other spawn defaults, and a harness this machine cannot launch falls back to pi. */
export function resolveHarnessType(agentType: string): HarnessId {
  const configured =
    getAgentConfig(agentType)?.harnessType ?? getStore().agent.harnessType;
  return resolveHarness(configured, getHarnessAvailability());
}
