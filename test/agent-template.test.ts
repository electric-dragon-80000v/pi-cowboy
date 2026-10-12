/** agent-template.test.ts — AgentTemplateSchema shape rules and the shipped `Explore` template. Rejections pin the one-line message the skip warning shows. */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseAgentFile,
  scanAgentFilesInDir,
} from "../src/agents/agent-discovery.js";
import { EXTENSION_AGENTS_DIR } from "../src/paths.js";
import { describeParseError } from "../src/templates/template-files.js";

function parseError(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return describeParseError(err);
  }
  throw new Error("expected the template to be rejected");
}

describe("AgentTemplateSchema rejections", () => {
  it("rejects an unknown key instead of ignoring it", () => {
    expect(parseError(() => parseAgentFile('name = "x"\nnope = 1'))).toBe(
      'Unrecognized key: "nope"',
    );
  });

  it("rejects a wrongly-typed value, naming the key", () => {
    expect(
      parseError(() => parseAgentFile('name = "x"\n[harness]\nmodel = 12')),
    ).toBe("harness.model: Invalid input: expected string, received number");
    expect(
      parseError(() => parseAgentFile('name = "x"\nhidden = "true"')),
    ).toBe("hidden: Invalid input: expected boolean, received string");
  });

  it("rejects inlined_skills = false; an empty list says the same thing", () => {
    expect(
      parseError(() =>
        parseAgentFile('name = "x"\n[harness]\ninlined_skills = false'),
      ),
    ).toContain("harness.inlined_skills");
  });

  it("rejects max_tokens as an unknown key", () => {
    expect(
      parseError(() => parseAgentFile('name = "x"\nmax_tokens = 8192')),
    ).toBe('Unrecognized key: "max_tokens"');
  });

  it("rejects the old comma-list spelling for a list field", () => {
    expect(
      parseError(() =>
        parseAgentFile('name = "x"\n[harness]\ntools = "read, edit"'),
      ),
    ).toBe("harness.tools: Invalid input: expected array, received string");
  });

  it("rejects a thinking level outside the enum", () => {
    expect(
      parseError(() =>
        parseAgentFile('name = "x"\n[harness]\nthinking = "hihg"'),
      ),
    ).toMatch(/^harness\.thinking: Invalid option: expected one of /);
  });

  it("rejects a table that is not part of the agent format", () => {
    expect(
      parseError(() => parseAgentFile('name = "x"\n\n[cues]\nspawned = "s"')),
    ).toBe('Unrecognized key: "cues"');
  });

  it("rejects an unknown key inside the harness table", () => {
    expect(
      parseError(() => parseAgentFile('name = "x"\n[harness]\npython = true')),
    ).toBe('harness: Unrecognized key: "python"');
  });

  it("rejects exclude_extensions, which pi cannot honor", () => {
    expect(
      parseError(() =>
        parseAgentFile('name = "x"\n[harness]\nexclude_extensions = ["ext/a"]'),
      ),
    ).toBe('harness: Unrecognized key: "exclude_extensions"');
  });

  it("rejects include_system_prompt, which the global mode now decides", () => {
    expect(
      parseError(() =>
        parseAgentFile('name = "x"\ninclude_system_prompt = true'),
      ),
    ).toBe('Unrecognized key: "include_system_prompt"');
  });

  it("rejects malformed TOML with its position", () => {
    expect(parseError(() => parseAgentFile('name = "x"\nhidden = '))).toBe(
      "Invalid TOML document: invalid value (line 2, column 10)",
    );
  });
});

