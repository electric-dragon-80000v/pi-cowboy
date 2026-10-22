/**
 * tool-renderer.ts — the one renderer every cowboy tool result goes through.
 *
 * A result line is the user's evidence of what a call did, so it has to say
 * whether the call worked, was refused, or broke. The renderer reads that from
 * the result's own severity; a tool never renders its own output, and a
 * refusal never comes out looking like a success.
 */

import { Text } from "@earendil-works/pi-tui";

import type { Theme } from "../ui/types.js";
import type { ToolSeverity } from "./tool-result.js";

/** The mark each severity reads as; its colour is the theme token of the same name. */
const MARKS: Record<ToolSeverity, string> = {
  success: "✓",
  warning: "!",
  error: "✗",
};

/**
 * The part of a result the renderer reads. Pi's own result type has no
 * severity, so it is read structurally: a result that carries none is a
 * success.
 */
interface RenderedResult {
  content: ReadonlyArray<{ type: string; text?: string }>;
  details?: { severity?: ToolSeverity };
}

/**
 * Paints one cowboy result: the severity's mark, then the text. A success reads
 * as it always did — a green mark over plain output; a refusal or a failure
 * tints the whole line, so it cannot be mistaken for a normal result.
 */
export function renderCowboyToolResult(
  result: RenderedResult,
  _options: { expanded?: boolean },
  theme: Theme,
  context: { isError?: boolean },
): Text {
  const text = result.content.map((block) => block.text ?? "").join("\n");
  const severity: ToolSeverity = context.isError
    ? "error"
    : (result.details?.severity ?? "success");
  const body = severity === "success" ? text : theme.fg(severity, text);
  return new Text(`${theme.fg(severity, MARKS[severity])} ${body}`, 0, 0);
}

/**
 * Every cowboy tool carries this renderer, installed where the tool is
 * registered — one place to change what a result looks like, for all of them.
 */
export function withCowboyRenderer<TTool extends object>(
  tool: TTool,
): TTool & { renderResult: typeof renderCowboyToolResult } {
  return { ...tool, renderResult: renderCowboyToolResult };
}
