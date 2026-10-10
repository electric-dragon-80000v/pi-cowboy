import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerAgents } from "../src/agents/agent-types.js";
import {
  buildLaunchPlan,
  type SubagentLaunchPlan,
} from "../src/agents/agent-runner.js";
import type { AgentConfig } from "../src/agents/types.js";
import {
  ConfigStore,
  type ConfigIO,
  type RawConfig,
} from "../src/config/config-store.js";
import type { LoadedConfig } from "../src/config/config-io.js";
import { subagentResultDir } from "../src/paths.js";
import { buildOrchestrationGuidance } from "../src/orchestrators/briefing-section.js";
import {
  createSessionTemplates,
  detectSubagentSpawn,
  setSessionTemplates,
} from "../src/shell.js";

/**
 * The shell store is a process-wide singleton bound to the real config file.
 * Stand in an in-memory store so no test reads or writes the developer's
 * config.
 */
const storeRef = vi.hoisted(() => ({
  current: undefined as unknown as ConfigStore,
}));

vi.mock("../src/shell.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shell.js")>();
  return { ...actual, getStore: () => storeRef.current };
});

/** In-memory ConfigIO: the store never touches the filesystem. */
function memoryIO(global: RawConfig = {}): ConfigIO {
  return {
    load: (): LoadedConfig => ({
      global,
      project: null,
      projectStatus: "untrusted",
    }),
    isGlobalWritable: () => true,
    saveGlobal: () => {},
    saveProject: () => {},
  };
}

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "test agent",
    systemPrompt: "",
    harnessType: "pi",
    ...overrides,
  };
}

function setup(
  agent: AgentConfig | undefined,
  settings: Record<string, unknown> = {},
): { cwd: string; notify: ReturnType<typeof vi.fn> } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cowboy-runner-"));
  const agentDir = path.join(cwd, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify(settings),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  registerAgents(agent ? new Map([[agent.name, agent]]) : new Map());
  tempDirs.push(cwd);
  return { cwd, notify: vi.fn() };
}

/** Swap in a store whose global layer carries this agent section. */
function setGlobalAgentSettings(agent: RawConfig["agent"]): void {
  storeRef.current = new ConfigStore(memoryIO({ agent }));
}

async function launch(
  type: string,
  cwd: string,
  notify: ReturnType<typeof vi.fn>,
  agentGuidance?: string,
  model?: { provider: string; id: string },
  fork?: boolean,
  sessionFile?: string,
) {
  const pi = {
    exec: vi.fn().mockResolvedValue({ code: 1, stdout: "" }),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    getSystemPrompt: () => "parent prompt",
    ui: { notify },
    sessionManager: sessionFile
      ? { getSessionFile: () => sessionFile }
      : undefined,
  } as unknown as ExtensionContext;
  return buildLaunchPlan(pi, ctx, type, "do the task", {
    description: "test task",
    agentId: "runner-test",
    cwd,
    agentGuidance,
    fork,
    modelSelection: model
      ? { model: model as never, key: `${model.provider}/${model.id}` }
      : undefined,
  });
}

