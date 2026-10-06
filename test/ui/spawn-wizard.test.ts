/**
 * Characterization suite for the spawn wizard: options → worktree name → prompt → spawn.
 *
 * Asserts the exact argument object handed to the (faked) coordinator.
 *
 * Mocked boundaries: src/shell.js (store, session, coordinator spy),
 * `AgentSandbox.allocate` (so no real git/herdr work happens), and `git` (scripted pi.exec).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerAgents } from "../../src/agents/agent-types.js";
import { registerOrchestrators } from "../../src/orchestrators/orchestrator-types.js";
import { DEFAULT_ORCHESTRATORS } from "../../src/orchestrators/default-orchestrators.js";
import type { OrchestratorConfig } from "../../src/orchestrators/types.js";
import {
  SPAWN_ID_ALPHABET,
  SPAWN_ID_LENGTH,
} from "../../src/spawn/spawn-id.js";
import { KEY, openMenu, type MenuSession } from "./harness.js";
import {
  resetShell,
  setCoordinator,
  setManager,
  setPi,
  setRuntime,
  setSession,
} from "./shell-mock.js";
import { createMemoryStore, type MemoryStore } from "./store.js";
import { plainModel, reasoningModel, registryOver } from "./models.js";
import { walk } from "./walk.js";

vi.mock("../../src/shell.js", () => import("./shell-mock.js"));

const { allocateMock, teardownMock } = vi.hoisted(() => ({
  allocateMock: vi.fn(),
  teardownMock: vi.fn(),
}));
vi.mock("../../src/spawn/sandbox.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/spawn/sandbox.js")>();
  return { ...actual, AgentSandbox: { allocate: allocateMock } };
});

const { showSpawnAgentMenu } =
  await import("../../src/ui/menu/menu-spawn-wizard.js");

/** Models the wizard can resolve through the session registry. */
const AVAILABLE_MODELS = [
  reasoningModel("openai", "gpt-4"),
  plainModel("openai", "gpt-3"),
];
const MODEL_OPTIONS = ["openai/gpt-4", "openai/gpt-3", "anthropic/claude-3"];

const GIT_WORKTREES = [
  "worktree /repo",
  "HEAD aaaaaaa",
  "branch refs/heads/main",
  "",
  "worktree /repo/.worktrees/feat-one",
  "HEAD bbbbbbb",
  "branch refs/heads/cow-feat-one-1234",
  "",
].join("\n");

interface SpawnCall {
  session: unknown;
  args: Record<string, unknown>;
  invocation: Record<string, unknown>;
}

const spawnCalls: SpawnCall[] = [];

/** Host address the faked sandbox adoption returns. */
const SANDBOX_REF = {
  engine: "herdr",
  name: "cow-my-thing",
  paneId: "pane-1",
  tabId: "tab-1",
  workspaceId: "ws-1",
  paneCreated: false,
};

/** The fake `AgentSandbox.allocate` result for a created worktree. */
function fakeSandbox(path: string, branch: string) {
  return {
    worktree: { path, branch },
    hostRef: { ...SANDBOX_REF, name: branch },
    projectTrusted: true,
    teardown: teardownMock,
  };
}
let memory: MemoryStore;
/** Spawn ids minted through the manager: deterministic, Crockford-valid, shared by spawn id and branch suffix. */
let mintedIds: string[] = [];
let mintedCount = 0;

interface SetupOptions {
  /** Scripted `git` behaviour for the worktree picker. */
  gitRepo?: boolean;
  global?: Record<string, unknown>;
}

