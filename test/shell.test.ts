import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginCowAvailabilityProbe,
  createSessionTemplates,
  detectSubagentSpawn,
  getCowAvailability,
  getHarnessAvailability,
  setCowAvailability,
  setHarnessAvailability,
  setSessionTemplates,
} from "../src/shell.js";
import { probed, unprobed } from "../src/availability.js";
import type { WorktreeMaterialization } from "../src/spawn/worktree-policy.js";
import {
  getAllTypes,
  getAgentConfig,
  registerAgents,
} from "../src/agents/agent-types.js";
import type { AgentConfig } from "../src/agents/types.js";
import {
  getAvailableOrchestrators,
  getOrchestrator,
  registerOrchestrators,
} from "../src/orchestrators/orchestrator-types.js";
import type { OrchestratorConfig } from "../src/orchestrators/types.js";
import {
  subagentResultDir,
  subagentResultFileFor,
  subagentTokenFor,
} from "../src/paths.js";

const AGENT: AgentConfig = {
  name: "scoped",
  description: "scoped agent",
  systemPrompt: "",
};

const ORCHESTRATOR: OrchestratorConfig = {
  name: "scoped",
  guidance: "",
  cues: { spawned: "s", queued: "q", settled: "{{result}}" },
};

describe("session template registries", () => {
  afterEach(() => {
    setSessionTemplates(createSessionTemplates());
  });

  it("keeps each session's registrations out of every other session", () => {
    const first = createSessionTemplates();
    const second = createSessionTemplates();

    setSessionTemplates(first);
    registerAgents(new Map([[AGENT.name, AGENT]]), {
      disableDefaultAgents: true,
    });
    registerOrchestrators(new Map([[ORCHESTRATOR.name, ORCHESTRATOR]]), {
      disableDefaultOrchestrators: true,
    });

    setSessionTemplates(second);
    expect(getAgentConfig(AGENT.name)).toBeUndefined();
    expect(getOrchestrator(ORCHESTRATOR.name)).toBeUndefined();

    setSessionTemplates(first);
    expect(getAgentConfig(AGENT.name)).toBe(AGENT);
    expect(getOrchestrator(ORCHESTRATOR.name)).toBe(ORCHESTRATOR);
  });

  it("starts a created session with empty registries", () => {
    registerAgents(new Map([[AGENT.name, AGENT]]), {
      disableDefaultAgents: true,
    });
    registerOrchestrators(new Map([[ORCHESTRATOR.name, ORCHESTRATOR]]), {
      disableDefaultOrchestrators: true,
    });

    setSessionTemplates(createSessionTemplates());

    expect(getAllTypes()).toEqual([]);
    expect(getAvailableOrchestrators()).toEqual([]);
  });
});

describe("subagent argv gate", () => {
  it("builds a token carrying the agent id", () => {
    expect(subagentTokenFor("cow-fix-01234567")).toBe(
      "cowboy-subagent-cow-fix-01234567",
    );
  });

  it("detects the token in argv", () => {
    expect(
      detectSubagentSpawn([
        "pi",
        "--system-prompt",
        `You are a Pi. ${subagentTokenFor("cow-fix-01234567")}`,
        "--name",
        "cow-fix-01234567",
      ]),
    ).toBe("cow-fix-01234567");
  });

  it("returns undefined without the token", () => {
    expect(
      detectSubagentSpawn(["pi", "--model", "freebuff/deepseek-v4-flash"]),
    ).toBeUndefined();
    expect(detectSubagentSpawn([])).toBeUndefined();
  });
});

const both = probed<WorktreeMaterialization>(["copy-on-write", "checkout"]);
const checkoutOnly = probed<WorktreeMaterialization>(["checkout"]);

describe("cow support claims", () => {
  it("records the verdict of the current probe", () => {
    const claim = beginCowAvailabilityProbe();
    setCowAvailability(claim, unprobed());

    expect(setCowAvailability(claim, both)).toBe(true);
    expect(getCowAvailability()).toEqual(both);
  });

  it("discards a verdict from a probe that is no longer current", () => {
    const older = beginCowAvailabilityProbe();
    const newer = beginCowAvailabilityProbe();
    setCowAvailability(newer, checkoutOnly);

    // The older probe answers last, about a volume nobody asked about now.
    expect(setCowAvailability(older, both)).toBe(false);
    expect(getCowAvailability()).toEqual(checkoutOnly);
  });
});

describe("harness availability", () => {
  afterEach(() => {
    setHarnessAvailability(unprobed());
  });

  it("answers nothing is known until the launch probe lands", () => {
    expect(getHarnessAvailability()).toEqual(unprobed());
  });

  it("records what the probe found, and only that", () => {
    setHarnessAvailability(probed(["pi", "pig"]));

    expect(getHarnessAvailability()).toEqual(probed(["pi", "pig"]));
  });
});

describe("subagent staging root", () => {
  it("derives the result file from the agent id", () => {
    expect(subagentResultFileFor("cow-fix-01234567")).toBe(
      join(subagentResultDir(), "cow-fix-01234567", "result.md"),
    );
  });

  it.skipIf(process.platform === "win32")(
    "moves with a TMPDIR override",
    () => {
      const previous = process.env.TMPDIR;
      process.env.TMPDIR = "/tmp/cowboy-tmpdir-override";
      try {
        expect(subagentResultDir()).toBe(join(process.env.TMPDIR, "pi-cowboy"));
      } finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
      }
    },
  );
});