beforeEach(() => {
  setSessionTemplates(createSessionTemplates());
  storeRef.current = new ConfigStore(memoryIO());
});

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("buildLaunchPlan CLI flags", () => {
  it("defaults the plan's harness to pi", async () => {
    const { cwd, notify } = setup(makeAgent());
    const plan = await launch("test-agent", cwd, notify);

    expect(plan.harness).toBe("pi");
  });

  it("reports the harness the agent declares", async () => {
    const { cwd, notify } = setup(makeAgent({ harnessType: "pig" }));
    const plan = await launch("test-agent", cwd, notify);

    expect(plan.harness).toBe("pig");
  });

  it("uses the configured default harness when the agent declares none", async () => {
    setGlobalAgentSettings({ harnessType: "pig" });
    const { cwd, notify } = setup(makeAgent({ harnessType: undefined }));
    const plan = await launch("test-agent", cwd, notify);

    expect(plan.harness).toBe("pig");
  });

  it("forwards the resolved model to the subprocess argv and the launch plan", async () => {
    const { cwd, notify } = setup(undefined);
    const plan = await launch("general-purpose", cwd, notify, undefined, {
      provider: "override",
      id: "special-model",
    });

    const flag = plan.piArgs.indexOf("--model");
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(plan.piArgs[flag + 1]).toBe("override/special-model");
    expect(plan.modelKey).toBe("override/special-model");
  });

  it("does not add extension or tool flags with no agent config", async () => {
    const { cwd, notify } = setup(undefined);
    const plan = await launch("general-purpose", cwd, notify);

    expect(plan.piArgs).not.toContain("--no-extensions");
    expect(plan.piArgs).not.toContain("-e");
    expect(plan.piArgs).not.toContain("--tools");
    expect(plan.piArgs).not.toContain("--exclude-tools");
    expect(plan.piArgs).not.toContain("--no-tools");
  });

  it("never adds a session-fork flag", async () => {
    const { cwd, notify } = setup(undefined);
    const plan = await launch("general-purpose", cwd, notify);

    expect(plan.piArgs).not.toContain("--fork");
  });

  it("reports no model key when the launch requested no override", async () => {
    const { cwd, notify } = setup(undefined);
    const plan = await launch("general-purpose", cwd, notify);

    expect(plan.modelKey).toBeNull();
    expect(plan.piArgs).not.toContain("--model");
  });

  it("forks the parent session when fork is enabled and a session file exists", async () => {
    const { cwd, notify } = setup(undefined);
    const plan = await launch(
      "general-purpose",
      cwd,
      notify,
      undefined,
      undefined,
      true,
      "/sessions/parent.jsonl",
    );

    const flag = plan.piArgs.indexOf("--fork");
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(plan.piArgs[flag + 1]).toBe("/sessions/parent.jsonl");
    expect(notify).not.toHaveBeenCalled();
  });

  it("omits --fork when fork is disabled, even with a session file", async () => {
    const { cwd, notify } = setup(undefined);
    const plan = await launch(
      "general-purpose",
      cwd,
      notify,
      undefined,
      undefined,
      false,
      "/sessions/parent.jsonl",
    );

    expect(plan.piArgs).not.toContain("--fork");
  });

  it("warns and omits --fork when no parent session file is available", async () => {
    const { cwd, notify } = setup(undefined);
    const plan = await launch(
      "general-purpose",
      cwd,
      notify,
      undefined,
      undefined,
      true,
    );

    expect(plan.piArgs).not.toContain("--fork");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("no parent session file"),
      "warning",
    );
  });

  it("rides the task as the trailing @file the pane shell expands", async () => {
    const { cwd, notify } = setup(undefined);
    const plan = await launch("general-purpose", cwd, notify);

    expect(plan.piArgs.at(-1)?.startsWith("@")).toBe(true);
    expect(readTask(plan)).toBe("do the task");
  });

  it("builds the pi family's argv for a pi-compatible harness the same way", async () => {
    const { cwd, notify } = setup(makeAgent({ harnessType: "pig" }));
    const plan = await launch("test-agent", cwd, notify);

    // Delegation, not divergence: pig is pi's CLI behind the pane's `pi`.
    expect(plan.harness).toBe("pig");
    expect(plan.piArgs).toEqual(
      expect.arrayContaining([
        "--system-prompt",
        "--append-system-prompt",
        "cowboy-subagent-runner-test",
        "--no-context-files",
        "--approve",
      ]),
    );
  });

  it("keeps the subagent marker detectable from the produced argv", async () => {
    const { cwd, notify } = setup(undefined);
    const plan = await launch("general-purpose", cwd, notify);

    const flag = plan.piArgs.indexOf("--append-system-prompt");
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(plan.piArgs[flag + 1]).toBe("cowboy-subagent-runner-test");
    // detectSubagentSpawn scans process.argv, which pi's exec path prefixes.
    expect(detectSubagentSpawn(["pi", ...plan.piArgs])).toBe("runner-test");
  });

  it("emits --no-extensions for extensions: false", async () => {
    const { cwd, notify } = setup(makeAgent({ extensions: false }));
    const plan = await launch("test-agent", cwd, notify);

    expect(plan.piArgs).toContain("--no-extensions");
    expect(plan.piArgs).not.toContain("-e");
  });

  it("resolves a whitelist through settings package sources", async () => {
    const { cwd, notify } = setup(
      makeAgent({ extensions: ["pi-intercom", "repo"] }),
      { packages: ["npm:pi-intercom", "git:github.com/user/repo"] },
    );
    const plan = await launch("test-agent", cwd, notify);

    expect(plan.piArgs).toContain("--no-extensions");
    expect(plan.piArgs).toEqual(
      expect.arrayContaining([
        "-e",
        "npm:pi-intercom",
        "-e",
        "git:github.com/user/repo",
      ]),
    );
  });

  it("fails loudly instead of emitting a broken extension path", async () => {
    const { cwd, notify } = setup(makeAgent({ extensions: ["missing"] }));

    await expect(launch("test-agent", cwd, notify)).rejects.toThrow(
      'Extension entry "missing" is not in the pi settings',
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Extension entry "missing"'),
      "error",
    );
  });

  it("passes tool names to pi unchanged", async () => {
    const { cwd, notify } = setup(makeAgent({ tools: ["read", "web_search"] }));
    const plan = await launch("test-agent", cwd, notify);

    expect(plan.piArgs).toContain("--tools");
    expect(plan.piArgs).toContain("read,web_search");
  });

  it("keeps a hidden agent's own tools", async () => {
    const { cwd, notify } = setup(makeAgent({ hidden: true, tools: ["read"] }));
    const plan = await launch("test-agent", cwd, notify);

    expect(plan.piArgs).toContain("--tools");
    expect(plan.piArgs).toContain("read");
  });

  it("emits --no-tools for tools: false", async () => {
    const { cwd, notify } = setup(makeAgent({ tools: false }));
    const plan = await launch("test-agent", cwd, notify);

    expect(plan.piArgs).toContain("--no-tools");
  });

  it("emits --exclude-tools for an excludeTools list", async () => {
    const { cwd, notify } = setup(makeAgent({ excludeTools: ["read"] }));
    const plan = await launch("test-agent", cwd, notify);

    expect(plan.piArgs).toContain("--exclude-tools");
    expect(plan.piArgs).toContain("read");
  });

  it("rejects an empty tool name", async () => {
    const { cwd, notify } = setup(makeAgent({ tools: ["read", ""] }));

    await expect(launch("test-agent", cwd, notify)).rejects.toThrow(
      "Empty entry in tools",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Empty entry in tools"),
      "error",
    );
  });
});

