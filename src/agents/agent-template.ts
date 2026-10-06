/**
 * agent-template.ts — The Zod schema for one agent template file.
 *
 * Single source of truth for the `.toml` format: snake_case keys, values
 * typed exactly as written, unknown keys rejected so typos fail at load.
 * The type derives via `z.infer`.
 */

import { z } from "zod";
import { VALID_THINKING_LEVELS } from "../utils.js";
import { VALID_WORKTREE_CHECKOUT_TYPES } from "../spawn/worktree-policy.js";
import { HARNESS_IDS } from "./harness.js";

const filterList = z.union([z.boolean(), z.array(z.string())]);

/**
 * The `[harness]` table: These describe the child process,
 * not the agent's identity or its worktree.
 */
const HarnessSchema = z.strictObject({
  model: z.string().optional(),
  thinking: z.enum(VALID_THINKING_LEVELS).optional(),
  tools: z.array(z.string()).optional(),
  exclude_tools: z.array(z.string()).optional(),
  extensions: filterList.optional(),
  skills: filterList.optional(),
  /** Names inlined in full into the system prompt; a `skills` entry is only a name, description, and file path. An empty list inlines nothing. */
  inlined_skills: z.array(z.string()).optional(),
  /** Fork the parent session into the subagent (`pi --fork <sessionFile>`). */
  fork: z.boolean().optional(),
  /** Whether the child's system prompt carries the repo's AGENTS.md context files. */
  include_context_files: z.boolean().optional(),
});

export const AgentTemplateSchema = z.strictObject({
  name: z.string().optional(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  // Absent by design: `max_turns` and `max_tokens` would imply a limit nothing
  // enforces, and `output_transcript` would name an output file nothing writes.
  hidden: z.boolean().optional(),
  /** Whether this agent's worktree carries a dirty parent's WIP. */
  worktree_checkout_type: z.enum(VALID_WORKTREE_CHECKOUT_TYPES).optional(),
  /** Absent falls through the merge to inherit an earlier layer's prompt; an explicitly empty string clears it. */
  system_prompt: z.string().optional(),
  /** Which harness owns this agent's launch; omitted falls through to the configured default. */
  harness_type: z.enum(HARNESS_IDS).optional(),
  /** How the child process is launched. Omitted = every field's default. */
  harness: HarnessSchema.optional(),
});

export type AgentTemplate = z.infer<typeof AgentTemplateSchema>;
