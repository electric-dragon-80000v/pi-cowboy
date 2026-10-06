/** agent-discovery.test.ts — Agent template parsing and directory scanning (shape rejections: agent-template.test.ts). */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mergeAgents,
  parseAgentFile,
  scanAgentFilesInDir,
  type AgentTemplateFile,
} from "../src/agents/agent-discovery.js";
import type { AgentConfig } from "../src/agents/types.js";

describe("parseAgentFile TOML templates", () => {
  it("parses fields and preserves the prose body byte-for-byte", () => {
    const result = parseAgentFile(
      [
        'name = "reviewer"',
        "",
        "system_prompt = '''",
        "# Instructions",
        "",
        "**Be careful.**'''",
        "",
        "[harness]",
        'tools = ["read", "edit"]',
        "",
      ].join("\n"),
    );

    expect(result).toMatchObject({
      name: "reviewer",
      harness: { tools: ["read", "edit"] },
      system_prompt: "# Instructions\n\n**Be careful.**",
    });
  });

  it("leaves an absent system_prompt undefined so it inherits an earlier layer", () => {
    const parsed = parseAgentFile('name = "empty-body"');

    expect(parsed.name).toBe("empty-body");
    expect(parsed.system_prompt).toBeUndefined();
  });

  it("treats a document without keys as a nameless template", () => {
    const parsed = parseAgentFile("# just a comment\n");

    expect(parsed.name).toBeUndefined();
    expect(parsed.system_prompt).toBeUndefined();
  });

  it("reads native TOML scalars and arrays without coercion", () => {
    const result = parseAgentFile(
      [
        'name = "typed"',
        "hidden = true",
        "",
        "[harness]",
        'thinking = "high"',
        'tools = ["read", "bash"]',
      ].join("\n"),
    );

    expect(result).toMatchObject({
      name: "typed",
      hidden: true,
      harness: { thinking: "high", tools: ["read", "bash"] },
    });
  });

  it("reads the boolean|string[] filter unions", () => {
    expect(
      parseAgentFile(
        [
          'name = "filters"',
          "",
          "[harness]",
          "extensions = false",
          'skills = ["git"]',
          "inlined_skills = []",
          'exclude_tools = ["write"]',
        ].join("\n"),
      ),
    ).toMatchObject({
      harness: {
        extensions: false,
        skills: ["git"],
        inlined_skills: [],
        exclude_tools: ["write"],
      },
    });

    expect(
      parseAgentFile(
        'name = "lists"\n[harness]\nextensions = ["ext/a"]\ninlined_skills = ["git"]',
      ),
    ).toMatchObject({
      harness: { extensions: ["ext/a"], inlined_skills: ["git"] },
    });
  });

  it("normalizes CRLF line endings and tolerates a BOM", () => {
    expect(
      parseAgentFile('\uFEFFname = "crlf"\r\nhidden = true\r\n'),
    ).toMatchObject({ name: "crlf", hidden: true });
  });

  it("maps a multi-line literal prompt onto systemPrompt unchanged", () => {
    const result = parseAgentFile(
      "system_prompt = '''\nline one\n\nline two'''\n",
    );

    expect(result.system_prompt).toBe("line one\n\nline two");
  });
});

describe("mergeAgents system_prompt inheritance", () => {
  const explore: AgentTemplateFile = {
    name: "Explore",
    harness_type: "pi",
    system_prompt: "# read-only explorer",
  };

  it("keeps the earlier layer's prompt when a later override omits system_prompt", () => {
    const merged = mergeAgents(
      new Map(),
      [explore],
      [],
      [
        {
          name: "Explore",
          harness_type: "pi",
          description: "a project override",
        },
      ],
    );

    expect(merged.get("Explore")?.systemPrompt).toBe("# read-only explorer");
  });

  it("blanks an inherited prompt when an override declares an empty system_prompt", () => {
    const merged = mergeAgents(
      new Map(),
      [explore],
      [],
      [{ name: "Explore", harness_type: "pi", system_prompt: "" }],
    );

    expect(merged.get("Explore")?.systemPrompt).toBe("");
  });

  it("resolves a brand-new name with no body to an empty prompt", () => {
    const merged = mergeAgents(
      new Map(),
      [],
      [],
      [{ name: "Fresh", harness_type: "pi" }],
    );

    expect(merged.get("Fresh")?.systemPrompt).toBe("");
  });
});

