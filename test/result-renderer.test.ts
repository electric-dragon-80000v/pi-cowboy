/**
 * result-renderer.test.ts — the subagent-result message renderer: one table of
 * input → rendered rows, so every scenario gets its own reported test. The
 * happy path is a real multi-line markdown report; the rest cover the error
 * mark, the headline-only detection, and inputs that are missing or cut off.
 * Inputs and expected rows are spelled out literally — duplication is cheaper
 * than indirection when reading a test case.
 */

import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { renderSubagentResult } from "../src/agents/result-renderer.js";

// getMarkdownTheme() reads pi's module-global theme; without this it throws.
initTheme("dark");

/** Colour tokens are visible in the rows, so a test can assert which mark painted what. */
const THEME = {
  fg: (color: string, text: string) => `<${color}>${text}</>`,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `**${text}**`,
} as unknown as Theme;

type Case = {
  name: string;
  input: unknown;
  output: string[];
};

const CASES: Case[] = [
  {
    name: "collapsed report",
    input: `[Cowboy agent "Explore" a1 finished]

## Findings

- \`foo.ts:12\` calls **bar()**
- \`baz.ts:7\` is unused

### Notes

Some prose with \`inline code\` and **bold** text.`,
    output: [
      ' <success>✓</> <toolTitle>**[Cowboy agent "Explore" a1 finished]**</>',
      "",
      " <toolOutput>## Findings</>",
      " <toolOutput></>",
      " <toolOutput>- `foo.ts:12` calls **bar()**</>",
      " <toolOutput>- `baz.ts:7` is unused</>",
      " <muted>... (4 more lines,</> <dim>ctrl+o</> to expand<muted>)</>",
    ],
  },

  // A report that fits inside the preview has nothing to expand.
  {
    name: "report shorter than the preview",
    input: `headline\n\nline one\nline two`,
    output: [
      " <success>✓</> <toolTitle>**headline**</>",
      "",
      " <toolOutput>line one</>",
      " <toolOutput>line two</>",
    ],
  },

  // The mark comes from the headline, not the body.
  {
    name: "headline with error",
    input: `[Cowboy agent "Explore" a1 error]

boom`,
    output: [
      ' <error>✗</> <toolTitle>**[Cowboy agent "Explore" a1 error]**</>',
      "",
      " <toolOutput>boom</>",
    ],
  },
  {
    name: "headline with stopped",
    input: `[Cowboy agent "Explore" a1 stopped]

body`,
    output: [
      ' <error>✗</> <toolTitle>**[Cowboy agent "Explore" a1 stopped]**</>',
      "",
      " <toolOutput>body</>",
    ],
  },
  {
    name: "uppercase ERROR",
    input: `[Cowboy agent "Explore" a1 ERROR]

body`,
    output: [
      ' <error>✗</> <toolTitle>**[Cowboy agent "Explore" a1 ERROR]**</>',
      "",
      " <toolOutput>body</>",
    ],
  },
  {
    name: "error only in the body",
    input: `[Cowboy agent "Explore" a1 finished]

error: none found`,
    output: [
      ' <success>✓</> <toolTitle>**[Cowboy agent "Explore" a1 finished]**</>',
      "",
      " <toolOutput>error: none found</>",
    ],
  },
  {
    name: "error inside an agent name",
    input: `[Cowboy agent "ErrorBot" a1 finished]

body`,
    output: [
      ' <success>✓</> <toolTitle>**[Cowboy agent "ErrorBot" a1 finished]**</>',
      "",
      " <toolOutput>body</>",
    ],
  },

  // Missing, empty or malformed content still renders something.
  {
    name: "no separator",
    input: "just a headline",
    output: [" <success>✓</> <toolTitle>**just a headline**</>"],
  },
  {
    name: "empty report",
    input: `headline

`,
    output: [" <success>✓</> <toolTitle>**headline**</>"],
  },
  {
    name: "content is not a string",
    input: [{ type: "text", text: "hello" }],
    output: [" <success>✓</> <toolTitle>**Cowboy agent report**</>"],
  },
  {
    name: "empty content",
    input: "",
    output: [" <success>✓</> <toolTitle>**Cowboy agent report**</>"],
  },
];

const EXPANDED_CASES: Case[] = [
  {
    name: "report as markdown",
    input: `[Cowboy agent "Explore" a1 finished]

## Findings

- \`foo.ts:12\` calls **bar()**
- \`baz.ts:7\` is unused

### Notes

Some prose with \`inline code\` and **bold** text.`,
    output: [
      ' <success>✓</> <toolTitle>**[Cowboy agent "Explore" a1 finished]**</>',
      "",
      " Findings",
      "",
      " - foo.ts:12 calls bar()",
      " - baz.ts:7 is unused",
      "",
      " ### Notes",
      "",
      " Some prose with inline code and bold text.",
    ],
  },
  {
    name: "unclosed code fence",
    input: `headline

\`\`\`ts
const x = 1;`,
    output: [
      " <success>✓</> <toolTitle>**headline**</>",
      "",
      " ```ts",
      "   const x = 1;",
      " ```",
    ],
  },
  {
    name: "unclosed bold",
    input: `headline

**bold without close`,
    output: [
      " <success>✓</> <toolTitle>**headline**</>",
      "",
      " **bold without close",
    ],
  },
];

function render(content: unknown, expanded = false, outputPad = 1): string[] {
  const component = renderSubagentResult(
    { customType: "subagent-result", content } as never,
    {
      expanded,
      outputPad,
      keyHint: () => "<dim>ctrl+o</> to expand",
    } as never,
    THEME,
  );
  return component!
    .render(200)
    .map((line) => stripTerminalSequences(line).trimEnd());
}

describe("renderSubagentResult", () => {
  it.each(CASES)("$name", ({ input, output }) => {
    expect(render(input)).toEqual(output);
  });

  it.each(EXPANDED_CASES)("expanded: $name", ({ input, output }) => {
    expect(render(input, true)).toEqual(output);
  });

  it("honors outputPad", () => {
    expect(
      render(
        `headline

body`,
        false,
        2,
      ),
    ).toEqual([
      "  <success>✓</> <toolTitle>**headline**</>",
      "",
      "  <toolOutput>body</>",
    ]);
  });
});
