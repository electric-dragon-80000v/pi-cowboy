/**
 * tool-renderer.test.ts — the one renderer every cowboy result goes through:
 * the mark and colour each severity gets, the fallbacks, and the wiring that
 * installs it on a tool.
 */

import { describe, expect, it } from "vitest";

import {
  renderCowboyToolResult,
  withCowboyRenderer,
} from "../src/agents/tool-renderer.js";
import type { ToolSeverity } from "../src/agents/tool-result.js";
import type { Theme } from "../src/ui/types.js";

/** Colours are visible in the rendered line, so a test can assert which token painted what. */
const THEME: Theme = {
  fg: (color, text) => `<${color}>${text}</>`,
  bg: (_color, text) => text,
  bold: (text) => text,
};

function render(
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: { severity?: ToolSeverity };
  },
  context: { isError?: boolean } = {},
): string {
  // The component pads every row to the render width, which no test asserts.
  return renderCowboyToolResult(result, {}, THEME, context)
    .render(200)
    .map((line) => line.trimEnd())
    .join("\n");
}

const text = (value: string) => [{ type: "text", text: value }];

describe("renderCowboyToolResult", () => {
  it("marks a success and leaves its text as it was", () => {
    expect(
      render({
        content: text("Stopped agent a"),
        details: { severity: "success" },
      }),
    ).toBe("<success>✓</> Stopped agent a");
  });

  it("paints a refusal as a warning", () => {
    expect(
      render({
        content: text("Agent a not found"),
        details: { severity: "warning" },
      }),
    ).toBe("<warning>!</> <warning>Agent a not found</>");
  });

  it("paints a failure as an error", () => {
    expect(
      render({ content: text("boom"), details: { severity: "error" } }),
    ).toBe("<error>✗</> <error>boom</>");
  });

  it("reads a result with no severity as a success", () => {
    expect(render({ content: text("plain") })).toBe("<success>✓</> plain");
  });

  it("paints a thrown tool as an error whatever the result says", () => {
    expect(
      render(
        { content: text("boom"), details: { severity: "success" } },
        { isError: true },
      ),
    ).toBe("<error>✗</> <error>boom</>");
  });

  it("joins every text block into the one line it paints", () => {
    expect(
      render({
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
        details: { severity: "warning" },
      }),
    ).toContain("<warning>first\nsecond</>");
  });
});

describe("withCowboyRenderer", () => {
  it("installs the shared renderer without touching the tool it was given", () => {
    const tool = { name: "cowboy_agent" };

    expect(withCowboyRenderer(tool).renderResult).toBe(renderCowboyToolResult);
    expect(tool).not.toHaveProperty("renderResult");
  });
});
