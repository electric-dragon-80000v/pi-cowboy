/**
 * briefing-section.ts — Renders the resolved template's `guidance` as the
 * briefing's `## Orchestrator Guidance` section.
 *
 * Renders `guidance` verbatim. Spliced in LAST by buildLaunchPlan, so the
 * guidance stays maximally close to the work in every inference request.
 */

/** The `## Orchestrator Guidance` section, or `""` when the template declared none. */
export function buildOrchestrationGuidance(
  agentGuidance: string | undefined,
): string {
  if (!agentGuidance?.trim()) return "";
  // Template-authored text: copied byte-for-byte, never trimmed or reworded.
  return ["## Orchestrator Guidance", "", agentGuidance].join("\n");
}
