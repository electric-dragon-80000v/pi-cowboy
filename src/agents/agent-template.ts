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
import { compactDefined } from "../templates/template-files.js";
import { HARNESS_IDS, type HarnessFamily } from "./harness.js";

const filterList = z.union([z.boolean(), z.array(z.string())]);

/**
 * The pi family's own `[harness]` keys, shared by their `[harness.pi]` table
 * and their flat alias at the top level. The family-neutral keys (`tools`,
 * `exclude_tools`, `include_context_files`) stay at the top level; a second
 * family adds its own strict table beside `pi` rather than widening this one.
 *
 * `model` belongs here with the pi family's keys, not with the neutral ones: a
 * model key names an entry in one harness's catalogue, so a neutral slot could
 * only ever be right for one family and wrong for the rest. The flat spelling
 * stays loadable as the pi family's own, and the transform files it under
 * `pi` like any other pi key.
 */
const PI_HARNESS_SHAPE = {
  /** A model key in pi's catalogue, as "provider/model-id". */
  model: z.string().optional(),
  thinking: z.enum(VALID_THINKING_LEVELS).optional(),
  extensions: filterList.optional(),
  skills: filterList.optional(),
  /** Names inlined in full into the system prompt; a `skills` entry is only a name, description, and file path. An empty list inlines nothing. */
  inlined_skills: z.array(z.string()).optional(),
  /** Fork the parent session into the subagent (`pi --fork <sessionFile>`). */
  fork: z.boolean().optional(),
};

const PiHarnessSchema = z.strictObject(PI_HARNESS_SHAPE);

/** opencode's own `[harness.opencode]` keys; no other family reads them. */
const OpencodeHarnessSchema = z.strictObject({
  /** A model key in opencode's catalogue, as "provider/model-id". */
  model: z.string().optional(),
  /** The reasoning-effort variant opencode's agent definition carries (the `--variant` of `opencode run`, which is not a flag of the command pi-cowboy launches). */
  variant: z.string().optional(),
});

/**
 * The `[harness]` table describes the child process, not the agent's identity
 * or its worktree. Family-neutral keys sit here, each family translating them
 * its own way; a family's own keys sit under `[harness.<family>]`, and a model
 * key sits with the family whose catalogue defines it.
 *
 * A pi-only key written flat under `[harness]` means the same slice as
 * `[harness.pi]`, so both spellings load; an explicit `[harness.pi]` value wins
 * over its flat twin. The transform collapses the family tables into the one
 * shape the resolution code reads, so the on-disk keying stops at this
 * boundary — and it keeps the model keys keyed by family, so the key a launch
 * reads is the one its own catalogue wrote.
 */
const HarnessSchema = z
  .strictObject({
    tools: z.array(z.string()).optional(),
    exclude_tools: z.array(z.string()).optional(),
    /** Whether the child's system prompt carries the repo's AGENTS.md context files. */
    include_context_files: z.boolean().optional(),
    pi: PiHarnessSchema.optional(),
    opencode: OpencodeHarnessSchema.optional(),
    ...PI_HARNESS_SHAPE,
  })
  .transform(({ pi, opencode, ...flat }) => {
    const { model: flatModel, ...sharedFlat } = flat;
    const { model: piModel, ...piSlice } = compactDefined(pi ?? {});
    const { model: opencodeModel, ...opencodeSlice } = compactDefined(
      opencode ?? {},
    );
    const modelsByFamily: Partial<Record<HarnessFamily, string>> =
      compactDefined({ pi: piModel ?? flatModel, opencode: opencodeModel });
    return {
      ...sharedFlat,
      ...piSlice,
      ...opencodeSlice,
      ...(Object.keys(modelsByFamily).length > 0 ? { modelsByFamily } : {}),
    };
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
