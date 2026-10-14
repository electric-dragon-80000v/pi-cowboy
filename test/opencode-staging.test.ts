import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { ToolSelection } from "../src/agents/harness.js";
import { opencodeAgentMarkdown } from "../src/agents/harness/opencode/definition.js";
import { opencodePermissions } from "../src/agents/harness/opencode/permissions.js";
import {
  opencodeConfigDir,
  removeOpencodeStaging,
  writeOpencodeStaging,
} from "../src/agents/harness/opencode/staging.js";

/** The subagent these tests stage under; the shape a spawn id has. */
const SUBAGENT_ID = "a1b2c3d4";

/** A multi-line prompt, so the body's line breaks are asserted and not assumed. */
const PROMPT = "You review one diff.\n\nReport defects only.\n";

/** The opening delimiter the definition starts with. */
const FRONTMATTER_START = "---\n";

/** The line that closes the frontmatter; the body follows a blank separator. */
const FRONTMATTER_END = "\n---\n";

/** The real TMPDIR, put back after every test that redirects it. */
let realTmpdir: string | undefined;

/** Temporary roots this file made; removed after every test, pass or fail. */
const madeRoots: string[] = [];

beforeEach(() => {
  realTmpdir = process.env.TMPDIR;
  const root = fs.mkdtempSync(join(tmpdir(), "cowboy-opencode-staging-"));
  madeRoots.push(root);
  process.env.TMPDIR = root;
});

