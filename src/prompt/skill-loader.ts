/**
 * skill-loader.ts — Load skills using Pi's exported APIs, so subagents see
 * the same skills as the parent session.
 *
 * Roots, in precedence order (first match wins by name):
 *   1. Ancestor .agents/skills (cwd → git root, root .md files filtered out)
 *   2. ~/.agents/skills (root .md files filtered out)
 *   3. ~/.pi/agent/skills (Pi's user default)
 *   4. <cwd>/.pi/skills (Pi's project default)
 *
 * Root .md files are filtered out of .agents/skills because Pi's "agents"
 * mode (no root files) is not exported.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadSkills,
  loadSkillsFromDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { isUnsafeName } from "../utils.js";

export interface InlinedSkill {
  name: string;
  description: string;
  content: string;
}

export interface SkillMeta {
  name: string;
  description: string;
  location: string;
  /** Whether the skill should be excluded from the <available_skills> prompt block. */
  disableModelInvocation: boolean;
}

type LoadSkillsFromDir = typeof loadSkillsFromDir;

function loadAllSkills(cwd: string): Skill[] {
  const resolvedCwd = resolve(cwd);

  const ancestorsSkills = loadAncestorAgentsSkills(
    resolvedCwd,
    loadSkillsFromDir,
  );

  const homeAgentsResult = loadSkillsFromDir({
    dir: join(homedir(), ".agents", "skills"),
    source: "agents",
  });
  const homeAgentsSkills = filterRootMdFiles(
    homeAgentsResult.skills,
    join(homedir(), ".agents", "skills"),
  );

  const defaultsResult = loadSkills({
    cwd: resolvedCwd,
    agentDir: join(homedir(), ".pi", "agent"),
    skillPaths: [],
    includeDefaults: true,
  });

  const nameSet = new Set<string>();
  const realPathSet = new Set<string>();
  const result: Skill[] = [];

  for (const skill of [
    ...ancestorsSkills,
    ...homeAgentsSkills,
    ...defaultsResult.skills,
  ]) {
    const realPath = canonicalizePath(skill.filePath);
    if (realPathSet.has(realPath) || nameSet.has(skill.name)) continue;
    nameSet.add(skill.name);
    realPathSet.add(realPath);
    result.push(skill);
  }

  return result;
}

/** Walk cwd → git root, loading each `.agents/skills` dir. Root .md files are filtered: the exported API has no "agents" mode. */
function loadAncestorAgentsSkills(
  resolvedCwd: string,
  loadSkillsFromDir: LoadSkillsFromDir,
): Skill[] {
  const gitRoot = findGitRoot(resolvedCwd);
  const result: Skill[] = [];
  let dir = resolvedCwd;

  while (true) {
    const agentsSkillsDir = join(dir, ".agents", "skills");
    const dirResult = loadSkillsFromDir({
      dir: agentsSkillsDir,
      source: "agents",
    });
    result.push(...filterRootMdFiles(dirResult.skills, agentsSkillsDir));

    if (dir === gitRoot) break;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  return result;
}

/** Filter root .md files out of `.agents/skills` (subdir skills only): a root skill's parent is the skills root itself. */
function filterRootMdFiles(skills: Skill[], skillsRoot: string): Skill[] {
  const normalizedRoot = resolve(skillsRoot);
  return skills.filter((skill) => {
    const parent = resolve(skill.filePath, "..");
    return parent !== normalizedRoot;
  });
}

function findGitRoot(dir: string): string {
  let current = resolve(dir);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return current;
    current = parent;
  }
}

/** Canonical path, following symlinks; raw path when unresolvable. */
function canonicalizePath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

export async function inlineSkills(
  skillNames: string[],
  cwd: string,
): Promise<InlinedSkill[]> {
  const skills = loadAllSkills(cwd);
  return skillNames.map((name) => {
    if (isUnsafeName(name)) {
      return {
        name,
        description: "",
        content: `(Skill "${name}" skipped: name contains path traversal characters)`,
      };
    }
    const match = skills.find((s) => s.name === name);
    if (!match) {
      return {
        name,
        description: "",
        content: `(Skill "${name}" not found in .pi/skills/, .agents/skills/, or global skill locations)`,
      };
    }
    try {
      return {
        name,
        description: match.description,
        content: readFileSync(match.filePath, "utf-8").trim(),
      };
    } catch {
      return {
        name,
        description: "",
        content: `(Skill "${name}" not found in .pi/skills/, .agents/skills/, or global skill locations)`,
      };
    }
  });
}

/** Skill metadata only (no content), for the whitelist — the agent reads full content on demand. */
export async function loadSkillMeta(
  skillNames: string[],
  cwd: string,
): Promise<SkillMeta[]> {
  const skills = loadAllSkills(cwd);
  return skillNames.map((name) => {
    const match = skills.find((s) => s.name === name);
    if (!match) {
      return {
        name,
        description: `(Skill "${name}" not found)`,
        location: "",
        disableModelInvocation: false,
      };
    }
    return {
      name,
      description: match.description,
      location: match.filePath,
      disableModelInvocation: match.disableModelInvocation,
    };
  });
}
