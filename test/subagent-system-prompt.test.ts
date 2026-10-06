import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedAgentConfig } from "../src/agents/agent-types.js";
import type { AgentConfig } from "../src/agents/types.js";
import { EXTENSION_NAME } from "../src/paths.js";
import {
  buildSubagentSystemPrompt,
  type SubagentSystemPromptOptions,
} from "../src/prompt/subagent-system-prompt.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

const PARENT_PROMPT = "Parent identity.";

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "reviewer",
    displayName: "Reviewer",
    description: "Reviews diffs for regressions.",
    systemPrompt: "Read the diff before you comment.",
    ...overrides,
  };
}

function makeConfig(
  overrides: Partial<ResolvedAgentConfig> = {},
): ResolvedAgentConfig {
  return {
    displayName: "Reviewer",
    description: "Reviews diffs for regressions.",
    skills: false,
    extensions: false,
    ...overrides,
  };
}

/** A pi whose git probes answer the given repo/branch facts. */
function fakePi(
  env: { isGitRepo: boolean; branch: string | null } = {
    isGitRepo: true,
    branch: "cow-review-a1",
  },
): ExtensionAPI {
  return {
    exec: vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse") {
        return {
          code: env.isGitRepo ? 0 : 1,
          stdout: env.isGitRepo ? "true\n" : "",
        };
      }
      return {
        code: env.isGitRepo && env.branch ? 0 : 1,
        stdout: env.branch ? `${env.branch}\n` : "",
      };
    }),
  } as unknown as ExtensionAPI;
}

function fakeCtx(getSystemPrompt: () => string = () => PARENT_PROMPT) {
  return {
    cwd: "/repo",
    getSystemPrompt,
    ui: { notify: vi.fn() },
  } as unknown as ExtensionContext;
}

function baseOptions(
  overrides: Partial<SubagentSystemPromptOptions> = {},
): SubagentSystemPromptOptions {
  return {
    pi: fakePi(),
    ctx: fakeCtx(),
    type: "reviewer",
    agentConfig: makeAgent(),
    config: makeConfig(),
    cwd: "/repo",
    globalSystemPromptMode: "replace",
    globalIncludeContextFiles: false,
    worktreePath: "/worktrees/cow-review-a1",
    expectedBranch: "cow-review-a1",
    resultFile: "/tmp/pi-cowboy/spawn-1/result.md",
    notify: vi.fn(),
    ...overrides,
  };
}

async function build(options: Partial<SubagentSystemPromptOptions> = {}) {
  const notify = options.notify ?? vi.fn();
  const prompt = await buildSubagentSystemPrompt(
    baseOptions({ ...options, notify }),
  );
  return { prompt, notify };
}

function expectSectionOrder(prompt: string, ...markers: string[]): void {
  const indices = markers.map((marker) => prompt.indexOf(marker));
  const missing = markers.filter((_, index) => indices[index] === -1);
  expect(missing).toEqual([]);
  expect(indices).toEqual([...indices].sort((a, b) => a - b));
}

/** Stage files in a temp agent dir and point the extension dir at it. */
function stagePromptFiles(files: Record<string, string>): string {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cowboy-prompt-"));
  tempDirs.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const extensionDir = path.join(agentDir, EXTENSION_NAME);
  fs.mkdirSync(extensionDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(extensionDir, name), content);
  }
  return extensionDir;
}

describe("buildSubagentSystemPrompt composition", () => {
  it("orders environment, identity, skills, branch, steering, deliverable, guidance", async () => {
    const { prompt } = await build({
      agentConfig: makeAgent({ inlinedSkills: ["missing-skill"] }),
      agentGuidance: "Review your own diff before committing.",
    });

    expectSectionOrder(
      prompt,
      "# Environment",
      "<active_agent",
      "<available_skills>",
      "## Worktree branch",
      "## Steering & Mid-Run Instructions",
      "When you have completed the task",
      "## Orchestrator Guidance",
    );
  });

  it("reports the working directory and the detected branch in the environment block", async () => {
    const { prompt } = await build();

    expect(prompt.startsWith("# Environment")).toBe(true);
    expect(prompt).toContain("Working directory: /repo");
    expect(prompt).toContain("Git repository: yes");
    expect(prompt).toContain("Branch: cow-review-a1");
  });

  it("reports the absence of a git repository", async () => {
    const { prompt } = await build({
      pi: fakePi({ isGitRepo: false, branch: null }),
      worktreePath: undefined,
    });

    expect(prompt).toContain("Not a git repository");
    expect(prompt).not.toContain("## Worktree branch");
  });

  it("omits the skills block when the spawn configures none", async () => {
    const { prompt } = await build();

    expect(prompt).not.toContain("<available_skills>");
  });

  it("adds no generic subagent boilerplate in replace mode", async () => {
    const { prompt } = await build();

    expect(prompt).not.toContain("You are a Pi");
    expect(prompt).not.toContain("You have been invoked");
  });
});

