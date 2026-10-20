import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { ToolSelection } from "../src/agents/harness.js";
import type { OpencodeConfigRoot } from "../src/agents/harness/opencode/config.js";
import { opencodeAgentMarkdown } from "../src/agents/harness/opencode/definition.js";
import { opencodePermissions } from "../src/agents/harness/opencode/permissions.js";
import {
  opencodeConfigDir,
  removeOpencodeStaging,
  writeOpencodeStaging,
  type OpencodeStaging,
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

/**
 * The real OPENCODE_CONFIG_DIR, put back after every test. Staging copies the
 * parent's user config from the directory this names (or the XDG default), so
 * every test points it at an empty directory of its own: a developer's own
 * providers must not decide what the staged tree holds.
 */
let realOpencodeConfigDir: string | undefined;

/** The parent config directory this test pointed OPENCODE_CONFIG_DIR at. */
let parentConfigDir: string;

/** The real OPENCODE_CONFIG, put back after every test. */
let realOpencodeConfig: string | undefined;

beforeEach(() => {
  realTmpdir = process.env.TMPDIR;
  const root = fs.mkdtempSync(join(tmpdir(), "cowboy-opencode-staging-"));
  madeRoots.push(root);
  process.env.TMPDIR = root;
  realOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  realOpencodeConfig = process.env.OPENCODE_CONFIG;
  parentConfigDir = join(root, "parent-opencode");
  fs.mkdirSync(parentConfigDir);
  process.env.OPENCODE_CONFIG_DIR = parentConfigDir;
  delete process.env.OPENCODE_CONFIG;
});

afterEach(() => {
  if (realTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmpdir;
  if (realOpencodeConfigDir === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR;
  } else {
    process.env.OPENCODE_CONFIG_DIR = realOpencodeConfigDir;
  }
  if (realOpencodeConfig === undefined) {
    delete process.env.OPENCODE_CONFIG;
  } else {
    process.env.OPENCODE_CONFIG = realOpencodeConfig;
  }
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
  it("writes the definition, for a parent without user config", () => {
    const { configDir: dir } = writeOpencodeStaging({
      subagentId: SUBAGENT_ID,
      systemPromptFile: stagePrompt(PROMPT),
      toolSelection: { kind: "include", names: ["read", "edit"] },
      configInclude: [],
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
    const { configDir: dir } = writeOpencodeStaging({
      subagentId: SUBAGENT_ID,
      systemPromptFile: stagePrompt("first prompt\n"),
      toolSelection: { kind: "default" },
      configInclude: [],
    });

    writeOpencodeStaging({
      subagentId: SUBAGENT_ID,
      systemPromptFile: stagePrompt("second prompt\n"),
      toolSelection: { kind: "default" },
      configInclude: [],
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
        configInclude: [],
      }),
    ).toThrow();
    expect(fs.existsSync(opencodeConfigDir(SUBAGENT_ID))).toBe(false);
  });
});

describe("writeOpencodeStaging — the parent's user config", () => {
  /** A parent config with kept and excluded roots, and a file reference. */
  const USER_CONFIG = JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      provider: {
        anthropic: { options: { apiKey: "{file:./key.txt}" } },
      },
      model: "anthropic/claude-opus-4",
      mcp: { parent: { type: "remote", url: "https://example.test/mcp" } },
      plugin: ["parent-plugin"],
      instructions: ["AGENTS.md"],
      permission: { edit: "allow" },
      tools: { bash: false },
      agent: { parentOnly: {} },
      agents: {
        reviewer: { model: "anthropic/claude-opus-4" },
        parentOnly: { model: "anthropic/claude-opus-4" },
      },
      experimental: {
        subagent_depth: 2,
        policies: ["parent-policy"],
      },
      update: "auto",
    },
    null,
    2,
  );

  /** Stage the default definition. */
  function stageTree(
    configInclude: readonly OpencodeConfigRoot[] = [],
  ): OpencodeStaging {
    return writeOpencodeStaging({
      subagentId: SUBAGENT_ID,
      systemPromptFile: stagePrompt(PROMPT),
      toolSelection: { kind: "default" },
      configInclude,
    });
  }

  /** Stage the default definition and return the config dir. */
  function stage(configInclude: readonly OpencodeConfigRoot[] = []): string {
    return stageTree(configInclude).configDir;
  }

  /** The staged config file, parsed. */
  function stagedConfig(dir: string, name = "opencode.json"): unknown {
    return JSON.parse(fs.readFileSync(join(dir, name), "utf-8"));
  }

  it("copies the parent's opencode.json with the excluded roots removed", () => {
    const parentFile = join(parentConfigDir, "opencode.json");
    fs.writeFileSync(parentFile, USER_CONFIG);

    const dir = stage();

    // A copy, not a link: the parent's file is never written through.
    const copied = join(dir, "opencode.json");
    expect(fs.lstatSync(copied).isSymbolicLink()).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(["agent", "opencode.json"]);
    const config = stagedConfig(dir) as Record<string, unknown>;
    expect(config.provider).toEqual({
      anthropic: {
        options: { apiKey: `{file:${join(parentConfigDir, "key.txt")}}` },
      },
    });
    expect(config.model).toBe("anthropic/claude-opus-4");
    expect(config).not.toHaveProperty("$schema");
    // MCP servers are the parent's tools: copied without being asked for.
    expect(config.mcp).toEqual({
      parent: { type: "remote", url: "https://example.test/mcp" },
    });
    expect(config).not.toHaveProperty("plugin");
    expect(config).not.toHaveProperty("instructions");
    expect(config).not.toHaveProperty("permission");
    expect(config).not.toHaveProperty("tools");
    expect(config).not.toHaveProperty("agent");
    expect(config).not.toHaveProperty("agents");
    expect(config).not.toHaveProperty("experimental");
    expect(config).not.toHaveProperty("update");
    expect(fs.readFileSync(parentFile, "utf-8")).toBe(USER_CONFIG);
  });

  it("copies the parent's opencode.jsonc, comments and trailing commas included", () => {
    const parentFile = join(parentConfigDir, "opencode.jsonc");
    fs.writeFileSync(
      parentFile,
      `{\n  // the provider the parent uses\n  "provider": { "anthropic": {} },\n  "model": "anthropic/claude-opus-4",\n}\n`,
    );

    const dir = stage();

    expect(fs.readdirSync(dir).sort()).toEqual(["agent", "opencode.jsonc"]);
    expect(stagedConfig(dir, "opencode.jsonc")).toEqual({
      provider: { anthropic: {} },
      model: "anthropic/claude-opus-4",
    });
  });

  it("writes no config file when the parent has none", () => {
    const dir = stage();

    expect(fs.readdirSync(dir).sort()).toEqual(["agent"]);
  });

  it("copies only the user config, never the rest of the parent's directory", () => {
    fs.writeFileSync(join(parentConfigDir, "opencode.json"), USER_CONFIG);
    fs.mkdirSync(join(parentConfigDir, "agent"));
    fs.writeFileSync(join(parentConfigDir, "agent", "mine.md"), "parent's\n");
    fs.writeFileSync(join(parentConfigDir, "auth.json"), "{}\n");

    const dir = stage();

    expect(fs.readdirSync(dir).sort()).toEqual(["agent", "opencode.json"]);
    expect(fs.readdirSync(join(dir, "agent"))).toEqual([`${SUBAGENT_ID}.md`]);
    expect(fs.existsSync(join(dir, "auth.json"))).toBe(false);
  });

  it("falls back to the XDG config home when OPENCODE_CONFIG_DIR is unset", () => {
    const xdgConfigHome = join(tmpdir(), "xdg-config");
    fs.mkdirSync(join(xdgConfigHome, "opencode"), { recursive: true });
    const parentFile = join(xdgConfigHome, "opencode", "opencode.json");
    fs.writeFileSync(
      parentFile,
      JSON.stringify({ provider: { anthropic: {} } }),
    );
    const realXdgConfigHome = process.env.XDG_CONFIG_HOME;
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    try {
      const dir = stage();

      expect(stagedConfig(dir)).toEqual({ provider: { anthropic: {} } });
    } finally {
      if (realXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = realXdgConfigHome;
    }
  });

  it("replaces the copy a previous call made", () => {
    fs.writeFileSync(
      join(parentConfigDir, "opencode.json"),
      JSON.stringify({ provider: { first: {} } }),
    );
    stage();

    // The parent moved its config dir between the two stagings.
    const movedDir = join(tmpdir(), "moved-opencode");
    fs.mkdirSync(movedDir);
    fs.writeFileSync(
      join(movedDir, "opencode.json"),
      JSON.stringify({ provider: { moved: {} } }),
    );
    process.env.OPENCODE_CONFIG_DIR = movedDir;
    const dir = stage();

    expect(stagedConfig(dir)).toEqual({ provider: { moved: {} } });
  });

  it("copies an excluded root whole when configInclude names it", () => {
    fs.writeFileSync(join(parentConfigDir, "opencode.json"), USER_CONFIG);

    const dir = stage(["plugin"]);
    const config = stagedConfig(dir) as Record<string, unknown>;

    expect(config.plugin).toEqual(["parent-plugin"]);
    expect(config).not.toHaveProperty("instructions");
    expect(config).not.toHaveProperty("experimental");
  });

  it("stages the config and the explicit file owner-only", () => {
    fs.writeFileSync(join(parentConfigDir, "opencode.json"), USER_CONFIG);
    const explicitFile = join(parentConfigDir, "..", "explicit.json");
    fs.writeFileSync(explicitFile, JSON.stringify({ provider: {} }));
    process.env.OPENCODE_CONFIG = explicitFile;

    const { configDir: dir, explicitConfigFile: staged } = stageTree();

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(join(dir, "opencode.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(staged as string).mode & 0o777).toBe(0o600);
  });

  it("stages the file OPENCODE_CONFIG names, filtered like the config directory", () => {
    const sourceDir = join(parentConfigDir, "..", "dotfiles");
    fs.mkdirSync(sourceDir, { recursive: true });
    const sourceFile = join(sourceDir, "dotfiles.json");
    fs.writeFileSync(
      sourceFile,
      JSON.stringify({
        provider: { anthropic: {} },
        instructions: ["AGENTS.md"],
        plugin: ["parent-plugin"],
      }),
    );
    process.env.OPENCODE_CONFIG = sourceFile;

    const { configDir: dir, explicitConfigFile: stagedFile } = stageTree();

    expect(stagedFile).toBe(join(dir, "explicit-config.json"));
    expect(JSON.parse(fs.readFileSync(stagedFile as string, "utf-8"))).toEqual({
      provider: { anthropic: {} },
    });
  });

  it("stages the config directory and the explicit file side by side", () => {
    fs.writeFileSync(
      join(parentConfigDir, "opencode.json"),
      JSON.stringify({ model: "anthropic/claude-opus-4" }),
    );
    const explicitFile = join(parentConfigDir, "..", "explicit.json");
    fs.writeFileSync(
      explicitFile,
      JSON.stringify({ provider: { anthropic: {} } }),
    );
    process.env.OPENCODE_CONFIG = explicitFile;

    const { configDir: dir, explicitConfigFile } = stageTree();

    expect(stagedConfig(dir)).toEqual({ model: "anthropic/claude-opus-4" });
    expect(
      JSON.parse(fs.readFileSync(explicitConfigFile as string, "utf-8")),
    ).toEqual({ provider: { anthropic: {} } });
  });

  it("writes no explicit config when OPENCODE_CONFIG names a missing file", () => {
    process.env.OPENCODE_CONFIG = join(
      parentConfigDir,
      "..",
      "no-such-explicit-config.json",
    );

    expect(stageTree().explicitConfigFile).toBeUndefined();
  });

  it("removes the copy and leaves the parent's file in place", () => {
    const parentFile = join(parentConfigDir, "opencode.json");
    fs.writeFileSync(parentFile, USER_CONFIG);
    const dir = stage();

    removeOpencodeStaging(SUBAGENT_ID);

    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readFileSync(parentFile, "utf-8")).toBe(USER_CONFIG);
  });
});

describe("removeOpencodeStaging", () => {
  it("removes the staging tree it wrote", () => {
    const { configDir: dir } = writeOpencodeStaging({
      subagentId: SUBAGENT_ID,
      systemPromptFile: stagePrompt(PROMPT),
      toolSelection: { kind: "default" },
      configInclude: [],
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
