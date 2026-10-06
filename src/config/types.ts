/**
 * Non-model keys in config.agent — preserved when clearing all overrides.
 * `isProjectAllowedAgentKey` reads this list: a project file may carry only
 * the model family and per-type model keys.
 */
export const CONFIG_AGENT_NON_MODEL_KEYS = [
  "default",
  "defaultAgentType",
  "defaultOrchestrator",
  "systemPromptMode",
  "includeContextFiles",
  "defaultThinking",
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
