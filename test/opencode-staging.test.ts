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

/** A definition for one tool selection; `variant` is absent unless given. */
function markdownFor(
  toolSelection: ToolSelection,
  variant: string | null = null,
): string {
  return opencodeAgentMarkdown({
    subagentId: SUBAGENT_ID,
    systemPrompt: PROMPT,
    variant,
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

/** The definition's `permission` map, as its keys and values in file order. */
function permissionEntries(markdown: string): [string, unknown][] {
  const permission: unknown = frontmatterValue(markdown, "permission");
  if (typeof permission !== "object" || permission === null) {
    throw new Error("the definition's frontmatter has no permission map");
  }
  return Object.entries(permission);
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
  it("allows the catch-all and denies only questions for the default tool set", () => {
    const permissions = opencodePermissions({ kind: "default" });

    expect(permissions).toEqual({ "*": "allow", question: "deny" });
    expect(Object.keys(permissions)).toEqual(["*", "question"]);
  });

  it("denies the catch-all for an empty tool set", () => {
    const permissions = opencodePermissions({ kind: "none" });

    expect(permissions).toEqual({ "*": "deny" });
    expect(Object.keys(permissions)).toEqual(["*"]);
  });

  it("denies the catch-all, then allows each included name", () => {
    const permissions = opencodePermissions({
      kind: "include",
      names: ["read", "bash"],
    });

    expect(permissions).toEqual({ "*": "deny", read: "allow", bash: "allow" });
    expect(Object.keys(permissions)).toEqual(["*", "read", "bash"]);
  });

  it("allows the catch-all, then denies each excluded name", () => {
    const permissions = opencodePermissions({
      kind: "exclude",
      names: ["bash", "todowrite"],
    });

    expect(permissions).toEqual({
      "*": "allow",
      question: "deny",
      bash: "deny",
      todowrite: "deny",
    });
    expect(Object.keys(permissions)).toEqual([
      "*",
      "question",
      "bash",
      "todowrite",
    ]);
  });

  it("folds write and patch into opencode's edit permission", () => {
    const included = opencodePermissions({
      kind: "include",
      names: ["write", "patch"],
    });
    expect(included).toEqual({ "*": "deny", edit: "allow" });
    expect(Object.keys(included)).toEqual(["*", "edit"]);
    expect(
      opencodePermissions({ kind: "exclude", names: ["write", "edit"] }),
    ).toEqual({ "*": "allow", question: "deny", edit: "deny" });
  });

  it("passes a name opencode has no permission for through as its own key", () => {
    const permissions = opencodePermissions({
      kind: "include",
      names: ["mcp__herdr__panes"],
    });

    expect(permissions).toEqual({
      "*": "deny",
      mcp__herdr__panes: "allow",
    });
    expect(Object.keys(permissions)).toEqual(["*", "mcp__herdr__panes"]);
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
        "permission:",
        '  "*": allow',
        "  question: deny",
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
      ["permission", { "*": "allow", question: "deny" }],
    ]);
    expect(body(markdown)).toBe(PROMPT);
  });

  it("writes each tool selection's rules into the permission block", () => {
    expect(permissionEntries(markdownFor({ kind: "none" }))).toEqual([
      ["*", "deny"],
    ]);
    expect(
      permissionEntries(
        markdownFor({ kind: "include", names: ["read", "write"] }),
      ),
    ).toEqual([
      ["*", "deny"],
      ["read", "allow"],
      ["edit", "allow"],
    ]);
    expect(
      permissionEntries(markdownFor({ kind: "exclude", names: ["bash"] })),
    ).toEqual([
      ["*", "allow"],
      ["question", "deny"],
      ["bash", "deny"],
    ]);
  });

  it("omits variant when no variant was requested", () => {
    const markdown = markdownFor({ kind: "default" });

    expect(markdown).not.toContain("variant");
    expect(frontmatterEntries(markdown).map(([key]) => key)).toEqual([
      "description",
      "mode",
      "permission",
    ]);
  });

  it("writes a plain variant bare", () => {
    const markdown = markdownFor({ kind: "default" }, "xhigh");

    expect(markdown).toContain("\nvariant: xhigh\n");
    expect(frontmatterValue(markdown, "variant")).toBe("xhigh");
  });

  it("quotes a variant that is not a plain YAML scalar", () => {
    const variant = 'needs: "quotes" # and a backslash \\';
    const markdown = markdownFor({ kind: "default" }, variant);

    expect(frontmatterValue(markdown, "variant")).toBe(variant);
    expect(body(markdown)).toBe(PROMPT);
  });

  it("escapes a variant whose only oddity is whitespace", () => {
    const markdown = markdownFor({ kind: "default" }, "two\nlines");

    expect(frontmatterValue(markdown, "variant")).toBe("two\nlines");
    expect(body(markdown)).toBe(PROMPT);
  });
});

describe("writeOpencodeStaging", () => {
  it("writes the definition, the npm seed, and nothing else", () => {
    const dir = writeOpencodeStaging({
      subagentId: SUBAGENT_ID,
      systemPromptFile: stagePrompt(PROMPT),
      variant: "xhigh",
      toolSelection: { kind: "include", names: ["read", "write"] },
    });

    expect(dir).toBe(opencodeConfigDir(SUBAGENT_ID));
    expect(fs.readdirSync(dir).sort()).toEqual([
      "agent",
      "node_modules",
      "package-lock.json",
      "package.json",
    ]);
    expect(fs.readdirSync(join(dir, "agent"))).toEqual([`${SUBAGENT_ID}.md`]);
    expect(
      fs.readFileSync(join(dir, "agent", `${SUBAGENT_ID}.md`), "utf-8"),
    ).toBe(
      opencodeAgentMarkdown({
        subagentId: SUBAGENT_ID,
        systemPrompt: PROMPT,
        variant: "xhigh",
        toolSelection: { kind: "include", names: ["read", "write"] },
      }),
    );
  });

  it("seeds an empty node_modules beside a manifest and a lock that parse", () => {
    const dir = writeOpencodeStaging({
      subagentId: SUBAGENT_ID,
      systemPromptFile: stagePrompt(PROMPT),
      variant: null,
      toolSelection: { kind: "default" },
    });

    expect(fs.existsSync(join(dir, "node_modules"))).toBe(true);
    expect(fs.readdirSync(join(dir, "node_modules"))).toEqual([]);

    const manifestText = fs.readFileSync(join(dir, "package.json"), "utf-8");
    const manifest: unknown = JSON.parse(manifestText);
    expect(manifest).toEqual({
      dependencies: { "@opencode-ai/plugin": expect.any(String) },
    });

    const lockText = fs.readFileSync(join(dir, "package-lock.json"), "utf-8");
    const lock: unknown = JSON.parse(lockText);
    expect(lock).toMatchObject({
      name: "opencode",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          dependencies: { "@opencode-ai/plugin": expect.any(String) },
        },
      },
    });

    const declared = /"@opencode-ai\/plugin": "([^"]+)"/.exec(
      manifestText,
    )?.[1];
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lockText).toContain(`"@opencode-ai/plugin": "${declared}"`);
  });

  it("replaces a definition the staging tree already holds", () => {
    const dir = writeOpencodeStaging({
      subagentId: SUBAGENT_ID,
      systemPromptFile: stagePrompt("first prompt\n"),
      variant: null,
      toolSelection: { kind: "default" },
    });

    writeOpencodeStaging({
      subagentId: SUBAGENT_ID,
      systemPromptFile: stagePrompt("second prompt\n"),
      variant: null,
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
        variant: null,
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
      variant: null,
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
