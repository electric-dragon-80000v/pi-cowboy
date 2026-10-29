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
import type {
  AnyHarnessId,
  CodexLaunchRequest,
  HarnessLaunch,
  PluginHarness,
} from "../src/agents/harness.js";
import { createHarnessRegistry } from "../src/agents/harness/harness-registry.js";
import { trustedEnv } from "../src/agents/harness/env-overrides.js";
import { codexHomeDirectory } from "../src/agents/harness/codex-session.js";
import type { AgentConfig } from "../src/agents/types.js";
import type { ModelChoice } from "../src/types.js";
import {
  ConfigStore,
  type ConfigIO,
  type RawConfig,
} from "../src/config/config-store.js";
import type { LoadedConfig } from "../src/config/config-io.js";
import { subagentEnvFileFor, subagentResultDir } from "../src/paths.js";
import { buildOrchestrationGuidance } from "../src/orchestrators/briefing-section.js";
import { resolveHarnessType } from "../src/agents/spawn-defaults.js";
import {
  createSessionTemplates,
  detectSubagentSpawn,
  getHarnessRegistry,
  installSessionRegistries,
  setSessionTemplates,
} from "../src/shell.js";
import { loadedStore } from "./helpers/loaded-store.js";

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

/**
 * The session's harness registry, installed per case so one case's plugin
 * harness cannot answer in the next. `harnessFor` reads whichever registry is
 * installed, so a spy here sees the entries the launch itself resolves.
 */
let harnesses = createHarnessRegistry();
const harnessFor = (id: AnyHarnessId) => getHarnessRegistry().require(id);

beforeEach(() => {
  harnesses = installSessionRegistries().harnesses;
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
    paths: () => ({ global: "config.json" }),
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
  storeRef.current = loadedStore(memoryIO({ agent }));
}

async function launch(
  type: string,
  cwd: string,
  notify: ReturnType<typeof vi.fn>,
  agentGuidance?: string,
  model?: { provider: string; id: string },
  fork?: boolean,
  sessionFile?: string,
  selection?: ModelChoice,
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
    harness: resolveHarnessType(type),
    cwd,
    agentGuidance,
    fork,
    modelChoice:
      selection ??
      (model
        ? {
            model: model as never,
            key: `${model.provider}/${model.id}`,
            thinking: null,
          }
        : undefined),
  });
}