describe("buildLaunchPlan skills flags", () => {
  it("leaves pi's own skills discovery on when the template omits skills and implicit loading is on", async () => {
    const { cwd, notify } = setup(makeAgent());
    setGlobalAgentSettings({ loadSkillsImplicitly: true });

    const plan = await launch("test-agent", cwd, notify);

    expect(plan.piArgs).not.toContain("--no-skills");
  });

  it("withholds pi's skills when the template omits skills and implicit loading is off", async () => {
    const { cwd, notify } = setup(makeAgent());
    setGlobalAgentSettings({ loadSkillsImplicitly: false });

    const plan = await launch("test-agent", cwd, notify);

    expect(plan.piArgs).toContain("--no-skills");
  });

  it("applies the same split to the fallback for an unregistered type", async () => {
    const on = setup(undefined);
    setGlobalAgentSettings({ loadSkillsImplicitly: true });
    expect(
      (await launch("general-purpose", on.cwd, on.notify)).piArgs,
    ).not.toContain("--no-skills");

    const off = setup(undefined);
    setGlobalAgentSettings({ loadSkillsImplicitly: false });
    expect(
      (await launch("general-purpose", off.cwd, off.notify)).piArgs,
    ).toContain("--no-skills");
  });

  it("honours an explicit skills: true over an off global toggle", async () => {
    const { cwd, notify } = setup(makeAgent({ skills: true }));
    setGlobalAgentSettings({ loadSkillsImplicitly: false });

    const plan = await launch("test-agent", cwd, notify);

    expect(plan.piArgs).not.toContain("--no-skills");
  });

  it("withholds pi's skills for skills: false even when implicit loading is on", async () => {
    const { cwd, notify } = setup(makeAgent({ skills: false }));
    setGlobalAgentSettings({ loadSkillsImplicitly: true });

    const plan = await launch("test-agent", cwd, notify);

    expect(plan.piArgs).toContain("--no-skills");
    expect(readSystemPrompt(plan)).not.toContain("<available_skills>");
  });

  it("withholds pi's skills when the extension renders an explicit skills list", async () => {
    const { cwd, notify } = setup(makeAgent({ skills: ["review-diff"] }));
    setGlobalAgentSettings({ loadSkillsImplicitly: true });

    const plan = await launch("test-agent", cwd, notify);

    expect(plan.piArgs).toContain("--no-skills");
    const system = readSystemPrompt(plan);
    expect(system).toContain("<available_skills>");
    expect(system).toContain("<name>review-diff</name>");
  });

  it("withholds pi's skills when the template inlines skills", async () => {
    const { cwd, notify } = setup(
      makeAgent({ inlinedSkills: ["review-diff"] }),
    );
    setGlobalAgentSettings({ loadSkillsImplicitly: true });

    const plan = await launch("test-agent", cwd, notify);

    expect(plan.piArgs).toContain("--no-skills");
    expect(readSystemPrompt(plan)).toContain("<name>review-diff</name>");
  });

  it("leaves pi's skills on when the template inlines nothing", async () => {
    const { cwd, notify } = setup(makeAgent({ inlinedSkills: [] }));
    setGlobalAgentSettings({ loadSkillsImplicitly: true });

    const plan = await launch("test-agent", cwd, notify);

    expect(plan.piArgs).not.toContain("--no-skills");
    expect(readSystemPrompt(plan)).not.toContain("<available_skills>");
  });
});

