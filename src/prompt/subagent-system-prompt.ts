/**
 * subagent-system-prompt.ts — The standing system prompt of a subagent spawn.
 *
 * Pure prompt compiler: resolved agent template, spawn config, and spawn
 * identity in; full system-prompt text out. agent-runner.ts owns what this
 * module does not: staging the text to `system.md` and assembling the pi
 * argv. External sources arrive as plain arguments, so the composer holds no
 * shell state and unit-tests with fakes.
 */

import fs from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorMessage, GIT_EXEC_TIMEOUT_MS } from "../utils.js";
import { agentDir } from "../paths.js";
import { customPromptPath } from "../config/config-io.js";
import type { ResolvedAgentConfig } from "../agents/agent-types.js";
import { DEFAULT_AGENTS } from "../agents/default-agents.js";
import type {
  AgentConfig,
  SubagentType,
  SystemPromptMode,
} from "../agents/types.js";
import type { EnvInfo } from "../types.js";
import { buildOrchestrationGuidance } from "../orchestrators/briefing-section.js";
import {
  buildAgentPrompt,
  type AgentPromptParts,
  type PromptExtras,
} from "./prompts.js";
import { loadSkillMeta, inlineSkills } from "./skill-loader.js";

async function execGit(
  pi: ExtensionAPI,
  args: string[],
  cwd: string,
): Promise<string | null> {
  try {
    const result = await pi.exec("git", args, {
      cwd,
      timeout: GIT_EXEC_TIMEOUT_MS,
    });
    return result.code === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** Environment detection through `pi.exec`, so the git probes inherit the parent pane's environment. */
async function detectEnv(pi: ExtensionAPI, cwd: string): Promise<EnvInfo> {
  const gitRoot = await execGit(
    pi,
    ["rev-parse", "--is-inside-work-tree"],
    cwd,
  );
  const isGitRepo = gitRoot === "true";
  const branch = isGitRepo
    ? await execGit(pi, ["branch", "--show-current"], cwd)
    : null;

  return {
    isGitRepo,
    branch,
    platform: process.platform,
  };
}

type PromptSourceExtras = Pick<
  PromptExtras,
  "parentSystemPrompt" | "customSystemPrompt" | "contextFiles"
>;

/** Resolve the mode's external sources (parent prompt, custom file, AGENTS.md). A missing source warns on `notify` and degrades the prompt — it never fails the launch. */
async function resolveSystemPromptSources(
  ctx: ExtensionContext,
  cwd: string,
  notify: (msg: string) => void,
  agentConfig: AgentConfig | undefined,
  mode: SystemPromptMode,
  globalIncludeContextFiles: boolean,
): Promise<PromptSourceExtras> {
  const promptPath = customPromptPath();
  const includeContextFiles =
    agentConfig?.includeContextFiles ?? globalIncludeContextFiles;
  const extras: PromptSourceExtras = {};

  if (mode === "inherit") {
    try {
      extras.parentSystemPrompt = ctx.getSystemPrompt();
    } catch (err) {
      notify(
        `Failed to get parent system prompt: ${errorMessage(err)}. Falling back to replace mode.`,
      );
    }
  }

  if (mode === "custom") {
    try {
      const content = fs.readFileSync(promptPath, "utf-8").trim();
      if (content) {
        extras.customSystemPrompt = content;
      } else {
        notify(
          `Custom prompt file is empty: ${promptPath}. Falling back to replace mode.`,
        );
      }
    } catch (err) {
      if ((err as { code?: string } | undefined)?.code === "ENOENT") {
        notify(
          `Custom prompt file not found: ${promptPath}. Falling back to replace mode.`,
        );
      } else {
        notify(
          `Failed to read custom prompt file: ${errorMessage(err)}. Falling back to replace mode.`,
        );
      }
    }
  }

  if (includeContextFiles) {
    try {
      // Deferred import keeps pi's barrel off the boot-time import graph.
      const { loadProjectContextFiles } =
        await import("@earendil-works/pi-coding-agent");
      extras.contextFiles = loadProjectContextFiles({
        cwd,
        agentDir: agentDir(),
      });
    } catch {
      // Context files are supplementary; their absence is not fatal.
    }
  }

  return extras;
}

/** Build the agent-specific prompt parts with configured skills loaded. An unregistered type falls back to the embedded general-purpose template. */
async function buildPrompt(
  type: SubagentType,
  agentConfig: AgentConfig | undefined,
  config: ResolvedAgentConfig,
  cwd: string,
  env: EnvInfo,
  systemPromptMode: SystemPromptMode,
  resolverExtras: PromptSourceExtras,
): Promise<AgentPromptParts> {
  const extras: PromptExtras = { ...resolverExtras };
  const inlinedSkills = agentConfig?.inlinedSkills ?? [];
  if (inlinedSkills.length > 0) {
    extras.inlinedSkills = await inlineSkills(inlinedSkills, cwd);
  }
  if (Array.isArray(config.skills)) {
    extras.skillMetas = await loadSkillMeta(config.skills, cwd);
  }
  if (agentConfig) {
    return await buildAgentPrompt(
      agentConfig,
      cwd,
      env,
      extras,
      systemPromptMode,
    );
  }
  const fallback = DEFAULT_AGENTS.get("general-purpose");
  if (!fallback)
    throw new Error(`No fallback config available for unknown type "${type}"`);
  return await buildAgentPrompt(
    { ...fallback, name: type },
    cwd,
    env,
    extras,
    systemPromptMode,
  );
}

/** Join non-empty sections with one blank line. Agent guidance (with its whitespace) survives verbatim. */
function joinPromptSections(sections: Array<string | undefined>): string {
  return sections
    .filter((section): section is string => Boolean(section?.trim()))
    .join("\n\n");
}

/** The branch to name: the detected one when it carries something, else the expected one. */
function branchName(
  detected: string | null,
  expected: string | undefined,
): string | undefined {
  return detected !== null && detected !== "" ? detected : expected;
}

/** Branch block: detected checkout branch, else the expected branch pinned at create time. Empty when not a worktree run. */
export function buildWorktreeBranchSection(
  worktreePath: string | undefined,
  isGitRepo: boolean,
  detectedBranch: string | null,
  expectedBranch: string | undefined,
): string {
  const name =
    worktreePath && isGitRepo
      ? branchName(detectedBranch, expectedBranch)
      : undefined;
  if (!name) return "";
  return [
    "",
    "## Worktree branch",
    "",
    `You are working in a git worktree on branch \`${name}\`.`,
    "Every commit you make and every merge you run lands on THIS branch — never on `main` or any other branch.",
    "Do NOT switch branches and do NOT merge into `main` yourself. Report the branch name in your final response so the orchestrator can merge it with the merge_cowboy_branch tool.",
  ].join("\n");
}

/** Steering contract: mid-run instructions outrank the task; divergences must be disclosed so the orchestrator can tell a requested change from scope slip. */
function buildSteeringInstructions(): string {
  return [
    "## Steering & Mid-Run Instructions",
    "- You may receive additional instructions or steering messages while working (from the user or the orchestrator).",
    "- Always treat mid-run steering and follow-up instructions as having higher priority than your original initial prompt.",
    "- In your final report (written to the result file), you MUST explicitly disclose any steering or direction changes you received during implementation.",
    "- If steering or code review comments caused you to diverge from, modify, or abandon parts of the original goal, clearly explain what changed and why, so the orchestrator understands that the divergence was intentional and requested.",
  ].join("\n");
}

/** Deliverable contract: the path the child writes to, in the wording the parent reads back. */
function buildResultInstruction(resultFile: string): string {
  return [
    "",
    "When you have completed the task, write your complete final response verbatim to the file:",
    resultFile,
    "",
    "Write the full final answer as Markdown to that file, then reply with a one-line confirmation. The parent session reads that file as your deliverable.",
  ].join("\n");
}

/** Everything the composer needs for one spawn. */
export interface SubagentSystemPromptOptions {
  /** Extension API for the git probes behind the branch block. */
  pi: ExtensionAPI;
  /** Parent session context (parent prompt in inherit mode). */
  ctx: ExtensionContext;
  /** Requested agent type; names the fallback template when unregistered. */
  type: SubagentType;
  /** Registered agent template, or undefined for the general-purpose fallback. */
  agentConfig: AgentConfig | undefined;
  /** Resolved skill/extension selection. */
  config: ResolvedAgentConfig;
  /** Working directory for the environment block. */
  cwd: string;
  /** How the prompt's leading header is sourced: nothing, the parent's prompt, or the custom file. */
  globalSystemPromptMode: SystemPromptMode;
  /** Global includeContextFiles; the agent's include_context_files overrides it. */
  globalIncludeContextFiles: boolean;
  /** Worktree path for the branch section; undefined = not a worktree run. */
  worktreePath?: string;
  /** Branch pinned at create time; used when detection failed. */
  expectedBranch?: string;
  /** Orchestration template guidance — rendered last and verbatim. */
  agentGuidance?: string;
  /** Absolute path the child writes its deliverable to. */
  resultFile: string;
  /** Warning sink for prompt-source failures. */
  notify: (msg: string) => void;
}

/**
 * Compile one spawn's standing system prompt. Composition order is fixed:
 * shared prefix, identity, skills, spawn contract (branch, steering,
 * deliverable), orchestrator guidance LAST. The task itself is never here;
 * it is the pane's initial message.
 */
export async function buildSubagentSystemPrompt(
  options: SubagentSystemPromptOptions,
): Promise<string> {
  const { pi, ctx, cwd, notify } = options;

  const env = await detectEnv(pi, cwd);
  const extras = await resolveSystemPromptSources(
    ctx,
    cwd,
    notify,
    options.agentConfig,
    options.globalSystemPromptMode,
    options.globalIncludeContextFiles,
  );
  const parts = await buildPrompt(
    options.type,
    options.agentConfig,
    options.config,
    cwd,
    env,
    options.globalSystemPromptMode,
    extras,
  );

  return joinPromptSections([
    parts.prefix,
    parts.identity,
    parts.skills,
    buildWorktreeBranchSection(
      options.worktreePath,
      env.isGitRepo,
      env.branch,
      options.expectedBranch,
    ),
    buildSteeringInstructions(),
    buildResultInstruction(options.resultFile),
    buildOrchestrationGuidance(options.agentGuidance),
  ]);
}