afterEach(() => {
  if (realTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmpdir;
  for (const root of madeRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A staged system prompt file, in this test's temporary root. */
function stagePrompt(text: string): string {
  const dir = fs.mkdtempSync(join(tmpdir(), "cowboy-opencode-prompt-"));
  const file = join(dir, "system.md");
  fs.writeFileSync(file, text);
  return file;
}

/** A definition for one tool selection. */
function markdownFor(toolSelection: ToolSelection): string {
  return opencodeAgentMarkdown({
    subagentId: SUBAGENT_ID,
    systemPrompt: PROMPT,
    toolSelection,
  });
}

/** The definition's frontmatter, parsed, as its keys and values in file order. */
function frontmatterEntries(markdown: string): [string, unknown][] {
  const end = markdown.indexOf(FRONTMATTER_END);
  expect(end).toBeGreaterThan(-1);
  const parsed: unknown = parseYaml(
    markdown.slice(FRONTMATTER_START.length, end + 1),
  );
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("the definition's frontmatter did not parse to a mapping");
  }
  return Object.entries(parsed);
}

/** One frontmatter value, or undefined when the key is absent. */
function frontmatterValue(markdown: string, key: string): unknown {
  return frontmatterEntries(markdown).find(([name]) => name === key)?.[1];
}

/** The definition's `permissions` list, as the rules in file order. */
function permissionRules(markdown: string): unknown {
  return frontmatterValue(markdown, "permissions");
}

/** The body of a definition: everything after the closing frontmatter line. */
function body(markdown: string): string {
  const end = markdown.indexOf(FRONTMATTER_END);
  expect(end).toBeGreaterThan(-1);
  return markdown.slice(end + FRONTMATTER_END.length + 1);
}

/** The prompt the definition in `dir` carries. */
function definitionBody(dir: string): string {
  return body(
    fs.readFileSync(join(dir, "agent", `${SUBAGENT_ID}.md`), "utf-8"),
  );
}

describe("opencodeConfigDir", () => {
  it("names the config directory under the spawn's staging directory", () => {
    expect(opencodeConfigDir(SUBAGENT_ID)).toBe(
      join(tmpdir(), "pi-cowboy", SUBAGENT_ID, "opencode"),
    );
  });
});

describe("opencodePermissions", () => {
  const allow = (action: string) => ({
    action,
    resource: "*",
    effect: "allow",
  });
  const deny = (action: string) => ({ action, resource: "*", effect: "deny" });

  it("allows the catch-all and denies only questions for the default tool set", () => {
    expect(opencodePermissions({ kind: "default" })).toEqual([
      allow("*"),
      deny("question"),
    ]);
  });

  it("denies the catch-all for an empty tool set", () => {
    expect(opencodePermissions({ kind: "none" })).toEqual([deny("*")]);
  });

  it("denies the catch-all, then allows each included name", () => {
    expect(
      opencodePermissions({ kind: "include", names: ["read", "shell"] }),
    ).toEqual([deny("*"), allow("read"), allow("shell")]);
  });

  it("allows the catch-all, then denies each excluded name", () => {
    expect(
      opencodePermissions({ kind: "exclude", names: ["shell", "edit"] }),
    ).toEqual([allow("*"), deny("question"), deny("shell"), deny("edit")]);
  });

  it("keeps each name as its own rule, with no translation", () => {
    expect(
      opencodePermissions({ kind: "include", names: ["edit", "patch"] }),
    ).toEqual([deny("*"), allow("edit"), allow("patch")]);
  });

  it("passes a name opencode has no action for through as its own action", () => {
    expect(
      opencodePermissions({
        kind: "include",
        names: ["mcp__herdr__panes"],
      }),
    ).toEqual([deny("*"), allow("mcp__herdr__panes")]);
  });
});

describe("opencodeAgentMarkdown", () => {
  it("delimits the frontmatter and carries the prompt as the body, verbatim", () => {
    const markdown = markdownFor({ kind: "default" });

    expect(markdown).toBe(
      [
        "---",
        "description: cowboy-subagent-a1b2c3d4",
        "mode: primary",
        "permissions:",
        '  - action: "*"',
        '    resource: "*"',
        "    effect: allow",
        "  - action: question",
        '    resource: "*"',
        "    effect: deny",
        "---",
        "",
        PROMPT,
      ].join("\n"),
    );
  });

  it("parses back to the spawn identity and the mode opencode needs", () => {
    const markdown = markdownFor({ kind: "default" });

    expect(frontmatterEntries(markdown)).toEqual([
      ["description", `cowboy-subagent-${SUBAGENT_ID}`],
      ["mode", "primary"],
      [
        "permissions",
        [
          { action: "*", resource: "*", effect: "allow" },
          { action: "question", resource: "*", effect: "deny" },
        ],
      ],
    ]);
    expect(body(markdown)).toBe(PROMPT);
  });

  it("writes each tool selection's rules into the permission list", () => {
    expect(permissionRules(markdownFor({ kind: "none" }))).toEqual([
      { action: "*", resource: "*", effect: "deny" },
    ]);
    expect(
      permissionRules(
        markdownFor({ kind: "include", names: ["read", "edit"] }),
      ),
    ).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "allow" },
    ]);
    expect(
      permissionRules(markdownFor({ kind: "exclude", names: ["shell"] })),
    ).toEqual([
      { action: "*", resource: "*", effect: "allow" },
      { action: "question", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    ]);
  });
});

describe("writeOpencodeStaging", () => {
  it("writes the definition and nothing else", () => {
    const dir = writeOpencodeStaging({
      subagentId: SUBAGENT_ID,
      systemPromptFile: stagePrompt(PROMPT),
      toolSelection: { kind: "include", names: ["read", "edit"] },
    });

    expect(dir).toBe(opencodeConfigDir(SUBAGENT_ID));
    expect(fs.readdirSync(dir).sort()).toEqual(["agent"]);
    expect(fs.readdirSync(join(dir, "agent"))).toEqual([`${SUBAGENT_ID}.md`]);
    expect(
      fs.readFileSync(join(dir, "agent", `${SUBAGENT_ID}.md`), "utf-8"),
    ).toBe(
      opencodeAgentMarkdown({
        subagentId: SUBAGENT_ID,
        systemPrompt: PROMPT,
        toolSelection: { kind: "include", names: ["read", "edit"] },
      }),
    );
  });

  it("replaces a definition the staging tree already holds", () => {
    const dir = writeOpencodeStaging({
      subagentId: SUBAGENT_ID,
      systemPromptFile: stagePrompt("first prompt\n"),
      toolSelection: { kind: "default" },
    });

    writeOpencodeStaging({
      subagentId: SUBAGENT_ID,
      systemPromptFile: stagePrompt("second prompt\n"),
      toolSelection: { kind: "default" },
    });

    expect(definitionBody(dir)).toBe("second prompt\n");
  });

  it("creates nothing when the system prompt file cannot be read", () => {
    const missing = join(tmpdir(), "no-such-prompt.md");

    expect(() =>
      writeOpencodeStaging({
        subagentId: SUBAGENT_ID,
        systemPromptFile: missing,
        toolSelection: { kind: "default" },
      }),
    ).toThrow();
    expect(fs.existsSync(opencodeConfigDir(SUBAGENT_ID))).toBe(false);
  });
});

describe("removeOpencodeStaging", () => {
  it("removes the staging tree it wrote", () => {
    const dir = writeOpencodeStaging({
      subagentId: SUBAGENT_ID,
      systemPromptFile: stagePrompt(PROMPT),
      toolSelection: { kind: "default" },
    });
    expect(fs.existsSync(dir)).toBe(true);

    removeOpencodeStaging(SUBAGENT_ID);

    expect(fs.existsSync(dir)).toBe(false);
  });

  it("does nothing when the staging tree is already gone", () => {
    expect(fs.existsSync(opencodeConfigDir(SUBAGENT_ID))).toBe(false);

    expect(() => removeOpencodeStaging(SUBAGENT_ID)).not.toThrow();
  });
});
