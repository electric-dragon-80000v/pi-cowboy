/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * Always available; overridable by same-named .toml files. Only
 * general-purpose is embedded — other types are scanned .toml templates.
 */

import type { AgentConfig } from "./types.js";

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
  [
    "general-purpose",
    {
      name: "general-purpose",
      displayName: "Agent",
      description: "General-purpose agent for complex, multi-step tasks",
      // extensions, skills, and harness intentionally omitted — resolved by global default
      inlinedSkills: [],
      systemPrompt: "",
    },
  ],
]);
