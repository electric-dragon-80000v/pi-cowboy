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
 * - harness: explicit `harness_type` (validated at parse, used as-is) → the
 *   agent template's `harness_type` → the config setting, then narrowed to the
 *   harnesses this machine can launch.
 *
 * A configured value that no longer resolves degrades to the built-in
 * fallback instead of failing the spawn. Only an explicit `harness_type`
 * refuses: it names a harness the caller chose, so the config path's pi
 * fallback stays out of it.
 */

import { DEFAULT_AGENT_TYPE, DEFAULT_ORCHESTRATOR_NAME } from "../types.js";
import { isAvailable, selectable } from "../availability.js";
import { getHarnessAvailability, getStore } from "../shell.js";
import { DEFAULT_ORCHESTRATORS } from "../orchestrators/default-orchestrators.js";
import { resolveOrchestrator } from "../orchestrators/orchestrator-types.js";
import type { OrchestratorConfig } from "../orchestrators/types.js";
import type { WorktreeCheckoutType } from "../spawn/worktree-policy.js";
import {
  HARNESS_IDS,
  parseHarnessId,
  resolveHarness,
  type HarnessId,
} from "./harness.js";

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

/** The caller's value when it is a non-blank string; `null`, blank, and non-strings are the unset shape an optional param arrives as. */
function harnessParam(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

/**
 * The caller's explicit `harness_type` when it names a harness this machine can
 * launch, else undefined. The `tool_call` listener reads raw input and must not
 * throw, so an unknown or unlaunchable value is left alone here —
 * `resolveRequestedHarness` raises it at parse.
 */
export function requestedHarnessId(raw: unknown): HarnessId | undefined {
  const id = parseHarnessId(harnessParam(raw));
  if (id === undefined) return undefined;
  return isAvailable(id, getHarnessAvailability()) ? id : undefined;
}

/**
 * Validate a caller-supplied `harness_type` at parse. An unknown id and one this
 * machine cannot launch are both refusals: an explicit request has no fallback,
 * unlike the template and config path. Returns the id when usable, and
 * undefined when the caller left it unset.
 */
export function resolveRequestedHarness(raw: unknown): HarnessId | undefined {
  const value = harnessParam(raw);
  if (value === undefined) return undefined;

  const id = parseHarnessId(value);
  if (id === undefined) {
    throw new Error(
      `Unknown harness_type "${value}": valid harnesses are ${HARNESS_IDS.join(", ")}. Nothing was spawned. Omit \`harness_type\` to use the agent template's harness, then the configured default.`,
    );
  }

  const availability = getHarnessAvailability();
  if (!isAvailable(id, availability)) {
    throw new Error(
      `Harness "${id}" cannot be launched on this machine — this machine can launch ${selectable(HARNESS_IDS, availability).join(", ")}. Nothing was spawned. Omit \`harness_type\` to use the agent template's harness, then the configured default.`,
    );
  }

  return id;
}

/** Which harness launches this agent: the caller's `harness_type` wins, then the agent template's `harness_type`, then the config setting, read at call time like the other spawn defaults. An explicit value is validated at parse and used as-is; a configured or template harness this machine cannot launch falls back to pi. */
export function resolveHarnessType(
  agentType: string,
  requested?: HarnessId,
): HarnessId {
  if (requested !== undefined) return requested;
  const configured =
    getAgentConfig(agentType)?.harnessType ?? getStore().agent.harnessType;
  return resolveHarness(configured, getHarnessAvailability());
}