describe("scanAgentFilesInDir TOML warnings", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function scanDir(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cowboy-scan-"));
    tempDirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
  }

  it("warns with the file and the parse error when the TOML is malformed", async () => {
    const dir = scanDir({
      "broken.toml": 'name = "broken"\nnope = ',
      "fine.toml": 'name = "fine"',
    });
    const notify = vi.fn();

    const agents = await scanAgentFilesInDir(dir, notify);

    expect(notify).toHaveBeenCalledTimes(1);
    const [message, kind] = notify.mock.calls[0];
    expect(kind).toBe("warning");
    expect(message).toContain("[cowboy]");
    expect(message).toContain(path.join(dir, "broken.toml"));
    expect(message).toContain("Invalid TOML document");
    expect(message).toContain("(line 2, column 8)");
    expect(message).not.toContain("\n");

    expect(agents.map((a) => a.name)).toEqual(["fine"]);
  });

  it("warns with the failing path when the schema rejects a key", async () => {
    const dir = scanDir({
      "wrong-type.toml": 'name = "wrong"\n[harness]\nmodel = 12',
    });
    const notify = vi.fn();

    const agents = await scanAgentFilesInDir(dir, notify);

    expect(agents).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
    const [message] = notify.mock.calls[0];
    expect(message).toContain(
      "harness.model: Invalid input: expected string, received number",
    );
    expect(message).not.toContain("\n");
  });

  it("stays silent for a valid file", async () => {
    const dir = scanDir({ "fine.toml": 'name = "fine"' });
    const notify = vi.fn();

    const agents = await scanAgentFilesInDir(dir, notify);

    expect(notify).not.toHaveBeenCalled();
    expect(agents.map((a) => a.name)).toEqual(["fine"]);
  });

  it("stays silent for a file that declares no name", async () => {
    const dir = scanDir({ "plain.toml": "# nothing here\n" });
    const notify = vi.fn();

    const agents = await scanAgentFilesInDir(dir, notify);

    expect(notify).not.toHaveBeenCalled();
    expect(agents).toEqual([]);
  });

  it("ignores non-TOML files in the directory", async () => {
    const dir = scanDir({
      "agent.md": "# old markdown template\n",
      "agent.toml": 'name = "toml-only"',
    });
    const notify = vi.fn();

    const agents = await scanAgentFilesInDir(dir, notify);

    expect(agents.map((a) => a.name)).toEqual(["toml-only"]);
    expect(notify).not.toHaveBeenCalled();
  });

  it.skipIf(process.getuid?.() === 0)(
    "stays silent for an unreadable file",
    async () => {
      const dir = scanDir({ "locked.toml": 'name = "locked"' });
      const locked = path.join(dir, "locked.toml");
      fs.chmodSync(locked, 0o000);
      const notify = vi.fn();

      const agents = await scanAgentFilesInDir(dir, notify);

      expect(notify).not.toHaveBeenCalled();
      expect(agents).toEqual([]);
    },
  );
});

describe("mergeAgents field inheritance", () => {
  const WITH_IDENTITY: Map<string, AgentConfig> = new Map([
    [
      "reviewer",
      {
        name: "reviewer",
        displayName: "Base Reviewer",
        description: "base description",
        model: "base-model",
        systemPrompt: "",
        harnessType: "pi",
      },
    ],
  ]);

  it("does not inherit display_name or description into a same-named override", () => {
    const user = [parseAgentFile('name = "reviewer"')];

    const merged = mergeAgents(WITH_IDENTITY, user, [], []);
    const config = merged.get("reviewer")!;

    expect(config.displayName).toBeUndefined();
    expect(config.description).toBe("");
  });

  it("keeps inheriting every other field for a same-named override", () => {
    const user = [parseAgentFile('name = "reviewer"')];

    const merged = mergeAgents(WITH_IDENTITY, user, [], []);
    const config = merged.get("reviewer")!;

    expect(config.model).toBe("base-model");
  });

  it("takes display_name and description from the layer that declares them", () => {
    const project = [
      parseAgentFile(
        'name = "reviewer"\ndisplay_name = "Project Reviewer"\ndescription = "project description"',
      ),
    ];

    const merged = mergeAgents(WITH_IDENTITY, [], [], project);
    const config = merged.get("reviewer")!;

    expect(config.displayName).toBe("Project Reviewer");
    expect(config.description).toBe("project description");
  });

  it("gives a brand-new name an empty description and no display name", () => {
    const user = [parseAgentFile('name = "fresh"')];

    const merged = mergeAgents(new Map(), user, [], []);
    const config = merged.get("fresh")!;

    expect(config.displayName).toBeUndefined();
    expect(config.description).toBe("");
  });

  it("still inherits model and tools across layers", () => {
    const user = [
      parseAgentFile(
        'name = "reviewer"\n[harness]\nmodel = "user-model"\ntools = ["read", "edit"]',
      ),
    ];
    const project = [parseAgentFile('name = "reviewer"\nhidden = true')];

    const merged = mergeAgents(new Map(), user, [], project);
    const config = merged.get("reviewer")!;

    expect(config.model).toBe("user-model");
    expect(config.tools).toEqual(["read", "edit"]);
    expect(config.hidden).toBe(true);
  });
});

