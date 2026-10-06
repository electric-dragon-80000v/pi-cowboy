/**
 * tool-result.ts — shared tool result types.
 *
 * Pi's `AgentToolResult<T>` does not resolve from this repo, so the shape is
 * declared structurally here; `ToolResult<TDetails>` stays assignable to it.
 */

/** Text content plus a details payload; structural subset of pi's `AgentToolResult<T>`. */
export interface ToolResult<TDetails = Record<string, unknown>> {
  content: Array<{ type: "text"; text: string }>;
  details: TDetails;
}

export function successResult<TDetails>(
  text: string,
  details: TDetails,
): ToolResult<TDetails> {
  return { content: [{ type: "text", text }], details };
}

/**
 * No `details` key at runtime (pi reads `result.details` straight off the
 * object, so missing and `undefined` are identical); asserted here because
 * `ToolResult` requires the field for the registration site to typecheck.
 */
export function textOnlyResult<TDetails = undefined>(
  text: string,
): ToolResult<TDetails> {
  return { content: [{ type: "text", text }] } as ToolResult<TDetails>;
}