function scriptGitGitRepo(): void {
  setPi({
    exec: async (_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse") {
        return { code: 0, stdout: ".git\n", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return { code: 0, stdout: GIT_WORKTREES, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unsupported" };
    },
  });
}

function setup(options: SetupOptions = {}): void {
  resetShell();
  spawnCalls.length = 0;
  // Default: not a git repo (the worktree probe fails fast).
  setPi({ exec: async () => ({ code: 1, stdout: "", stderr: "" }) });
  if (options.gitRepo) scriptGitGitRepo();

  memory = createMemoryStore({
    projectStatus: "absent",
    global: options.global,
  });
  memory.install();
  registerAgents(
    new Map([
      [
        "auditor",
        {
          name: "auditor",
          displayName: "Auditor",
          description: "Audits a change",
          systemPrompt: "",
        },
      ],
    ]),
  );
  setSession({
    cwd: "/repo",
    model: undefined,
    modelRegistry: registryOver(AVAILABLE_MODELS),
  } as unknown as Parameters<typeof setSession>[0]);
  setCoordinator({
    spawn: async (session: unknown, args: Record<string, unknown>) => {
      spawnCalls.push({
        session,
        args,
        invocation: (args.invocation ?? {}) as Record<string, unknown>,
      });
    },
  });
  mintedCount = 0;
  mintedIds = [];
  setManager({
    mintSpawnId: () => {
      const id = String(++mintedCount).padStart(8, "0");
      mintedIds.push(id);
      return id;
    },
  });
  setRuntime({ host: {} });
  allocateMock.mockReset();
  teardownMock.mockReset();
  teardownMock.mockResolvedValue({ kind: "absent" });
  allocateMock.mockResolvedValue(
    fakeSandbox("/repo/.worktrees/cow-my-thing", "cow-my-thing"),
  );
}

const WIDE = 120;

function openWizard(): MenuSession {
  return openMenu(
    (ctx: ExtensionCommandContext) => showSpawnAgentMenu(ctx, MODEL_OPTIONS),
    WIDE,
  );
}

/** Opens the wizard and stops on the options screen, its only entry screen. */
async function toSpawnOptions(session: MenuSession): Promise<void> {
  await session.whenScreens(1);
  await session.settle();
}

/** Picks a type on the Type row. */
async function pickType(session: MenuSession, type: string): Promise<void> {
  session.open("Type");
  await session.settle();
  session.open(`• ${type}`);
  await session.settle();
}

/**
 * Presses Spawn and answers what it asks for: the worktree name when the target
 * is new, then the prompt. `name` is only read when the name field appears.
 */
async function spawnWith(
  session: MenuSession,
  options: { name?: string; prompt?: string } = {},
): Promise<void> {
  session.focus("Spawn");
  session.press(KEY.enter);
  await session.settle();

  if (session.title() === "Worktree Name") {
    session.fillField(options.name ?? "");
    session.press(KEY.enter);
    await session.settle();
  }

  if (options.prompt !== undefined) session.typeText(options.prompt);
  session.press(KEY.enter);
  await session.settle();
}

beforeEach(() => setup());

describe("Spawn wizard — options screen", () => {
  it("leads with the Spawn row and every option, prompting after Spawn", async () => {
    const session = openWizard();
    await toSpawnOptions(session);

    expect(session.title()).toBe("Spawn Options");
    expect(session.walkRows()).toEqual([
      { label: "Spawn", value: "" },
      { label: "Type", value: "general-purpose" },
      { label: "Model", value: "(no model)" },
      { label: "Background", value: "ON" },
      { label: "Fork session", value: "No" },
      { label: "Thinking level", value: "inherit" },
      { label: "Description", value: "" },
    ]);
    expect(session.text()).not.toContain("Worktree");
    // The prompt is asked after Spawn, so it is no longer a row here.
    expect(session.rows().map((row) => row.label)).not.toContain("Prompt");
  });

  it("cancels the whole wizard without spawning", async () => {
    const session = openWizard();
    await toSpawnOptions(session);

    session.press(KEY.escape);
    await session.settle();

    expect(session.screenCount).toBe(1);
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("Spawn wizard — type row", () => {
  it("opens the type picker from its row", async () => {
    const session = openWizard();
    await toSpawnOptions(session);

    session.open("Type");
    await session.settle();

    expect(session.title()).toBe("Spawn Options");
    expect(session.text()).toContain("• auditor");

    // The selected row's description reads under the list.
    session.focus("• auditor");
    expect(session.text()).toContain("Audits a change");
  });

  it("filters the list as the search query is typed", async () => {
    const session = openWizard();
    await toSpawnOptions(session);

    session.open("Type");
    await session.settle();
    session.press("a");
    session.press("u");
    session.press("d");
    await session.settle();

    expect(session.text()).toContain("aud");
    expect(session.text()).toContain("• auditor");
    expect(session.text()).not.toContain("• general-purpose");
  });

  it("leaves the row unchanged when the picker is escaped", async () => {
    const session = openWizard();
    await toSpawnOptions(session);

    session.open("Type");
    await session.settle();
    session.press(KEY.escape);
    await session.settle();

    expect(session.rows()).toContainEqual({
      label: "Type",
      value: "general-purpose",
    });
  });

  it("leads with the configured default agent type", async () => {
    setup({ global: { agent: { defaultAgentType: "auditor" } } });
    const session = openWizard();
    await toSpawnOptions(session);

    expect(session.rows()).toContainEqual({ label: "Type", value: "auditor" });
  });

  it("carries the picked type into the spawn", async () => {
    const session = openWizard();
    await toSpawnOptions(session);

    await pickType(session, "auditor");
    expect(session.rows()).toContainEqual({ label: "Type", value: "auditor" });

    await spawnWith(session, { prompt: "Do the thing" });

    expect(spawnCalls[0]!.args.type).toBe("auditor");
  });
});

describe("Spawn wizard — spawn", () => {
  it("hands the coordinator the args built from the defaults", async () => {
    const session = openWizard();
    await toSpawnOptions(session);

    await walk(
      session,
      [
        { open: "Type" },
        { open: "• auditor" },
        { expect: { rows: [["Type", "auditor"]] } },
        { focus: "Spawn" },
        { enter: true },
        { expect: { title: "Agent Prompt" } },
        { fill: "Do the thing" },
        { enter: true },
      ],
      memory.store,
      "spawn with defaults",
    );

    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0]!;
    expect(call.session).toEqual(expect.objectContaining({ cwd: "/repo" }));
    expect(call.args).toMatchObject({
      type: "auditor",
      prompt: "Do the thing",
      description: "Do the thing",
      runInBackground: true,
    });
    // Parent-cwd run: no worktree coordinates ride along.
    expect(call.args.worktree).toBeUndefined();
    expect(call.args.spawnId).toBe(mintedIds[0]);
    expect(call.args.spawnId).toMatch(
      new RegExp(`^[${SPAWN_ID_ALPHABET}]{${SPAWN_ID_LENGTH}}$`),
    );
    expect(call.args.modelSelection).toBeUndefined();
    expect(call.args.thinkingLevel).toBeUndefined();
    expect(call.args.fork).toBe(false);
    // toEqual: every invocation key present, unset ones explicit.
    expect(call.invocation).toEqual({
      modelName: undefined,
      thinkingLevel: undefined,
      runInBackground: true,
      fork: false,
    });
    // The in-progress line names the id before anything slow runs.
    expect(session.notifications.map((n) => n.message)).toContain(
      `Spawning agent ${String(call.args.spawnId)} (auditor) …`,
    );
  });

  it("hands the coordinator the configured default orchestrator", async () => {
    setup({ global: { agent: { defaultOrchestrator: "with-code-review" } } });
    const configured: OrchestratorConfig = {
      ...DEFAULT_ORCHESTRATORS.default,
      name: "with-code-review",
      guidance: "Run the code review tool before committing.",
    };
    registerOrchestrators(new Map([[configured.name, configured]]));

    const session = openWizard();
    await toSpawnOptions(session);
    await spawnWith(session, { prompt: "Do the thing" });

    expect(spawnCalls).toHaveLength(1);
    // The whole template rides on the spawn; the child's launch plan renders
    // its guidance section from this field.
    expect(spawnCalls[0]!.args.orchestration).toEqual(configured);
  });

  it("derives the description from the prompt when the row is left empty", async () => {
    const session = openWizard();
    await toSpawnOptions(session);
    const prompt = "Do the thing and make it long enough to be truncated";

    await spawnWith(session, { prompt });

    expect(prompt.length).toBeGreaterThan(50);
    expect(spawnCalls[0]!.args.description).toBe(prompt.slice(0, 50));
  });

  it("spawns with no task when the prompt step is submitted empty", async () => {
    const session = openWizard();
    await toSpawnOptions(session);

    await spawnWith(session);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.args.prompt).toBe("");
    expect(spawnCalls[0]!.args.description).toBe("");
  });

  it("cancels from the prompt step without spawning", async () => {
    const session = openWizard();
    await toSpawnOptions(session);

    session.focus("Spawn");
    session.press(KEY.enter);
    await session.settle();
    expect(session.title()).toBe("Agent Prompt (optional)");

    session.press(KEY.escape);
    await session.settle();

    expect(spawnCalls).toHaveLength(0);
    expect(session.closedScreens).toContain(1);
  });

  it("takes a multi-line prompt, Shift+Enter for each newline", async () => {
    const session = openWizard();
    await toSpawnOptions(session);

    session.focus("Spawn");
    session.press(KEY.enter);
    await session.settle();

    session.typeText("Fix the flaky test");
    session.press(KEY.newline);
    session.typeText("then report back");
    await session.settle();
    // The editor wraps the text rather than scrolling it sideways.
    expect(session.text()).toContain("Fix the flaky test");
    expect(session.text()).toContain("then report back");

    session.press(KEY.enter);
    await session.settle();

    expect(spawnCalls[0]!.args.prompt).toBe(
      "Fix the flaky test\nthen report back",
    );
  });

  it("forks the parent session when the Fork session row is toggled on", async () => {
    const session = openWizard();
    await toSpawnOptions(session);

    session.focus("Fork session");
    session.press(KEY.enter);
    await session.settle();

    expect(session.rows()).toContainEqual({
      label: "Fork session",
      value: "Yes",
    });

    await spawnWith(session, { prompt: "Do the thing" });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.args.fork).toBe(true);
    expect(spawnCalls[0]!.invocation.fork).toBe(true);
  });

  it("passes what the option rows were edited to", async () => {
    const session = openWizard();
    await toSpawnOptions(session);

    session.focus("Background");
    session.press(KEY.enter);
    await session.settle();

    await walk(
      session,
      [
        { open: "Description" },
        { fill: "short label" },
        { enter: true },
        { expect: { rows: [["Description", "short label"]] } },
        { focus: "Spawn" },
        { enter: true },
        { fill: "A different prompt" },
        { enter: true },
      ],
      memory.store,
      "spawn with edited options",
    );

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.args).toMatchObject({
      prompt: "A different prompt",
      description: "short label",
      runInBackground: false,
    });
    expect(spawnCalls[0]!.invocation).toMatchObject({
      runInBackground: false,
    });
  });

  it("resolves the configured default model and records it in the invocation", async () => {
    setup({ global: { agent: { default: "openai/gpt-4" } } });
    const session = openWizard();
    await toSpawnOptions(session);

    expect(session.rows()).toContainEqual({
      label: "Model",
      value: "openai/gpt-4",
    });

    await spawnWith(session, { prompt: "Do the thing" });

    expect(spawnCalls[0]!.args.modelSelection).toEqual({
      model: expect.objectContaining({ provider: "openai", id: "gpt-4" }),
      key: "openai/gpt-4",
    });
    expect(spawnCalls[0]!.invocation.modelName).toBe("gpt-4");
  });

  it("refuses to spawn when the configured model is not in the registry", async () => {
    setup({ global: { agent: { default: "anthropic/claude-3" } } });
    const session = openWizard();
    await toSpawnOptions(session);

    session.focus("Spawn");
    session.press(KEY.enter);
    await session.settle();

    expect(session.notifications.map((n) => n.message)).toContain(
      "Model not found: anthropic/claude-3",
    );
    // The options screen is still up: no name field, no prompt, no spawn.
    expect(session.title()).toBe("Spawn Options");
    expect(session.screenCount).toBe(1);
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("Spawn wizard — model and thinking level", () => {
  it("offers the supported levels of a reasoning model plus inherit", async () => {
    setup({ global: { agent: { default: "openai/gpt-4" } } });
    const session = openWizard();
    await toSpawnOptions(session);

    session.open("Thinking level");
    await session.settle();

    expect(session.walkRows().map((row) => row.label)).toEqual([
      "Off",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Inherit",
    ]);
  });

  it("carries a chosen level into the spawn args", async () => {
    setup({ global: { agent: { default: "openai/gpt-4" } } });
    const session = openWizard();
    await toSpawnOptions(session);

    session.open("Thinking level");
    await session.settle();
    session.open("High");
    await session.settle();

    expect(session.rows()).toContainEqual({
      label: "Thinking level",
      value: "high",
    });

    await spawnWith(session, { prompt: "Do the thing" });

    expect(spawnCalls[0]!.args.thinkingLevel).toBe("high");
    expect(spawnCalls[0]!.invocation.thinkingLevel).toBe("high");
  });

  it("maps inherit back to an unset level", async () => {
    setup({
      global: { agent: { default: "openai/gpt-4", defaultThinking: "high" } },
    });
    const session = openWizard();
    await toSpawnOptions(session);
    expect(session.rows()).toContainEqual({
      label: "Thinking level",
      value: "high",
    });

    session.open("Thinking level");
    await session.settle();
    session.open("Inherit");
    await session.settle();

    expect(session.rows()).toContainEqual({
      label: "Thinking level",
      value: "inherit",
    });

    await spawnWith(session, { prompt: "Do the thing" });

    expect(spawnCalls[0]!.args.thinkingLevel).toBeUndefined();
  });

  it("clamps the level when the picked model does not support it", async () => {
    setup({
      global: { agent: { default: "openai/gpt-4", defaultThinking: "high" } },
    });
    const session = openWizard();
    await toSpawnOptions(session);

    await walk(
      session,
      [
        { open: "Model" },
        { expect: { active: "Session", shows: ["Not saved"] } },
        { open: "Session" },
        { open: "gpt-3 [openai]" },
        {
          expect: {
            // gpt-3 is non-reasoning, so the displayed level clamps to "off".
            rows: [
              ["Model", "openai/gpt-3"],
              ["Thinking level", "off"],
            ],
          },
        },
        { focus: "Spawn" },
        { enter: true },
        { fill: "Do the thing" },
        { enter: true },
      ],
      memory.store,
      "clamp on model change",
    );

    expect(spawnCalls[0]!.args.thinkingLevel).toBe("off");
  });
});

describe("Spawn wizard — worktree picker", () => {
  it("defaults the row to a new worktree", async () => {
    setup({ gitRepo: true });
    const session = openWizard();
    await toSpawnOptions(session);

    expect(session.rows()).toContainEqual({
      label: "Worktree",
      value: "New worktree",
    });
  });

  it("lists the repo's worktrees and spawns into the picked one", async () => {
    setup({ gitRepo: true });
    const session = openWizard();
    await toSpawnOptions(session);

    session.open("Worktree");
    await session.settle();
    expect(session.text()).toContain("Inherits parent cwd");
    expect(session.text()).toContain("/repo/.worktrees/feat-one");

    session.open(/^\/repo\/\.worktrees\/feat-one/);
    await session.settle();
    expect(session.rows()).toContainEqual({
      label: "Worktree",
      value: "cow-feat-one-1234",
    });

    // A picked tree is already named: Spawn goes straight to the prompt.
    await spawnWith(session, { prompt: "Do the thing" });
    expect(session.closedScreens).toHaveLength(2);

    expect(allocateMock).not.toHaveBeenCalled();
    expect(spawnCalls[0]!.args.worktree).toEqual({
      kind: "picked",
      path: "/repo/.worktrees/feat-one",
      branch: "cow-feat-one-1234",
    });
  });

  it("returns to the parent cwd when the inherit entry is picked", async () => {
    setup({ gitRepo: true });
    const session = openWizard();
    await toSpawnOptions(session);

    session.open("Worktree");
    await session.settle();
    session.open(/^\/repo\/\.worktrees\/feat-one/);
    await session.settle();

    session.open("Worktree");
    await session.settle();
    session.open("Inherits parent cwd");
    await session.settle();

    expect(session.rows()).toContainEqual({
      label: "Worktree",
      value: "Inherits parent cwd",
    });

    await spawnWith(session, { prompt: "Do the thing" });

    expect(spawnCalls[0]!.args.worktree).toBeUndefined();
  });

  it("goes back to a new worktree after an existing one was picked", async () => {
    setup({ gitRepo: true });
    const session = openWizard();
    await toSpawnOptions(session);

    session.open("Worktree");
    await session.settle();
    session.open(/^\/repo\/\.worktrees\/feat-one/);
    await session.settle();

    session.open("Worktree");
    await session.settle();
    session.open("New worktree");
    await session.settle();

    // No name field in the picker: the row only records the choice.
    expect(session.rows()).toContainEqual({
      label: "Worktree",
      value: "New worktree",
    });
  });

  it("omits the worktree row for a non-git cwd", async () => {
    const session = openWizard();
    await toSpawnOptions(session);

    expect(session.rows().map((row) => row.label)).not.toContain("Worktree");
  });
});

/** The Description row survives the rebuild and reaches the spawn. */
describe("Spawn wizard — description row", () => {
  it("keeps an edited description and spawns with it", async () => {
    const session = openWizard();
    await toSpawnOptions(session);

    session.open("Description");
    session.fillField("short label");
    session.press(KEY.enter);
    await session.settle();

    expect(session.rows()).toContainEqual({
      label: "Description",
      value: "short label",
    });

    await spawnWith(session, { prompt: "Do the thing" });

    expect(spawnCalls[0]!.args.description).toBe("short label");
  });
});

/** Creating a fresh, owned worktree: the name is asked after Spawn. */
describe("Spawn wizard — new worktree", () => {
  it("asks for the name after Spawn, prefilled with cow-", async () => {
    setup({ gitRepo: true });
    const session = openWizard();
    await toSpawnOptions(session);

    session.focus("Spawn");
    session.press(KEY.enter);
    await session.settle();

    expect(session.title()).toBe("Worktree Name");
    expect(session.text()).toContain("cow-");
    expect(session.activeRow()).toBeNull();

    // The caret sits after the prefix, so typing continues the name.
    session.typeText("my-thing");
    await session.settle();
    expect(session.text()).toContain("cow-my-thing");
  });

  it("keeps the field open and re-prompts on a rejected name", async () => {
    setup({ gitRepo: true });
    const session = openWizard();
    await toSpawnOptions(session);

    session.focus("Spawn");
    session.press(KEY.enter);
    await session.settle();

    session.fillField("cow-");
    session.press(KEY.enter);
    await session.settle();
    expect(session.notifications.map((n) => n.message)).toContain(
      'Enter a name after "cow-" (for example cow-fix-login).',
    );
    expect(session.title()).toBe("Worktree Name");

    session.fillField("cow-Bad Name");
    session.press(KEY.enter);
    await session.settle();
    expect(session.notifications.map((n) => n.message)).toContain(
      "Invalid name: only lowercase letters, numbers, hyphens, and underscores allowed.",
    );

    session.fillField("plain-name");
    session.press(KEY.enter);
    await session.settle();
    expect(session.notifications.map((n) => n.message)).toContain(
      'Worktree name must start with "cow-" — it is prefilled; add your name after it.',
    );

    session.fillField("cow-my-thing");
    session.press(KEY.enter);
    await session.settle();

    expect(session.title()).toBe("Agent Prompt (optional)");
    expect(spawnCalls).toHaveLength(0);
    expect(allocateMock).not.toHaveBeenCalled();
  });

  it("allocates an owned worktree for the typed name and spawns into it", async () => {
    setup({ gitRepo: true });
    const session = openWizard();
    await toSpawnOptions(session);

    await spawnWith(session, { name: "cow-my-thing", prompt: "Do the thing" });

    expect(allocateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        naming: { kind: "explicit", branch: "cow-my-thing" },
        parentCwd: "/repo",
        worktreeRoot: undefined,
        materialization: "copy-on-write",
      }),
    );
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.args.worktree).toEqual({
      kind: "owned",
      path: "/repo/.worktrees/cow-my-thing",
      branch: "cow-my-thing",
    });
    expect(spawnCalls[0]!.args.hostRef).toEqual({
      ...SANDBOX_REF,
      name: "cow-my-thing",
    });
    expect(spawnCalls[0]!.args.projectTrusted).toBe(true);
  });

  it("mints the spawn id before allocating the worktree, so the line can name it", async () => {
    setup({ gitRepo: true });
    let mintedAtAllocation: string[] = [];
    allocateMock.mockImplementation(async () => {
      mintedAtAllocation = [...mintedIds];
      return fakeSandbox("/repo/.worktrees/cow-my-thing", "cow-my-thing");
    });
    const session = openWizard();
    await toSpawnOptions(session);

    await spawnWith(session, { name: "cow-my-thing", prompt: "Do the thing" });

    expect(mintedAtAllocation).toEqual([spawnCalls[0]!.args.spawnId]);
  });

  it("spawns nothing when the name field is escaped", async () => {
    setup({ gitRepo: true });
    const session = openWizard();
    await toSpawnOptions(session);

    session.focus("Spawn");
    session.press(KEY.enter);
    await session.settle();
    expect(session.title()).toBe("Worktree Name");

    session.press(KEY.escape);
    await session.settle();

    expect(session.title()).toBe("Worktree Name");
    expect(allocateMock).not.toHaveBeenCalled();
    expect(spawnCalls).toHaveLength(0);
  });

  it("creates no worktree when the prompt step is escaped afterwards", async () => {
    setup({ gitRepo: true });
    const session = openWizard();
    await toSpawnOptions(session);

    session.focus("Spawn");
    session.press(KEY.enter);
    await session.settle();
    session.fillField("cow-my-thing");
    session.press(KEY.enter);
    await session.settle();
    expect(session.title()).toBe("Agent Prompt (optional)");

    session.press(KEY.escape);
    await session.settle();

    expect(allocateMock).not.toHaveBeenCalled();
    expect(spawnCalls).toHaveLength(0);
  });

  it("reports a failed worktree creation and spawns nothing", async () => {
    setup({ gitRepo: true });
    allocateMock.mockRejectedValue(new Error("branch exists"));
    const session = openWizard();
    await toSpawnOptions(session);

    await spawnWith(session, { name: "cow-my-thing", prompt: "Do the thing" });
    await session.settle();

    expect(session.notifications.map((n) => n.message)).toContain(
      "Worktree creation failed: branch exists",
    );
    expect(spawnCalls).toHaveLength(0);
  });

  it("tears the created worktree down when the spawn fails", async () => {
    setup({ gitRepo: true });
    setCoordinator({
      spawn: async () => {
        throw new Error("boom");
      },
    });
    const session = openWizard();
    await toSpawnOptions(session);

    await spawnWith(session, { name: "cow-my-thing", prompt: "Do the thing" });
    await session.settle();

    expect(teardownMock).toHaveBeenCalledTimes(1);
    expect(session.notifications.map((n) => n.message).join("\n")).toContain(
      "Spawn failed: boom",
    );
    expect(spawnCalls).toHaveLength(0);
  });
});