function readSystemPrompt(plan: SubagentLaunchPlan): string {
  const flag = plan.piArgs.indexOf("--system-prompt");
  if (flag === -1) throw new Error("launch plan carries no --system-prompt");
  return fs.readFileSync(plan.piArgs[flag + 1]!, "utf-8");
}

function readTask(plan: SubagentLaunchPlan): string {
  const last = plan.piArgs.at(-1);
  if (!last?.startsWith("@")) {
    throw new Error("launch plan carries no task @file");
  }
  return fs.readFileSync(last.slice(1), "utf-8");
}

describe("buildLaunchPlan orchestration guidance", () => {
  it("injects the authored guidance byte-for-byte into the system prompt", async () => {
    const { cwd, notify } = setup(undefined);

    const plan = await launch(
      "general-purpose",
      cwd,
      notify,
      "  Review your own diff before committing.  ",
    );
    const system = readSystemPrompt(plan);

    // The serialized guidance is never reworded or trimmed.
    expect(system).toContain(
      buildOrchestrationGuidance("  Review your own diff before committing.  "),
    );
    expect(system).not.toContain("do the task");
    expect(readTask(plan)).toBe("do the task");
  });

  it("allows sequential launches to carry distinct guidance without shared state", async () => {
    const { cwd, notify } = setup(undefined);

    const first = await launch("general-purpose", cwd, notify, "For task A.");
    const firstSystem = readSystemPrompt(first);
    const second = await launch("general-purpose", cwd, notify, "For task B.");
    const secondSystem = readSystemPrompt(second);

    expect(firstSystem).toContain("For task A.");
    expect(firstSystem).not.toContain("For task B.");
    expect(secondSystem).toContain("For task B.");
    expect(secondSystem).not.toContain("For task A.");
  });

  it("puts the guidance at the very end of the system prompt", async () => {
    const { cwd, notify } = setup(undefined);

    const plan = await launch(
      "general-purpose",
      cwd,
      notify,
      "Review your own diff before committing.",
    );
    const system = readSystemPrompt(plan);

    expect(system.indexOf("<active_agent")).toBeLessThan(
      system.indexOf("## Orchestrator Guidance"),
    );
    expect(system.indexOf("When you have completed the task")).toBeLessThan(
      system.indexOf("## Orchestrator Guidance"),
    );
  });

  it("adds no guidance block when the orchestrator authored none", async () => {
    const { cwd, notify } = setup(undefined);

    const plan = await launch("general-purpose", cwd, notify);
    const system = readSystemPrompt(plan);

    expect(system).not.toContain("## Orchestrator Guidance");
  });
});