describe("mergeAgents dirty-checkout inheritance", () => {
  it("maps worktree_checkout_type from a template into the config", () => {
    const merged = mergeAgents(
      new Map(),
      [
        parseAgentFile(
          'name = "clean-start"\nworktree_checkout_type = "clean"',
        ),
      ],
      [],
      [],
    );

    expect(merged.get("clean-start")?.worktreeCheckoutType).toBe("clean");
  });

  it("leaves an omitted worktree_checkout_type undefined so the global config decides", () => {
    const merged = mergeAgents(
      new Map(),
      [parseAgentFile('name = "plain"')],
      [],
      [],
    );

    expect(merged.get("plain")?.worktreeCheckoutType).toBeUndefined();
  });
});

describe("mergeAgents fork inheritance", () => {
  it("maps fork from a template into the config", () => {
    const merged = mergeAgents(
      new Map(),
      [parseAgentFile('name = "forker"\n[harness]\nfork = true')],
      [],
      [],
    );

    expect(merged.get("forker")?.fork).toBe(true);
  });

  it("lets a later layer override fork", () => {
    const user = [parseAgentFile('name = "forker"\n[harness]\nfork = true')];
    const project = [
      parseAgentFile('name = "forker"\n[harness]\nfork = false'),
    ];

    const merged = mergeAgents(new Map(), user, [], project);

    expect(merged.get("forker")?.fork).toBe(false);
  });

  it("keeps an earlier layer's fork when a later override omits it", () => {
    const user = [parseAgentFile('name = "forker"\n[harness]\nfork = true')];

    const merged = mergeAgents(
      new Map(),
      user,
      [],
      [{ name: "forker", harness_type: "pi" }],
    );

    expect(merged.get("forker")?.fork).toBe(true);
  });
});

describe("mergeAgents harness_type inheritance", () => {
  it("leaves an omitted harness_type unset so the configured default decides", () => {
    const merged = mergeAgents(
      new Map(),
      [parseAgentFile('name = "plain"')],
      [],
      [],
    );

    expect(merged.get("plain")?.harnessType).toBeUndefined();
  });

  it("carries an explicit harness_type", () => {
    const merged = mergeAgents(
      new Map(),
      [parseAgentFile('name = "swine"\nharness_type = "pig"')],
      [],
      [],
    );

    expect(merged.get("swine")?.harnessType).toBe("pig");
  });

  it("keeps an earlier layer's harness_type when a later override omits it", () => {
    const user = [parseAgentFile('name = "swine"\nharness_type = "pig"')];

    const merged = mergeAgents(new Map(), user, [], [{ name: "swine" }]);

    expect(merged.get("swine")?.harnessType).toBe("pig");
  });

  it("lets a later layer switch harness_type", () => {
    const user = [parseAgentFile('name = "swine"')];
    const project = [parseAgentFile('name = "swine"\nharness_type = "pig"')];

    const merged = mergeAgents(new Map(), user, [], project);

    expect(merged.get("swine")?.harnessType).toBe("pig");
  });

  it("rejects an unknown harness_type", () => {
    expect(() =>
      parseAgentFile('name = "swine"\nharness_type = "cow"'),
    ).toThrow();
  });
});