describe("AgentTemplateSchema harness family split", () => {
  it("reads the family-neutral key from [harness]", () => {
    const parsed = parseAgentFile(
      ['name = "x"', "[harness]", "include_context_files = false"].join("\n"),
    );

    expect(parsed.harness).toMatchObject({
      include_context_files: false,
    });
  });

  it("files the flat tools under the pi family", () => {
    const parsed = parseAgentFile(
      ['name = "x"', "[harness]", 'tools = ["read", "edit"]'].join("\n"),
    );

    expect(parsed.harness?.toolsByFamily).toEqual({
      pi: { tools: ["read", "edit"] },
    });
  });

  it("files the flat model under the pi family", () => {
    const parsed = parseAgentFile(
      ['name = "x"', "[harness]", 'model = "anthropic/claude-sonnet-4"'].join(
        "\n",
      ),
    );

    expect(parsed.harness?.modelsByFamily).toEqual({
      pi: "anthropic/claude-sonnet-4",
    });
  });

  it("reads model from [harness.pi] as the pi family's spelling", () => {
    const parsed = parseAgentFile(
      ['name = "x"', "[harness.pi]", 'model = "pi/model"'].join("\n"),
    );

    expect(parsed.harness?.modelsByFamily).toEqual({ pi: "pi/model" });
  });

  it("lets an explicit [harness.pi] model win over its flat twin", () => {
    const parsed = parseAgentFile(
      [
        'name = "x"',
        "[harness]",
        'model = "flat/model"',
        "[harness.pi]",
        'model = "pi/model"',
      ].join("\n"),
    );

    expect(parsed.harness?.modelsByFamily).toEqual({ pi: "pi/model" });
  });

  it("reads model from [harness.opencode] into that family's entry alone", () => {
    const parsed = parseAgentFile(
      ['name = "x"', "[harness.opencode]", 'model = "oc/model"'].join("\n"),
    );

    expect(parsed.harness?.modelsByFamily).toEqual({ opencode: "oc/model" });
  });

  it("keeps the two families' models apart", () => {
    const parsed = parseAgentFile(
      [
        'name = "x"',
        "[harness]",
        'model = "pi/model"',
        "[harness.opencode]",
        'model = "oc/model"',
      ].join("\n"),
    );

    expect(parsed.harness?.modelsByFamily).toEqual({
      pi: "pi/model",
      opencode: "oc/model",
    });
  });

  it("leaves modelsByFamily undefined when the template names no model", () => {
    expect(
      parseAgentFile('name = "x"').harness?.modelsByFamily,
    ).toBeUndefined();
  });

  it("leaves toolsByFamily undefined when the template names no tools", () => {
    expect(parseAgentFile('name = "x"').harness?.toolsByFamily).toBeUndefined();
    expect(
      parseAgentFile(['name = "x"', "[harness]", 'model = "m"'].join("\n"))
        .harness?.toolsByFamily,
    ).toBeUndefined();
  });

  it("reads pi-only keys from [harness.pi]", () => {
    const parsed = parseAgentFile(
      [
        'name = "x"',
        "[harness.pi]",
        'thinking = "high"',
        "fork = true",
        "skills = false",
        'inlined_skills = ["git"]',
      ].join("\n"),
    );

    expect(parsed.harness).toMatchObject({
      thinking: "high",
      fork: true,
      skills: false,
      inlined_skills: ["git"],
    });
  });

  it("loads a legacy flat pi-only template as the [harness.pi] slice", () => {
    const parsed = parseAgentFile(
      [
        'name = "legacy"',
        "[harness]",
        'thinking = "low"',
        "fork = true",
        'tools = ["read"]',
      ].join("\n"),
    );

    expect(parsed.harness).toMatchObject({
      thinking: "low",
      fork: true,
      toolsByFamily: { pi: { tools: ["read"] } },
    });
  });

  it("lets an explicit [harness.pi] value win over its flat twin", () => {
    const parsed = parseAgentFile(
      [
        'name = "x"',
        "[harness]",
        'thinking = "low"',
        "fork = true",
        'tools = ["read"]',
        'exclude_tools = ["write"]',
        "[harness.pi]",
        'thinking = "high"',
        'tools = ["bash"]',
      ].join("\n"),
    );

    expect(parsed.harness).toMatchObject({ thinking: "high", fork: true });
    // The explicit pi tools win per key over the flat tools, and the whitelist
    // then wins over the flat exclude_tools arm.
    expect(parsed.harness?.toolsByFamily).toEqual({
      pi: { tools: ["bash"] },
    });
  });

  it("merges the flat and nested pi slices field by field", () => {
    const parsed = parseAgentFile(
      [
        'name = "x"',
        "[harness]",
        "skills = false",
        "[harness.pi]",
        "fork = true",
      ].join("\n"),
    );

    expect(parsed.harness).toMatchObject({ skills: false, fork: true });
  });

  it("reads opencode-only keys from [harness.opencode]", () => {
    const parsed = parseAgentFile(
      ['name = "x"', "[harness.opencode]", 'variant = "high"'].join("\n"),
    );

    expect(parsed.harness).toMatchObject({ variant: "high" });
  });

  it("reads opencode tool arms into that family's entry alone, whitelist winning", () => {
    const parsed = parseAgentFile(
      [
        'name = "x"',
        "[harness]",
        'tools = ["read", "find"]',
        "[harness.opencode]",
        'tools = ["read", "glob"]',
        'exclude_tools = ["write"]',
      ].join("\n"),
    );

    expect(parsed.harness?.toolsByFamily).toEqual({
      pi: { tools: ["read", "find"] },
      opencode: { tools: ["read", "glob"] },
    });
  });

  it("merges the opencode slice with the family-neutral and pi slices field by field", () => {
    const parsed = parseAgentFile(
      [
        'name = "x"',
        "[harness]",
        'model = "anthropic/claude-sonnet-4"',
        'thinking = "low"',
        'exclude_tools = ["write"]',
        "[harness.opencode]",
        'variant = "max"',
      ].join("\n"),
    );

    expect(parsed.harness).toMatchObject({
      modelsByFamily: { pi: "anthropic/claude-sonnet-4" },
      thinking: "low",
      variant: "max",
      toolsByFamily: { pi: { excludeTools: ["write"] } },
    });
  });

  it("leaves variant undefined when the template omits it", () => {
    expect(parseAgentFile('name = "x"').harness?.variant).toBeUndefined();
  });

  it("rejects variant under the flat [harness] table and inside [harness.pi]", () => {
    expect(
      parseError(() =>
        parseAgentFile('name = "x"\n[harness]\nvariant = "high"'),
      ),
    ).toBe('harness: Unrecognized key: "variant"');
    expect(
      parseError(() =>
        parseAgentFile('name = "x"\n[harness.pi]\nvariant = "high"'),
      ),
    ).toBe('harness.pi: Unrecognized key: "variant"');
  });

  it("rejects an unknown [harness.<family>] table", () => {
    expect(
      parseError(() =>
        parseAgentFile('name = "x"\n[harness.codex]\nmodel = 1'),
      ),
    ).toBe('harness: Unrecognized key: "codex"');
  });

  it("rejects an unknown key inside [harness.pi]", () => {
    expect(
      parseError(() =>
        parseAgentFile('name = "x"\n[harness.pi]\npython = true'),
      ),
    ).toBe('harness.pi: Unrecognized key: "python"');
  });

  it("rejects an unknown key inside [harness.opencode]", () => {
    expect(
      parseError(() =>
        parseAgentFile('name = "x"\n[harness.opencode]\npython = true'),
      ),
    ).toBe('harness.opencode: Unrecognized key: "python"');
  });

  it("rejects a wrongly-typed model inside [harness.opencode], naming the key", () => {
    expect(
      parseError(() =>
        parseAgentFile('name = "x"\n[harness.opencode]\nmodel = 12'),
      ),
    ).toBe(
      "harness.opencode.model: Invalid input: expected string, received number",
    );
  });

  it("rejects a pi-only key inside the opencode table", () => {
    expect(
      parseError(() =>
        parseAgentFile('name = "x"\n[harness.opencode]\nthinking = "high"'),
      ),
    ).toBe('harness.opencode: Unrecognized key: "thinking"');
  });
});

