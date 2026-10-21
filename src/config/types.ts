/**
 * Non-model keys in config.agent — preserved when clearing all overrides.
 * `isProjectAllowedAgentKey` reads this list: a project file may carry only
 * the model family and per-type model keys.
 *
 * The model-family keys are named here too, because a key that names a table
 * is not an agent type: without an entry, a type named `thinking` would be
 * shadowed by the table and its model key would be read as a level.
 */

/** The per-harness default model map's key in config.agent. */
export const DEFAULT_MODEL_BY_HARNESS_KEY = "defaultModelByHarness";

/** The per-harness default thinking map's key in config.agent. */
export const DEFAULT_THINKING_BY_HARNESS_KEY = "defaultThinkingByHarness";

/** The per-type thinking override map's key in config.agent. */
export const THINKING_BY_TYPE_KEY = "thinking";

/**
 * Which layers carry a setting, the question a clear picker asks before it
 * offers a row. Each layer answers for itself: the session from its in-memory
 * value, a file layer from the key the file holds.
 */
export interface ConfigLayerPresence {
  session: boolean;
  project: boolean;
  global: boolean;
}

export const CONFIG_AGENT_NON_MODEL_KEYS = [
  "default",
  "defaultAgentType",
  "defaultOrchestrator",
  "systemPromptMode",
  "includeContextFiles",
  "defaultThinking",
  DEFAULT_THINKING_BY_HARNESS_KEY,
  THINKING_BY_TYPE_KEY,
  "loadSkillsImplicitly",
  "loadExtensionsImplicitly",
  "disableDefaultAgents",
  "extensionEnabled",
  "showActiveIndicator",
  "grazingEnabled",
  "worktreeRoot",
  "worktreeMaterialization",
  "worktreeCheckoutType",
  "harnessType",
];
