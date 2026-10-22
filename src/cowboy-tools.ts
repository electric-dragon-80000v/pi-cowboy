/**
 * cowboy-tools.ts — the vocabulary every Cowboy tool shares.
 *
 * A handler module defines its own tool beside the code that runs it, so the
 * name and the sampling constraint it needs live here instead of in the
 * registration module — which imports every handler and cannot be imported
 * back. Registration re-exports both names for callers that think in terms of
 * the tool set as a whole.
 */

/** The one place a tool name is spelled; the tools are named from these. */
export const COWBOY_TOOLS = {
  agent: "cowboy_agent",
  stopAgent: "stop_cowboy_agent",
  mergeBranch: "merge_cowboy_branch",
  steerAgent: "steer_cowboy_agent",
  handoverAgent: "handover_cowboy_agent",
  cleanupAgent: "cleanup_cowboy_agent",
} as const;

export const COWBOY_TOOL_NAMES: readonly string[] = Object.values(COWBOY_TOOLS);

/** "prefer" falls back gracefully on providers without strict mode. */
export const CONSTRAINED_SAMPLING = {
  type: "json_schema",
  strict: "prefer",
} as const;