describe("buildSubagentSystemPrompt spawn contract", () => {
  it("names the detected branch in the worktree section", async () => {
    const { prompt } = await build();

    expect(prompt).toContain("## Worktree branch");
    expect(prompt).toContain("`cow-review-a1`");
    expect(prompt).toContain("Do NOT switch branches");
    expect(prompt).toContain("merge_cowboy_branch");
  });

  it("falls back to the expected branch when detection failed", async () => {
    const { prompt } = await build({
      pi: fakePi({ isGitRepo: true, branch: null }),
      expectedBranch: "cow-pinned-b2",
    });

    expect(prompt).toContain("`cow-pinned-b2`");
  });

  it("drops the worktree section entirely without a worktree", async () => {
    const { prompt } = await build({ worktreePath: undefined });

    expect(prompt).not.toContain("## Worktree branch");
  });

  it("tells the subagent where to write the deliverable", async () => {
    const { prompt } = await build();

    expect(prompt).toContain(
      "When you have completed the task, write your complete final response verbatim to the file:",
    );
    expect(prompt).toContain("/tmp/pi-cowboy/spawn-1/result.md");
    expect(prompt).toContain(
      "Write the full final answer as Markdown to that file, then reply with a one-line confirmation. The parent session reads that file as your deliverable.",
    );
  });

  it("makes mid-run steering outrank the original prompt and require disclosure", async () => {
    const { prompt } = await build();

    expect(prompt).toContain("## Steering & Mid-Run Instructions");
    expect(prompt).toContain(
      "higher priority than your original initial prompt",
    );
    expect(prompt).toContain(
      "you MUST explicitly disclose any steering or direction changes",
    );
  });

  it("renders the orchestrator's guidance verbatim as the final section", async () => {
    const guidance = "  Review your own diff before committing.  ";
    const { prompt } = await build({ agentGuidance: guidance });

    expect(prompt.endsWith(guidance)).toBe(true);
    expect(prompt.indexOf("<active_agent")).toBeLessThan(
      prompt.indexOf("## Orchestrator Guidance"),
    );
    expect(prompt.indexOf("When you have completed the task")).toBeLessThan(
      prompt.indexOf("## Orchestrator Guidance"),
    );
  });

  it("adds no guidance section when the template authored none", async () => {
    const { prompt } = await build();

    expect(prompt).not.toContain("## Orchestrator Guidance");
  });
});

describe("buildSubagentSystemPrompt prompt sources", () => {
  it("uses the parent prompt in inherit mode with its scaffolding stripped", async () => {
    const { prompt } = await build({
      globalSystemPromptMode: "inherit",
      ctx: fakeCtx(
        () =>
          `${PARENT_PROMPT}\n\n<project_context>\nstale\n</project_context>\n\nCurrent date: 2026-01-01`,
      ),
    });

    expect(prompt.startsWith(PARENT_PROMPT)).toBe(true);
    expect(prompt).not.toContain("stale");
    expect(prompt).not.toContain("Current date");
    expect(prompt).toContain("# Environment");
  });

  it("warns and keeps building when the parent prompt is unavailable", async () => {
    const { prompt, notify } = await build({
      globalSystemPromptMode: "inherit",
      ctx: fakeCtx(() => {
        throw new Error("no parent session");
      }),
    });

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Failed to get parent system prompt"),
    );
    expect(prompt.startsWith("# Environment")).toBe(true);
  });

  it("reads the custom prompt file in custom mode", async () => {
    stagePromptFiles({ "prompt.md": "Custom rules.\n" });

    const { prompt } = await build({ globalSystemPromptMode: "custom" });

    expect(prompt.startsWith("Custom rules.")).toBe(true);
    expect(prompt).toContain("# Environment");
  });

  it("warns and falls back when the custom prompt file is empty", async () => {
    stagePromptFiles({ "prompt.md": "   \n" });

    const { prompt, notify } = await build({
      globalSystemPromptMode: "custom",
    });

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Custom prompt file is empty"),
    );
    expect(prompt.startsWith("# Environment")).toBe(true);
  });

  it("warns and falls back when the custom prompt file is missing", async () => {
    stagePromptFiles({});

    const { prompt, notify } = await build({
      globalSystemPromptMode: "custom",
    });

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Custom prompt file not found"),
    );
    expect(prompt.startsWith("# Environment")).toBe(true);
  });

  it("lets an agent's include_context_files override the global setting", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cowboy-prompt-ctx-"));
    tempDirs.push(cwd);
    fs.writeFileSync(
      path.join(cwd, "AGENTS.md"),
      "# Repo rules\n\nNever merge into main.\n",
    );

    const withContext = await build({
      cwd,
      agentConfig: makeAgent({ includeContextFiles: true }),
    });
    const withoutContext = await build({ cwd });

    expect(withContext.prompt).toContain("<project_context>");
    expect(withContext.prompt).toContain("Never merge into main.");
    expect(withoutContext.prompt).not.toContain("<project_context>");
  });
});