beforeEach(() => {
  setSessionTemplates(createSessionTemplates());
  storeRef.current = loadedStore(memoryIO());
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
    expect(plan.launch.modelKey).toBe("override/special-model");
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

    expect(plan.launch.modelKey).toBeNull();
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

  it("dispatches opencode through its own family's request", async () => {
    const { cwd, notify } = setup(makeAgent({ harnessType: "opencode" }));
    const pi = {
      exec: vi.fn().mockResolvedValue({ code: 1, stdout: "" }),
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      getSystemPrompt: () => "parent prompt",
      ui: { notify },
    } as unknown as ExtensionContext;

    const plan = await buildLaunchPlan(pi, ctx, "test-agent", "do the task", {
      description: "test task",
      agentId: "runner-opencode",
      harness: "opencode",
      cwd,
    });

    // opencode's own CLI: the minimal interactive UI under a private server, the
    // staged agent, and no pi flag on the argv. The task rides the launcher's
    // stdin redirect, so it is staged rather than named on this argv.
    expect(plan.piArgs).toEqual([
      "mini",
      "--standalone",
      "--agent",
      "runner-opencode",
    ]);
    expect(fs.readFileSync(plan.launch.taskFile, "utf-8")).toBe("do the task");
  });

  it("dispatches codex through its own family's request", async () => {
    const { cwd, notify } = setup(makeAgent({ harnessType: "codex" }));

    const plan = await launch("test-agent", cwd, notify);

    expect(plan.harness).toBe("codex");
    expect(plan.launch).toMatchObject({
      family: "codex",
      subagentId: "runner-test",
      modelKey: null,
      toolSelection: { kind: "default" },
      projectTrusted: true,
    });
    // Exactly the shared inputs plus codex's own: no pi input rides this
    // request.
    expect(Object.keys(plan.launch).sort()).toEqual([
      "envFile",
      "family",
      "modelKey",
      "projectTrusted",
      "resultFile",
      "subagentId",
      "systemPromptFile",
      "taskFile",
      "thinking",
      "toolSelection",
    ]);
    // codex's own CLI: the instructions override, no project docs, and no pi
    // flag on the argv. The task rides the launcher's positional prompt, so
    // it is staged rather than named on this argv.
    expect(plan.piArgs[0]).toBe("-c");
    expect(plan.piArgs).toEqual(
      expect.arrayContaining([
        "-s",
        "workspace-write",
        "--dangerously-bypass-approvals-and-sandbox",
      ]),
    );
    expect(fs.readFileSync(plan.launch.taskFile, "utf-8")).toBe("do the task");
  });

  it("carries a level with no model of its own onto that harness's flag", async () => {
    const codex = setup(makeAgent({ harnessType: "codex" }));
    const codexPlan = await launch(
      "test-agent",
      codex.cwd,
      codex.notify,
      undefined,
      undefined,
      undefined,
      undefined,
      { levelOnly: true, thinking: "high" },
    );

    // The spawn named no model, so codex runs its own default at this effort.
    expect(codexPlan.launch.modelKey).toBeNull();
    expect(codexPlan.piArgs).toEqual(
      expect.arrayContaining(["-c", 'model_reasoning_effort="high"']),
    );

    const pi = setup(makeAgent({ harnessType: "pi" }));
    const piPlan = await launch(
      "test-agent",
      pi.cwd,
      pi.notify,
      undefined,
      undefined,
      undefined,
      undefined,
      { levelOnly: true, thinking: "high" },
    );

    expect(piPlan.piArgs).toContain("--thinking");
    expect(piPlan.piArgs).toContain("high");
    expect(piPlan.piArgs).not.toContain("--model");
  });

  it("carries a resolved reasoning effort onto codex's own config override", async () => {
    const { cwd, notify } = setup(makeAgent({ harnessType: "codex" }));

    const plan = await launch(
      "test-agent",
      cwd,
      notify,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        harness: "codex",
        key: "openai/gpt-6-sol",
        name: "GPT-6-Sol",
        thinking: "ultra",
      },
    );

    expect(plan.launch.thinking).toBe("ultra");
    expect(plan.piArgs).toEqual(
      expect.arrayContaining(["-c", 'model_reasoning_effort="ultra"']),
    );
  });

  it("carries a resolved effort onto claude's own --effort flag", async () => {
    const { cwd, notify } = setup(makeAgent({ harnessType: "claude" }));

    const plan = await launch(
      "test-agent",
      cwd,
      notify,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        harness: "claude",
        key: "anthropic/sonnet",
        name: "sonnet",
        thinking: "xhigh",
      },
    );

    expect(plan.launch.thinking).toBe("xhigh");
    expect(plan.piArgs).toEqual(expect.arrayContaining(["--effort", "xhigh"]));
  });

  it("hands codex its own family's request object for argv and prepare alike", async () => {
    const { cwd, notify } = setup(makeAgent({ harnessType: "codex" }));
    const spy = vi.spyOn(harnessFor("codex"), "buildArgs");

    const plan = await launch("test-agent", cwd, notify);
    const requests = spy.mock.calls.map(([request]) => request);
    spy.mockRestore();

    expect(requests[0]).toBe(plan.launch);
    expect(plan.launch).toEqual({
      family: "codex",
      subagentId: "runner-test",
      systemPromptFile: expect.any(String),
      taskFile: expect.any(String),
      resultFile: expect.any(String),
      modelKey: null,
      thinking: null,
      toolSelection: { kind: "default" },
      envFile: subagentEnvFileFor("runner-test"),
      projectTrusted: true,
    } satisfies CodexLaunchRequest);
  });

  /**
   * The request buildLaunchPlan hands the opencode harness. The spy calls
   * through, so the plan is still built by the harness's own argv; `requests`
   * is read before `restore`, which forgets the recordings.
   */
  function captureOpencodeBuildArgs(): {
    requests: () => HarnessLaunch[];
    restore: () => void;
  } {
    const spy = vi.spyOn(harnessFor("opencode"), "buildArgs");
    return {
      requests: () => spy.mock.calls.map(([request]) => request),
      restore: () => spy.mockRestore(),
    };
  }

  it("keys the plan's launch to the pi family, with no other family's inputs", async () => {
    const { cwd, notify } = setup(makeAgent({ harnessType: "pi" }));

    const plan = await launch("test-agent", cwd, notify);

    expect(plan.launch).toMatchObject({
      family: "pi",
      subagentId: "runner-test",
      modelKey: null,
      thinking: null,
      toolSelection: { kind: "default" },
      forkSessionFile: null,
      skills: { kind: "default" },
      extensions: { kind: "default" },
      projectTrusted: true,
    });
    expect(plan.launch).not.toHaveProperty("variant");
  });

  it("hands opencode the shared request, the level riding it as the harness reads it", async () => {
    const { cwd, notify } = setup(makeAgent({ harnessType: "opencode" }));
    const capture = captureOpencodeBuildArgs();

    const plan = await launch(
      "test-agent",
      cwd,
      notify,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        harness: "opencode",
        key: "anthropic/claude-opus-4",
        name: "claude-opus-4",
        thinking: "high",
      },
    );
    const requests = capture.requests();
    capture.restore();

    expect(plan.harness).toBe("opencode");
    expect(plan.launch).toEqual({
      family: "opencode",
      subagentId: "runner-test",
      systemPromptFile: expect.any(String),
      taskFile: expect.any(String),
      resultFile: expect.any(String),
      modelKey: "anthropic/claude-opus-4",
      thinking: "high",
      toolSelection: { kind: "default" },
      envFile: null,
    });
    // One object: the argv and the plan were built from the same request.
    expect(requests[0]).toBe(plan.launch);
  });

  it("carries no level and no pi flag when the template sets none", async () => {
    const { cwd, notify } = setup(makeAgent({ harnessType: "opencode" }));
    const capture = captureOpencodeBuildArgs();

    const plan = await launch("test-agent", cwd, notify);
    capture.restore();

    expect(plan.launch).toMatchObject({ family: "opencode", thinking: null });
    // Exactly the shared inputs plus the family tag: no pi input and no
    // opencode-only field rides this request.
    expect(Object.keys(plan.launch).sort()).toEqual([
      "envFile",
      "family",
      "modelKey",
      "resultFile",
      "subagentId",
      "systemPromptFile",
      "taskFile",
      "thinking",
      "toolSelection",
    ]);
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
    const { cwd, notify } = setup(
      makeAgent({ toolsByFamily: { pi: { tools: ["read", "web_search"] } } }),
    );
    const plan = await launch("test-agent", cwd, notify);

    expect(plan.piArgs).toContain("--tools");
    expect(plan.piArgs).toContain("read,web_search");
  });

  it("keeps a hidden agent's own tools", async () => {
    const { cwd, notify } = setup(
      makeAgent({
        hidden: true,
        toolsByFamily: { pi: { tools: ["read"] } },
      }),
    );
    const plan = await launch("test-agent", cwd, notify);

    expect(plan.piArgs).toContain("--tools");
    expect(plan.piArgs).toContain("read");
  });

  it("emits --no-tools for tools: false", async () => {
    const { cwd, notify } = setup(
      makeAgent({ toolsByFamily: { pi: { tools: false } } }),
    );
    const plan = await launch("test-agent", cwd, notify);

    expect(plan.piArgs).toContain("--no-tools");
  });

  it("emits --exclude-tools for an excludeTools list", async () => {
    const { cwd, notify } = setup(
      makeAgent({ toolsByFamily: { pi: { excludeTools: ["read"] } } }),
    );
    const plan = await launch("test-agent", cwd, notify);

    expect(plan.piArgs).toContain("--exclude-tools");
    expect(plan.piArgs).toContain("read");
  });

  it("rejects an empty tool name", async () => {
    const { cwd, notify } = setup(
      makeAgent({ toolsByFamily: { pi: { tools: ["read", ""] } } }),
    );

    await expect(launch("test-agent", cwd, notify)).rejects.toThrow(
      "Empty entry in tools",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Empty entry in tools"),
      "error",
    );
  });

  it("launches unfiltered under opencode when the template names only a pi slice", async () => {
    // A name list is catalogue-scoped: pi's slice is invisible to an opencode
    // launch, so it resolves to no filter rather than a translated one.
    const { cwd, notify } = setup(
      makeAgent({
        harnessType: "opencode",
        toolsByFamily: { pi: { tools: ["read"] } },
      }),
    );
    const plan = await launch("test-agent", cwd, notify);

    expect(plan.harness).toBe("opencode");
    expect(plan.launch.toolSelection).toEqual({ kind: "default" });
  });

  it("reads the opencode slice for an opencode launch", async () => {
    const { cwd, notify } = setup(
      makeAgent({
        harnessType: "opencode",
        toolsByFamily: { opencode: { tools: ["read", "glob"] } },
      }),
    );
    const plan = await launch("test-agent", cwd, notify);

    expect(plan.harness).toBe("opencode");
    expect(plan.launch.toolSelection).toEqual({
      kind: "include",
      names: ["read", "glob"],
    });
  });

  it("reads an opencode excludeTools slice for an opencode launch", async () => {
    const { cwd, notify } = setup(
      makeAgent({
        harnessType: "opencode",
        toolsByFamily: { opencode: { excludeTools: ["write"] } },
      }),
    );
    const plan = await launch("test-agent", cwd, notify);

    expect(plan.harness).toBe("opencode");
    expect(plan.launch.toolSelection).toEqual({
      kind: "exclude",
      names: ["write"],
    });
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
    expect(plan.launch.systemPromptFile).toBe(value);
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
      harness: resolveHarnessType("test-agent"),
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
      "write your complete final answer, once, to the file:",
    );
    expect(system).toContain(plan.launch.resultFile);
    // The parent reads the deliverable back on this exact wording.
    expect(system).toContain("That write is your last action.");
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
          harness: resolveHarnessType("general-purpose"),
          cwd,
        },
      );
      const modeOf = (target: string): number =>
        fs.statSync(target).mode & 0o777;
      expect(modeOf(path.join(subagentResultDir(), agentId))).toBe(0o700);
      expect(modeOf(plan.launch.systemPromptFile)).toBe(0o600);
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

