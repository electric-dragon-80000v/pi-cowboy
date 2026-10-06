/**
 * orchestrator-template.ts — The Zod schema for one orchestrator template file.
 *
 * Single source of truth for the `.toml` format: snake_case keys, strict at
 * the root AND inside `[cues]` so a typo'd cue event fails at load time. The
 * TypeScript type is derived with `z.infer`.
 *
 * Shape is Zod's job; cue variables are cues.ts's — a failure lands as a Zod
 * issue on that cue's own path (`cues.spawned: unknown variable ...`).
 */

import { z } from "zod";
import { validateCueTemplate } from "./cues.js";
import type { CueEvent } from "./types.js";

const CUE_EVENTS: readonly CueEvent[] = ["spawned", "queued", "settled"];

/** The `[cues]` table: strict, and variable-validated per present cue. */
const CuesSchema = z
  .strictObject({
    spawned: z.string().optional(),
    queued: z.string().optional(),
    settled: z.string().optional(),
  })
  .superRefine((cues, ctx) => {
    for (const event of CUE_EVENTS) {
      const template = cues[event];
      if (template === undefined) continue;
      const validation = validateCueTemplate(event, template);
      if (!validation.ok) {
        ctx.addIssue({
          code: "custom",
          message: validation.reason,
          path: [event],
        });
      }
    }
  });

export const OrchestratorTemplateSchema = z.strictObject({
  name: z.string().optional(),
  display_name: z.string().optional(),
  /** Subagent-facing instruction, copied verbatim; omitted means the base template's applies. */
  guidance: z.string().optional(),
  /** Only the events this file defines; the base supplies the rest. */
  cues: CuesSchema.optional(),
});

export type OrchestratorTemplate = z.infer<typeof OrchestratorTemplateSchema>;
