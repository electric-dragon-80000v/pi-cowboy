import type { SpawnThinkingLevel } from "../types.js";
import type { WorktreeCheckoutType } from "../spawn/worktree-policy.js";
import type { AnyHarnessId, HarnessFamily } from "./harness.js";

/**
 * A template's model keys, each under the harness family whose catalogue
 * defines it. A key written for one family is invisible to every other: a
 * launch reads only its own family's entry, and a family the template does not
 * name has none.
 */
export type ModelsByFamily = Partial<Record<HarnessFamily, string>>;

/**
 * A template's thinking tokens, each under the harness family whose vocabulary
 * defines it. A token names a level in one family's vocabulary, so a token
 * written for one family is invisible to every other: it can never ride onto a
 * launch that would misread it.
 */
export type ThinkingByFamily = Partial<Record<HarnessFamily, string>>;

export type SubagentType = string;

/** How the subagent system prompt is constructed. */
export type SystemPromptMode = "replace" | "inherit" | "custom";

/**
 * One family's tool-visibility filter, in that family's own vocabulary —
 * mutually exclusive arms (never-props reject both-set configs at compile
 * time, per family).
 *
 * - Whitelist: `tools` (true = all, string[] = listed, false = none).
 *   Entries are bare tool names in the launching family's catalogue. An
 *   extension's tools are named by the extension, so there is no `ext/tool`
 *   syntax to expand.
 * - Blacklist: `excludeTools` (all tools except these); `tools` unset.
 *
 * The template transform arbitrates a family's both-arms slice at parse
 * (whitelist wins), so nothing downstream ever sees both arms set.
 */
export type ToolFilter =
  | { tools?: true | string[] | false; excludeTools?: never }
  | { tools?: undefined; excludeTools: string[] };

/**
 * A template's tool filters, each under the harness family whose catalogue
 * defines its names. A list written for one family is invisible to every
 * other: a launch reads only its own family's entry, and a family the template
 * does not name launches unfiltered.
 */
export type ToolsByFamily = Partial<Record<HarnessFamily, ToolFilter>>;

/** AgentConfig fields; the tool filter rides `toolsByFamily`, one slice per harness family. */
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
  /** This agent's model keys, one per harness family; a launch reads only its own family's. */
  modelsByFamily?: ModelsByFamily;
  /** This agent's tool filters, one per harness family; a launch reads only its own family's. */
  toolsByFamily?: ToolsByFamily;
  /** This agent's thinking token, one per harness family; a launch reads only its own family's. */
  thinkingByFamily?: ThinkingByFamily;
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
  harnessType?: AnyHarnessId;
}

/**
 * Unified agent configuration for default and user-defined agents.
 * Both-set tool-filter configs are type errors per family (never-props,
 * Effective TypeScript item 63); the template transform arbitrates at parse.
 */
export type AgentConfig = BaseAgentConfig;

export interface AgentInvocation {
  /** Short display name, e.g. "haiku" — only set when different from parent. */
  modelName?: string;
  thinkingLevel?: SpawnThinkingLevel;
  runInBackground?: boolean;
  /** Whether the run forked the parent session. */
  fork?: boolean;
}