/**
 * A plugin harness reaches the plan through the same path a built-in does, and
 * carries only the shared inputs: its own argv, no built-in family's option, and
 * its own model catalogue (a template's family-keyed model cannot answer for it).
 */
describe("buildLaunchPlan — a plugin harness", () => {
  /** A plugin harness whose argv is its own, so a plan built from it is unmistakable. */
  function pluginHarness(id: string, argv: string[]): PluginHarness {
    return {
      id,
      displayName: id,
      agentMultiplexerKind: id,
      availability: () => ({ status: "available" }),
      prepare: async () => {},
      buildArgs: () => argv,
      teardown: async () => {},
      listModels: async () => ({ kind: "listed", entries: [] }),
      prefetchModels: () => {},
    };
  }

  it("builds the plugin's own argv and carries no built-in family's inputs", async () => {
    harnesses.register(
      pluginHarness("runner-plugin", ["runner-plugin", "--task"]),
    );
    // A plugin harness is reachable through the config setting, never a template.
    setGlobalAgentSettings({ harnessType: "runner-plugin" });
    const { cwd, notify } = setup(makeAgent({ harnessType: undefined }));

    const plan = await launch("test-agent", cwd, notify);

    expect(plan.harness).toBe("runner-plugin");
    expect(plan.piArgs).toEqual(["runner-plugin", "--task"]);
    expect(plan.launch).toMatchObject({
      family: "plugin",
      subagentId: "runner-test",
      toolSelection: { kind: "default" },
    });
    // No built-in family's option rides a plugin request.
    expect(Object.keys(plan.launch).sort()).toEqual([
      "envFile",
      "family",
      "modelKey",
      "resultFile",
      "subagentId",
      "systemPromptFile",
      "taskFile",
      "thinking",
      "toolSelection",
    ]);
  });

  it("launches unfiltered even when the template filters a built-in family", async () => {
    harnesses.register(pluginHarness("runner-plugin-2", ["runner-plugin-2"]));
    // The filter is keyed to pi; a plugin family has no slice, so it applies none.
    setGlobalAgentSettings({ harnessType: "runner-plugin-2" });
    const { cwd, notify } = setup(
      makeAgent({
        harnessType: undefined,
        toolsByFamily: { pi: { tools: ["read"] } },
      }),
    );

    const plan = await launch("test-agent", cwd, notify);

    expect(plan.launch).toMatchObject({ toolSelection: { kind: "default" } });
  });

  it("reads the plugin family's own default model, never the pi family's", () => {
    // Model resolution is the store's, not the plan's: the plan carries whatever
    // key the caller resolved, so this pins the resolution itself.
    setGlobalAgentSettings({
      default: "anthropic/claude-sonnet-4",
      defaultModelByHarness: { "runner-plugin-3": "openai/gpt-4o" },
    });
    const store = storeRef.current;

    expect(
      store.modelFor("test-agent", null, undefined, "runner-plugin-3"),
    ).toBe("openai/gpt-4o");
    // The pi family's default does not answer for a plugin harness, and the
    // plugin's entry does not answer for pi.
    expect(store.modelFor("test-agent", null, undefined, "pi")).toBe(
      "anthropic/claude-sonnet-4",
    );
  });
});

