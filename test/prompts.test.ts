import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "../src/prompt/prompts.js";
import type { AgentConfig } from "../src/agents/types.js";
import type { EnvInfo } from "../src/types.js";

const ENV: EnvInfo = { isGitRepo: true, branch: "main", platform: "darwin" };

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "explore",
    displayName: "Explore",
    description: "Read-only exploration of the codebase.",
    systemPrompt: "Read before you write.",
    ...overrides,
  };
}

describe("buildAgentPrompt", () => {
  it("adds no generic header in replace mode", async () => {
    const parts = await buildAgentPrompt(agent(), "/repo", ENV);

    expect(parts.prefix.startsWith("# Environment")).toBe(true);
    expect(parts.prefix).toContain("Branch: main");
    expect(parts.prefix).not.toContain("You are a Pi");
    expect(parts.prefix).not.toContain("You have been invoked");
  });

  it("renders display_name and the description on the active_agent tag", async () => {
    const parts = await buildAgentPrompt(agent(), "/repo", ENV);

    expect(parts.identity).toContain(
      '<active_agent name="explore" display_name="Explore">\nRead-only exploration of the codebase.\n</active_agent>',
    );
    expect(parts.identity).toContain(
      "<agent_instructions>\nRead before you write.\n</agent_instructions>",
    );
  });

  it("omits display_name when unset and self-closes an empty description", async () => {
    const parts = await buildAgentPrompt(
      agent({ displayName: undefined, description: "" }),
      "/repo",
      ENV,
    );

    expect(parts.identity).toContain('<active_agent name="explore"/>');
  });

  it("keeps the shared prefix ahead of the per-spawn identity", async () => {
    const parts = await buildAgentPrompt(agent(), "/repo", ENV);

    expect(parts.prefix).toContain("# Environment");
    expect(parts.identity).toContain("<active_agent");
    expect(parts.identity).not.toContain("# Environment");
    expect(parts.skills).toBe("");
  });

  it("keeps the parent prompt in inherit mode with its scaffolding stripped", async () => {
    const parts = await buildAgentPrompt(
      agent(),
      "/repo",
      ENV,
      {
        parentSystemPrompt:
          "Parent identity.\n\n<project_context>\nstale\n</project_context>\n\nCurrent date: 2026-01-01",
      },
      "inherit",
    );

    expect(parts.prefix.startsWith("Parent identity.")).toBe(true);
    expect(parts.prefix).not.toContain("stale");
    expect(parts.prefix).not.toContain("Current date");
    expect(parts.prefix).toContain("# Environment");
  });

  it("uses the custom prompt file in custom mode", async () => {
    const parts = await buildAgentPrompt(
      agent(),
      "/repo",
      ENV,
      { customSystemPrompt: "Custom rules." },
      "custom",
    );

    expect(parts.prefix.startsWith("Custom rules.")).toBe(true);
    expect(parts.prefix).toContain("# Environment");
  });

  it("keeps the project context in the prefix and the skills in their own section", async () => {
    const parts = await buildAgentPrompt(agent(), "/repo", ENV, {
      contextFiles: [{ path: "/repo/AGENTS.md", content: "Never touch main." }],
      inlinedSkills: [{ name: "s", description: "d", content: "c" }],
    });

    expect(parts.prefix).toContain("<project_context>");
    expect(parts.prefix).toContain("Never touch main.");
    expect(parts.identity).not.toContain("<project_context>");
    expect(parts.skills).toContain("<available_skills>");
  });
});