describe("buildLaunchPlan system prompt split", () => {
  it("writes the task, and nothing else, to the @file initial message", async () => {
    const { cwd, notify } = setup(undefined);

    const plan = await launch("general-purpose", cwd, notify);

    expect(readTask(plan)).toBe("do the task");
  });

  it("names an existing system-prompt file whose contents are the built prompt", async () => {
    const { cwd, notify } = setup(undefined);

    const plan = await launch("general-purpose", cwd, notify);
    const flag = plan.piArgs.indexOf("--system-prompt");
    const value = plan.piArgs[flag + 1]!;

    expect(path.isAbsolute(value)).toBe(true);
    expect(fs.existsSync(value)).toBe(true);
    expect(plan.systemPromptFile).toBe(value);
    expect(fs.readFileSync(value, "utf-8")).toBe(plan.systemPrompt);
  });

  it("carries the project context, agent description, branch section and result instruction", async () => {
    const { cwd, notify } = setup(
      makeAgent({
        name: "test-agent",
        displayName: "Test Agent",
        description: "reviews diffs for regressions",
        systemPrompt: "Follow the repository conventions.",
      }),
    );
    fs.writeFileSync(
      path.join(cwd, "AGENTS.md"),
      "# Repo rules\n\nNever merge into main.",
    );
    const pi = {
      exec: vi.fn(async (_cmd: string, args: string[]) => {
        if (args[0] === "rev-parse") return { code: 0, stdout: "true\n" };
        return { code: 0, stdout: "cow-fix-login-abc12345\n" };
      }),
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      getSystemPrompt: () => "parent prompt",
      ui: { notify },
    } as unknown as ExtensionContext;

    const plan = await buildLaunchPlan(pi, ctx, "test-agent", "do the task", {
      description: "test task",
      agentId: "runner-context",
      cwd,
      worktree: { kind: "owned", path: cwd, branch: "cow-fix-login-abc12345" },
    });
    const system = readSystemPrompt(plan);

    expect(system).toContain("<project_context>");
    expect(system).toContain("Never merge into main.");
    expect(system).toContain(
      '<active_agent name="test-agent" display_name="Test Agent">',
    );
    expect(system).toContain("reviews diffs for regressions");
    expect(system).toContain(
      "<agent_instructions>\nFollow the repository conventions.\n</agent_instructions>",
    );
    expect(system).toContain("## Worktree branch");
    expect(system).toContain("`cow-fix-login-abc12345`");
    expect(system).toContain(
      "When you have completed the task, write your complete final response verbatim to the file:",
    );
    expect(system).toContain(plan.resultFile!);
    // The parent reads the deliverable back on this exact wording.
    expect(system).toContain(
      "Write the full final answer as Markdown to that file, then reply with a one-line confirmation. The parent session reads that file as your deliverable.",
    );
    expect(readTask(plan)).toBe("do the task");
  });

  it("drops the replace-mode boilerplate header", async () => {
    const { cwd, notify } = setup(undefined);

    const plan = await launch("general-purpose", cwd, notify);
    const system = readSystemPrompt(plan);

    expect(system).not.toContain("You are a Pi, an expert coding sub-agent.");
    expect(system).not.toContain(
      "You have been invoked to handle a specific task autonomously.",
    );
    expect(system).not.toContain("complete agent briefing");
    expect(system.startsWith("# Environment")).toBe(true);
  });

  it("fails loud when the system-prompt write throws", async () => {
    const { cwd, notify } = setup(undefined);
    const realWrite = fs.writeFileSync;
    const spy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation((file, ...rest) => {
        if (String(file).endsWith("system.md")) throw new Error("EACCES");
        return realWrite(file, ...rest);
      });

    try {
      await expect(launch("general-purpose", cwd, notify)).rejects.toThrow(
        "cannot write the system prompt file",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("stages the result dir and prompt files with owner-only modes", async () => {
    const { cwd, notify } = setup(undefined);
    const agentId = "runner-perms-probe";
    const pi = {
      exec: vi.fn().mockResolvedValue({ code: 1, stdout: "" }),
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      getSystemPrompt: () => "parent prompt",
      ui: { notify },
    } as unknown as ExtensionContext;
    try {
      const plan = await buildLaunchPlan(
        pi,
        ctx,
        "general-purpose",
        "do the task",
        {
          description: "test task",
          agentId,
          cwd,
        },
      );
      const modeOf = (target: string): number =>
        fs.statSync(target).mode & 0o777;
      expect(modeOf(path.join(subagentResultDir(), agentId))).toBe(0o700);
      expect(modeOf(plan.systemPromptFile!)).toBe(0o600);
      const taskFile = plan.piArgs.at(-1)!.slice(1);
      expect(modeOf(taskFile)).toBe(0o600);
    } finally {
      fs.rmSync(path.join(subagentResultDir(), agentId), {
        recursive: true,
        force: true,
      });
    }
  });

  it("fails loud when the system-prompt file is missing after the write", async () => {
    const { cwd, notify } = setup(undefined);
    const realExists = fs.existsSync;
    const spy = vi
      .spyOn(fs, "existsSync")
      .mockImplementation((target) =>
        String(target).endsWith("system.md") ? false : realExists(target),
      );

    try {
      await expect(launch("general-purpose", cwd, notify)).rejects.toThrow(
        "the system prompt file is missing after the write",
      );
    } finally {
      spy.mockRestore();
    }
  });
});