describe("AgentTemplateSchema fork flag", () => {
  it("parses fork = true and fork = false", () => {
    expect(
      parseAgentFile('name = "x"\n[harness]\nfork = true').harness?.fork,
    ).toBe(true);
    expect(
      parseAgentFile('name = "x"\n[harness]\nfork = false').harness?.fork,
    ).toBe(false);
  });

  it("leaves fork undefined when the template omits it", () => {
    expect(parseAgentFile('name = "x"').harness?.fork).toBeUndefined();
  });

  it("rejects a non-boolean fork, naming the key", () => {
    expect(
      parseError(() => parseAgentFile('name = "x"\n[harness]\nfork = "yes"')),
    ).toBe("harness.fork: Invalid input: expected boolean, received string");
  });
});

describe("AgentTemplateSchema worktree_checkout_type", () => {
  it("parses every valid policy", () => {
    expect(
      parseAgentFile('name = "x"\nworktree_checkout_type = "dirty"')
        .worktree_checkout_type,
    ).toBe("dirty");
    expect(
      parseAgentFile('name = "x"\nworktree_checkout_type = "clean"')
        .worktree_checkout_type,
    ).toBe("clean");
  });

  it("leaves the override undefined when the template omits it", () => {
    expect(parseAgentFile('name = "x"').worktree_checkout_type).toBeUndefined();
  });

  it("rejects a policy outside the union, naming the key", () => {
    expect(
      parseError(() =>
        parseAgentFile('name = "x"\nworktree_checkout_type = "seed"'),
      ),
    ).toMatch(/^worktree_checkout_type: Invalid option: expected one of /);
  });
});

describe("the shipped Explore agent template", () => {
  function readShipped(): string {
    return fs.readFileSync(
      path.join(EXTENSION_AGENTS_DIR, "explore.toml"),
      "utf-8",
    );
  }

  it("is discovered in the extension directory without warnings", async () => {
    const notify = vi.fn();

    const found = await scanAgentFilesInDir(EXTENSION_AGENTS_DIR, notify);

    expect(found.map((a) => a.name)).toContain("Explore");
    expect(notify).not.toHaveBeenCalled();
  });

  it("parses into its declared fields", () => {
    const parsed = parseAgentFile(readShipped());

    expect(parsed.name).toBe("Explore");
    expect(parsed.display_name).toBe("Explore");
    expect(parsed.description).toBe(
      "Fast codebase exploration agent (read-only)",
    );
    expect(parsed.harness?.toolsByFamily).toEqual({
      pi: { tools: ["read", "bash", "grep", "find"] },
    });
    expect(parsed.harness?.toolsByFamily).not.toHaveProperty("opencode");
  });

  it("keeps its prompt byte-identical, with no added trailing newline", () => {
    const { system_prompt: prompt } = parseAgentFile(readShipped());

    expect(prompt).toBeDefined();
    expect(
      prompt?.startsWith(
        "# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS\n\nYou are a file search specialist.",
      ),
    ).toBe(true);
    expect(prompt?.endsWith("- Be thorough and precise")).toBe(true);
    expect(prompt?.endsWith("\n")).toBe(false);
  });
});