/**
 * The variables a plan stages, read back from the file the pane's launcher
 * sources. The names and values every test here uses are plain shell words.
 */
function stagedEnv(launch: HarnessLaunch): Record<string, string> {
  if (launch.envFile === null) return {};
  const lines = fs.readFileSync(launch.envFile, "utf-8").trim().split("\n");
  return Object.fromEntries(
    lines.map((line) => {
      const match = /^export ([A-Za-z_][A-Za-z0-9_]*)='(.*)'$/.exec(line);
      if (match === null) throw new Error(`unexpected env line: ${line}`);
      return [match[1]!, match[2]!];
    }),
  );
}

describe("buildLaunchPlan — env overrides", () => {
  it("layers the template's family table over the machine's harness env, then drops a name the harness owns", async () => {
    const { cwd, notify } = setup(
      makeAgent({
        harnessType: "codex",
        envByFamily: {
          codex: trustedEnv({ SHARED: "template", TEMPLATE_ONLY: "yes" }),
        },
      }),
    );
    storeRef.current = loadedStore(
      memoryIO({
        harness: {
          codex: {
            env: {
              SHARED: "config",
              CONFIG_ONLY: "yes",
              CODEX_HOME: "/elsewhere",
            },
          },
        },
      }),
    );

    // codex's own home: the reserved name is supplied by the launch, so the
    // configured `/elsewhere` above is refused and this value reaches the pane.
    process.env.CODEX_HOME = "/process/codex-home";
    try {
      const plan = await launch("test-agent", cwd, notify);

      expect(stagedEnv(plan.launch)).toEqual({
        SHARED: "template",
        TEMPLATE_ONLY: "yes",
        CONFIG_ONLY: "yes",
        CODEX_HOME: "/process/codex-home",
      });
      // Owner-only: the variables are usually credentials.
      const envFile = plan.launch.envFile;
      if (envFile === null) throw new Error("no env file was staged");
      expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
      const warnings = notify.mock.calls.map(([message]) => String(message));
      expect(warnings.some((warning) => warning.includes("CODEX_HOME"))).toBe(
        true,
      );
    } finally {
      delete process.env.CODEX_HOME;
    }
  });

  it("reads the machine's env for a plugin harness too, which has no template family", async () => {
    harnesses.register({
      id: "env-plugin",
      displayName: "Env Plugin",
      agentMultiplexerKind: "pi",
      availability: () => ({ status: "available" }),
      prepare: async () => {},
      buildArgs: () => [],
      teardown: async () => {},
      listModels: async () => ({ kind: "listed", entries: [] }),
      prefetchModels: () => {},
      reservedEnvVars: () => ["PLUGIN_OWNED"],
    } as PluginHarness);
    const { cwd, notify } = setup(makeAgent({ harnessType: "env-plugin" }));
    storeRef.current = loadedStore(
      memoryIO({
        harness: {
          "env-plugin": {
            env: { PLUGIN_FLAG: "1", PLUGIN_OWNED: "no" },
          },
        },
      }),
    );

    const plan = await launch("test-agent", cwd, notify);

    expect(stagedEnv(plan.launch)).toEqual({ PLUGIN_FLAG: "1" });
    expect(
      notify.mock.calls.some(([message]) =>
        String(message).includes("PLUGIN_OWNED"),
      ),
    ).toBe(true);
  });

  it("stages the variables a plugin harness declares as its launch's own", async () => {
    harnesses.register({
      id: "store-plugin",
      displayName: "Store Plugin",
      agentMultiplexerKind: "pi",
      availability: () => ({ status: "available" }),
      prepare: async () => {},
      buildArgs: () => [],
      teardown: async () => {},
      listModels: async () => ({ kind: "listed", entries: [] }),
      prefetchModels: () => {},
      // The name is reserved because the launch owns it, so the reservation
      // must not drop the very value the launch is supplying.
      reservedEnvVars: () => ["PLUGIN_STORE"],
      inheritedEnv: () => ({ PLUGIN_STORE: "/var/plugin" }),
    } as PluginHarness);
    const { cwd, notify } = setup(makeAgent({ harnessType: "store-plugin" }));
    storeRef.current = loadedStore(
      memoryIO({
        harness: { "store-plugin": { env: { PLUGIN_STORE: "/elsewhere" } } },
      }),
    );

    const plan = await launch("test-agent", cwd, notify);

    expect(stagedEnv(plan.launch)).toEqual({ PLUGIN_STORE: "/var/plugin" });
    expect(
      notify.mock.calls.some(([message]) =>
        String(message).includes("PLUGIN_STORE"),
      ),
    ).toBe(true);
  });

  it("drops an inherited name the shell could not read, staging no file", async () => {
    harnesses.register({
      id: "unreadable-store-plugin",
      displayName: "Unreadable Store Plugin",
      agentMultiplexerKind: "pi",
      availability: () => ({ status: "available" }),
      prepare: async () => {},
      buildArgs: () => [],
      teardown: async () => {},
      listModels: async () => ({ kind: "listed", entries: [] }),
      prefetchModels: () => {},
      inheritedEnv: () => ({ "BAD NAME": "/var/plugin" }),
    } as PluginHarness);
    const { cwd, notify } = setup(
      makeAgent({ harnessType: "unreadable-store-plugin" }),
    );

    const plan = await launch("test-agent", cwd, notify);

    expect(plan.launch.envFile).toBeNull();
    expect(
      notify.mock.calls.some(([message]) =>
        String(message).includes("BAD NAME"),
      ),
    ).toBe(true);
  });

  it("does not hand another family's store name to a codex launch", async () => {
    const { cwd, notify } = setup(makeAgent({ harnessType: "codex" }));
    process.env.PI_CODING_AGENT_SESSION_DIR = path.join(
      cwd,
      "sessions-override",
    );
    try {
      const plan = await launch("test-agent", cwd, notify);

      expect(stagedEnv(plan.launch)).not.toHaveProperty(
        "PI_CODING_AGENT_SESSION_DIR",
      );
    } finally {
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
    }
  });

  it("stages a codex launch's own home with nothing configured", async () => {
    const { cwd, notify } = setup(makeAgent({ harnessType: "codex" }));

    const plan = await launch("test-agent", cwd, notify);

    // The pane is handed the very home the handover export reads the run's
    // rollout back from.
    expect(stagedEnv(plan.launch)).toEqual({
      CODEX_HOME: codexHomeDirectory(),
    });
  });

  it("hands a pi child this process's own store overrides", async () => {
    const { cwd, notify } = setup(makeAgent({ harnessType: "pi" }));
    const sessionDir = path.join(cwd, "sessions-override");
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    try {
      const plan = await launch("test-agent", cwd, notify);

      // The export reads these same two variables from this process, so the
      // child must write where that read points.
      expect(stagedEnv(plan.launch)).toEqual({
        PI_CODING_AGENT_DIR: path.join(cwd, "agent"),
        PI_CODING_AGENT_SESSION_DIR: sessionDir,
      });
    } finally {
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
    }
  });

  it("drops a store name the pig harness reserves, so nothing can move its child", async () => {
    const { cwd, notify } = setup(makeAgent({ harnessType: "pig" }));
    const previousPigHome = process.env.PIG_HOME;
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    delete process.env.PIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    storeRef.current = loadedStore(
      memoryIO({
        harness: { pig: { env: { PIG_HOME: "/elsewhere", PIG_KEEP: "1" } } },
      }),
    );

    try {
      const plan = await launch("test-agent", cwd, notify);

      // pig's root decides where the run writes and where its export reads, so a
      // configured entry for it is dropped; a name pig does not own is carried.
      expect(stagedEnv(plan.launch)).toEqual({ PIG_KEEP: "1" });
      expect(
        notify.mock.calls.some(([message]) =>
          String(message).includes("PIG_HOME"),
        ),
      ).toBe(true);
    } finally {
      if (previousPigHome === undefined) delete process.env.PIG_HOME;
      else process.env.PIG_HOME = previousPigHome;
      if (previousXdgConfigHome === undefined)
        delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
  });
});
