/**
 * types.ts — Shared orchestrator declarations: cue events, the cue template
 * set, and the config/summary shapes. Per-cue variable sets live in
 * context.ts — no shared "every variable" list, so a cue can never grow a
 * variable the others silently inherit.
 */

/** Points at which the orchestrator hears about a delegation. */
export type CueEvent = "spawned" | "queued" | "settled";

/** One Mustache template per cue event, rendered against that event's context. */
export type CueTemplates = Record<CueEvent, string>;

/** A named orchestration template: cue wording plus front-facing metadata. */
export interface OrchestratorConfig {
  name: string;
  displayName?: string;
  cues: CueTemplates;
  /** Authored subagent-facing instructions, copied verbatim. Blank adds no section. */
  guidance: string;
}
