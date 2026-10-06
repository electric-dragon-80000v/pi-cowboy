import type { ThinkingLevel } from "../types.js";
import type { WorktreeCheckoutType } from "../spawn/worktree-policy.js";
import type { HarnessId } from "./harness.js";

export type SubagentType = string;

/** How the subagent system prompt is constructed. */
export type SystemPromptMode = "replace" | "inherit" | "custom";

/**
 * Tool-visibility filter — mutually exclusive arms (never-props reject
 * both-set configs at compile time).
 *
 * - Whitelist: `tools` (true = all, string[] = listed, false = none).
 *   Entries are bare pi tool names. An extension's tools are named by the
 *   extension, so there is no `ext/tool` syntax to expand.
 * - Blacklist: `excludeTools` (all tools except these); `tools` unset.
 *
 * Parsed .toml templates can still set both arms; see `arbitrateFilters`.
 */
type ToolFilter =
  | { tools?: true | string[] | false; excludeTools?: never }
  | { tools?: undefined; excludeTools: string[] };

/** AgentConfig fields independent of the tool filter. */
interface BaseAgentConfig {
  name: string;
  displayName?: string;
  description: string;
  /** Allowed skills (metadata only in system prompt). undefined uses the global default. */
  skills?: true | string[] | false;
  /**
   * Allowed extensions (true = all, string[] = listed, false = none).
   * undefined uses the global default. There is no blacklist arm: pi has no
   * extension-exclusion CLI flag, so an exclusion could never be honored.
   */
  extensions?: true | string[] | false;
  /**
   * Skills whose full text is inlined into the system prompt. A `skills` entry
   * is only the name, description, and file path — the agent reads the file.
   * Default = [].
   */
  inlinedSkills?: string[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  systemPrompt: string;
  /** Include pi's context files in this agent's system prompt. Undefined = use global config. */
  includeContextFiles?: boolean;
  /** Whether this agent's worktree carries a dirty parent's WIP. Undefined = use global config. */
  worktreeCheckoutType?: WorktreeCheckoutType;
  /** Fork the parent session into the subagent (`pi --fork <sessionFile>`); unset means no fork. */
  fork?: boolean;
  /** Hidden from the schema enum but still callable by name. */
  hidden?: boolean;
  /** Which harness launches this agent. Undefined = use the configured default. */
  harnessType?: HarnessId;
}

/**
 * Unified agent configuration for default and user-defined agents.
 * Both-set tool-filter configs are type errors (never-props, Effective
 * TypeScript item 63); parsed .toml templates normalize via arbitration.
 */
export type AgentConfig = BaseAgentConfig & ToolFilter;

export interface AgentInvocation {
  /** Short display name, e.g. "haiku" — only set when different from parent. */
  modelName?: string;
  thinkingLevel?: ThinkingLevel;
  runInBackground?: boolean;
  /** Whether the run forked the parent session. */
  fork?: boolean;
}
