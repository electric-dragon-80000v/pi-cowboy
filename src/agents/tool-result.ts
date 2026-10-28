/**
 * tool-result.ts — shared tool result types.
 *
 * Pi's `AgentToolResult<T>` does not resolve from this repo, so the shape is
 * declared structurally here; `ToolResult<TDetails>` stays assignable to it.
 *
 * Every result also says how the call ended: it worked, it was refused, or it
 * broke. The shared renderer paints the result line from that mark, so a
 * refusal never reads like a success and no tool renders its own output.
 */

/** How one call ended, for the user's eye. */
export type ToolSeverity = "success" | "warning" | "error";

/**
 * Text content plus a details payload; structural subset of pi's
 * `AgentToolResult<T>`.
 *
 * The severity rides `details` rather than the result itself because pi hands
 * a renderer exactly `{ content, details }` — a field outside those two never
 * reaches it.
 */
export interface ToolResult<TDetails = Record<string, unknown>> {
  content: Array<{ type: "text"; text: string }>;
  details: TDetails & { severity: ToolSeverity };
}

export function resultWithSeverity<TDetails>(
  severity: ToolSeverity,
  text: string,
  details: TDetails,
): ToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    details: { ...details, severity },
  };
}

export function successResult<TDetails>(
  text: string,
  details: TDetails,
): ToolResult<TDetails> {
  return resultWithSeverity("success", text, details);
}

export function warningResult<TDetails>(
  text: string,
  details: TDetails,
): ToolResult<TDetails> {
  return resultWithSeverity("warning", text, details);
}

export function errorResult<TDetails>(
  text: string,
  details: TDetails,
): ToolResult<TDetails> {
  return resultWithSeverity("error", text, details);
}

/** No additional details payload; severity remains present for result rendering. */
export function textOnlyResult(text: string): ToolResult<Record<never, never>> {
  return {
    content: [{ type: "text", text }],
    details: { severity: "success" },
  };
}

/**
 * A call's severity from its items': the worst one wins, because a batch that
 * refused or failed anything must not read as a plain success.
 */
export function foldSeverity(
  severities: readonly ToolSeverity[],
): ToolSeverity {
  if (severities.includes("error")) return "error";
  if (severities.includes("warning")) return "warning";
  return "success";
}
