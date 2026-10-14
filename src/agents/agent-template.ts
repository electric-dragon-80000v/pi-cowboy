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
import type { ToolFilter, ToolsByFamily } from "./types.js";

const filterList = z.union([z.boolean(), z.array(z.string())]);

/**
 * The pi family's own `[harness]` keys, shared by their `[harness.pi]` table
 * and their flat alias at the top level. The family-neutral key
 * (`include_context_files`) stays at the top level; a second family adds its
 * own strict table beside `pi` rather than widening this one.
 *
 * `model` belongs here with the pi family's keys, not with the neutral ones: a
 * model key names an entry in one harness's catalogue, so a neutral slot could
 * only ever be right for one family and wrong for the rest. The flat spelling
 * stays loadable as the pi family's own, and the transform files it under
 * `pi` like any other pi key. The same holds for `tools` / `exclude_tools`: a
 * name list is catalogue-scoped, so the flat spelling is pi's, opencode
 * reads only its own table's pair, and codex — which has no tools flag —
 * reads only its own table's model; claude reads only its own pair.
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
  /** Tools available to a pi-family launch, in pi's own vocabulary. */
  tools: z.array(z.string()).optional(),
  /** Tools withheld from a pi-family launch, in pi's own vocabulary. */
  exclude_tools: z.array(z.string()).optional(),
};

const PiHarnessSchema = z.strictObject(PI_HARNESS_SHAPE);

/** opencode's own `[harness.opencode]` keys; no other family reads them. */
const OpencodeHarnessSchema = z.strictObject({
  /** A model key in opencode's catalogue, as "provider/model-id". */
  model: z.string().optional(),
  /** The reasoning-effort variant, joined to this agent's model as "provider/model#variant". */
  variant: z.string().optional(),
  /** Tools available to an opencode launch, as opencode's permission actions. */
  tools: z.array(z.string()).optional(),
  /** Tools withheld from an opencode launch, as opencode's permission actions. */
  exclude_tools: z.array(z.string()).optional(),
});

/**
 * codex's own `[harness.codex]` keys; no other family reads them. codex has
 * no tools flag, so the table carries the model alone — a tool pair here
 * would have no reader.
 */
const CodexHarnessSchema = z.strictObject({
  /** A model key in codex's catalogue, as "provider/model-id". */
  model: z.string().optional(),
});

/** claude's own `[harness.claude]` keys; no other family reads them. */
const ClaudeHarnessSchema = z.strictObject({
  /** A model key in claude's catalogue, as "provider/model-id" (`anthropic/<alias>`); the launch strips the prefix to the bare alias the CLI takes. */
  model: z.string().optional(),
  /** Tools available to a claude launch, as claude's own tool names (`Bash`, `Read`, …), carried onto `--tools` exactly as written. */
  tools: z.array(z.string()).optional(),
  /** Tools withheld from a claude launch, as claude's own tool names, carried onto `--disallowedTools` exactly as written. */
  exclude_tools: z.array(z.string()).optional(),
});

/** One family's tool arms as parsed, arbitrated to the single filter a launch reads: whitelist wins when both arms are set. */
function toToolFilter(
  tools: string[] | undefined,
  excludeTools: string[] | undefined,
): ToolFilter | undefined {
  if (tools !== undefined) return { tools };
  if (excludeTools !== undefined) return { excludeTools };
  return undefined;
}

/**
 * The `[harness]` table describes the child process, not the agent's identity
 * or its worktree. The one family-neutral key (`include_context_files`) sits
 * here; every catalogue-scoped key sits with its family — a model key with the
 * family whose catalogue defines it, a tool list with the family whose names
 * it is written in — under `[harness.<family>]`, with pi's spellings also
 * loadable flat.
 *
 * A pi-only key written flat under `[harness]` means the same slice as
 * `[harness.pi]`, so both spellings load; an explicit `[harness.pi]` value wins
 * over its flat twin, per key. The transform collapses the family tables into
 * the one shape the resolution code reads, so the on-disk keying stops at this
 * boundary — and it keeps the model keys and the tool filters keyed by family,
 * so the slice a launch reads is the one its own catalogue wrote.
 */
const HarnessSchema = z
  .strictObject({
    /** Whether the child's system prompt carries the repo's AGENTS.md context files. */
    include_context_files: z.boolean().optional(),
    pi: PiHarnessSchema.optional(),
    opencode: OpencodeHarnessSchema.optional(),
    codex: CodexHarnessSchema.optional(),
    claude: ClaudeHarnessSchema.optional(),
    ...PI_HARNESS_SHAPE,
  })
  .transform(({ pi, opencode, codex, claude, ...flat }) => {
    const {
      model: flatModel,
      tools: flatTools,
      exclude_tools: flatExcludeTools,
      ...sharedFlat
    } = flat;
    const {
      model: piModel,
      tools: piTools,
      exclude_tools: piExcludeTools,
      ...piSlice
    } = compactDefined(pi ?? {});
    const {
      model: opencodeModel,
      tools: opencodeTools,
      exclude_tools: opencodeExcludeTools,
      ...opencodeSlice
    } = compactDefined(opencode ?? {});
    const { model: codexModel, ...codexSlice } = compactDefined(codex ?? {});
    const {
      model: claudeModel,
      tools: claudeTools,
      exclude_tools: claudeExcludeTools,
    } = compactDefined(claude ?? {});
    const modelsByFamily: Partial<Record<HarnessFamily, string>> =
      compactDefined({
        pi: piModel ?? flatModel,
        opencode: opencodeModel,
        codex: codexModel,
        claude: claudeModel,
      });
    const toolsByFamily: ToolsByFamily = compactDefined({
      pi: toToolFilter(
        piTools ?? flatTools,
        piExcludeTools ?? flatExcludeTools,
      ),
      opencode: toToolFilter(opencodeTools, opencodeExcludeTools),
      claude: toToolFilter(claudeTools, claudeExcludeTools),
    });
    return {
      ...sharedFlat,
      ...piSlice,
      ...opencodeSlice,
      ...codexSlice,
      ...(Object.keys(modelsByFamily).length > 0 ? { modelsByFamily } : {}),
      ...(Object.keys(toolsByFamily).length > 0 ? { toolsByFamily } : {}),
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
