/** prompts.ts — System prompt builder for agents. Every agent gets a fresh context — no inherited parent identity. */

import {
  formatSkillsForPrompt,
  type Skill,
  type SourceInfo,
} from "@earendil-works/pi-coding-agent";
import type { EnvInfo } from "../types.js";
import type { AgentConfig, SystemPromptMode } from "../agents/types.js";
import type { SkillMeta, InlinedSkill } from "./skill-loader.js";

/** Extra sections to inject into the system prompt. */
export interface PromptExtras {
  /** Skill full texts to inline. */
  inlinedSkills?: InlinedSkill[];
  /** Skill metadata for whitelist display. */
  skillMetas?: SkillMeta[];
  /** Parent system prompt (inherit mode). */
  parentSystemPrompt?: string;
  /** Custom system prompt content (custom mode). */
  customSystemPrompt?: string;
  /** Project context files (AGENTS.md) for custom mode. */
  contextFiles?: Array<{ path: string; content: string }>;
}

/** Strip pi scaffolding (<project_context>, skills block, date/cwd lines) from a parent prompt. Inherit mode re-adds these from the subagent's own config. */
function stripScaffolding(prompt: string): string {
  let result = prompt;

  result = result.replace(
    /\n?<\s*project_context\s*>[\s\S]*?<\/\s*project_context\s*>\n?/g,
    "\n",
  );

  result = result.replace(
    /\n?(?:The following skills provide[\s\S]*?)?<\s*available_skills\s*>[\s\S]*?<\/\s*available_skills\s*>\n?/g,
    "\n",
  );

  result = result.replace(/\n?Current date:.*\n?/g, "\n");
  result = result.replace(/\n?Current working directory:.*\n?/g, "\n");
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/**
 * The built agent prompt split into the pieces the launch plan interleaves
 * with the per-spawn sections (orchestration guidance, skills, worktree
 * branch, result instruction, notes).
 */
export interface AgentPromptParts {
  /** Spawn-stable prefix (mode header, env, project context). First so the KV-cache prefix survives across spawns. */
  prefix: string;
  /** Per-spawn identity (`<active_agent>` tag plus `<agent_instructions>`), after the shared prefix for the same KV-cache reason. */
  identity: string;
  /** Skill blocks (`<available_skills>` index / inlined `<skill>` content). */
  skills: string;
}

/**
 * Build the agent prompt from its config. Modes: replace (default, env +
 * agent's systemPrompt, no generic header), inherit (stripped parent prompt +
 * env + systemPrompt), custom (prompt file + env + systemPrompt). The agent's
 * systemPrompt is always included in `<agent_instructions>`.
 */
export async function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  extras?: PromptExtras,
  mode: SystemPromptMode = "replace",
): Promise<AgentPromptParts> {
  const envLines = [
    "# Environment",
    `Working directory: ${cwd}`,
    env.isGitRepo ? "Git repository: yes" : "Not a git repository",
  ];
  if (env.isGitRepo && env.branch) {
    envLines.push(`Branch: ${env.branch}`);
  }
  envLines.push(`Platform: ${env.platform}`);
  const envBlock = envLines.join("\n");

  const hasSkills =
    Boolean(extras?.skillMetas?.length) ||
    Boolean(extras?.inlinedSkills?.length);
  let extrasSuffix = "";
  if (hasSkills) {
    const skillLines: string[] = [];

    if (extras?.skillMetas?.length) {
      const piSkills: Skill[] = extras.skillMetas.map((m) => ({
        name: m.name,
        description: m.description,
        filePath: m.location,
        baseDir: "",
        sourceInfo: {} as SourceInfo,
        disableModelInvocation: m.disableModelInvocation,
      }));
      const formatted = formatSkillsForPrompt(piSkills);
      const skillElements = formatted.match(/<skill>[\s\S]*?<\/skill>/g);
      if (skillElements) skillLines.push(...skillElements);
    }

    for (const skill of extras?.inlinedSkills ?? []) {
      skillLines.push(
        `<skill><name>${escapeXml(skill.name)}</name><description>${escapeXml(skill.description)}</description><content>${escapeXml(skill.content)}</content></skill>`,
      );
    }

    const lines = [
      "The following skills provide specialized instructions for specific tasks.",
      "Use the read tool to load a skill's file when the task matches its description.",
      "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
      "",
      "<available_skills>",
      ...skillLines,
      "</available_skills>",
    ];
    extrasSuffix = `\n\n${lines.join("\n")}`;
  }

  const agentInstructions = `\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`;

  let contextSuffix = "";
  if (extras?.contextFiles?.length) {
    const lines = [
      "<project_context>",
      "",
      "Project-specific instructions and guidelines:",
      "",
    ];
    for (const file of extras.contextFiles) {
      lines.push(`<project_instructions path="${escapeXml(file.path)}">`);
      lines.push(file.content);
      lines.push(`</project_instructions>`);
      lines.push("");
    }
    lines.push("</project_context>");
    contextSuffix = `\n\n${lines.join("\n")}`;
  }

  const activeAgentTag = buildActiveAgentTag(config);
  const rawHeader =
    mode === "inherit"
      ? extras?.parentSystemPrompt
      : mode === "custom"
        ? extras?.customSystemPrompt
        : undefined;
  // Parent/custom headers carry pi's scaffolding; strip it since we re-add these from the subagent's own config. Replace mode adds no header.
  const customHeader = rawHeader ? stripScaffolding(rawHeader) : rawHeader;
  const basePrompt = customHeader ? `${customHeader}\n\n${envBlock}` : envBlock;

  return {
    prefix: `${basePrompt}${contextSuffix}`,
    identity: `${activeAgentTag}\n${agentInstructions}`,
    skills: extrasSuffix,
  };
}

/** The `<active_agent>` tag: registered name, display name when configured, description as the body. The description belongs on the identity tag, not in the task. */
function buildActiveAgentTag(config: AgentConfig): string {
  const displayName = config.displayName?.trim();
  const displayAttr = displayName
    ? ` display_name="${escapeXml(displayName)}"`
    : "";
  const nameAttr = `name="${escapeXml(config.name)}"${displayAttr}`;
  const description = config.description.trim();
  if (!description) return `<active_agent ${nameAttr}/>`;
  return `<active_agent ${nameAttr}>\n${escapeXml(description)}\n</active_agent>`;
}

function escapeXml(value: string): string {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
