/**
 * index.test.ts — what the entry point registers, independent of the multiplexer
 * hosting the process. A plugin multiplexer can host a session the built-in
 * cannot, and plugins load per session, so a host gate here would keep the only
 * thing that could answer the host question from ever loading. The decision
 * belongs to session-runtime.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const deps = vi.hoisted(() => ({
  subagent: undefined as string | undefined,
  prereq: undefined as string | undefined,
  insideGitRepository: true,
  setPiInstance: vi.fn(),
  setupEventListeners: vi.fn(),
  registerTools: vi.fn(),
  registerCowboyCommand: vi.fn(),
  registerUnavailableCowboyCommand: vi.fn(),
}));

vi.mock("../src/shell.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/shell.js")>()),
  setPiInstance: deps.setPiInstance,
  detectSubagentSpawn: () => deps.subagent,
}));

vi.mock("../src/events.js", () => ({
  setupEventListeners: deps.setupEventListeners,
}));

vi.mock("../src/registration.js", () => ({
  registerTools: deps.registerTools,
  registerCowboyCommand: deps.registerCowboyCommand,
  registerUnavailableCowboyCommand: deps.registerUnavailableCowboyCommand,
}));

vi.mock("../src/infrastructure/git/cow-clone.js", () => ({
  missingCloneProgramReport: () => deps.prereq,
}));

vi.mock("../src/infrastructure/git-client.js", () => ({
  isInsideGitRepository: () => deps.insideGitRepository,
}));

const { default: entry } = await import("../src/index.js");

function fakePi(): ExtensionAPI {
  return { on: vi.fn() } as unknown as ExtensionAPI;
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.subagent = undefined;
  deps.prereq = undefined;
  deps.insideGitRepository = true;
  // No multiplexer hosts the process: activation must not depend on this.
  vi.stubEnv("HERDR_ENV", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the extension entry point", () => {
  it("registers the tools, the command and the listeners with nothing hosting the process", () => {
    const pi = fakePi();

    entry(pi);

    expect(deps.setPiInstance).toHaveBeenCalledWith(pi);
    expect(deps.registerTools).toHaveBeenCalledWith(pi);
    expect(deps.registerCowboyCommand).toHaveBeenCalledWith(pi);
    expect(deps.setupEventListeners).toHaveBeenCalledWith(pi);
  });

  it("stays inert inside a subagent", () => {
    deps.subagent = "agent1234";

    entry(fakePi());

    expect(deps.setPiInstance).not.toHaveBeenCalled();
    expect(deps.setupEventListeners).not.toHaveBeenCalled();
    expect(deps.registerTools).not.toHaveBeenCalled();
  });

  it("names a missing clone program instead of registering", () => {
    deps.prereq = "cp is missing";
    const on = vi.fn();
    const pi = { on } as unknown as ExtensionAPI;

    entry(pi);

    expect(deps.setupEventListeners).not.toHaveBeenCalled();
    expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
  });

  it("registers the unavailable command instead of the tools outside a git repository", () => {
    deps.insideGitRepository = false;

    entry(fakePi());

    expect(deps.registerUnavailableCowboyCommand).toHaveBeenCalled();
    expect(deps.registerTools).not.toHaveBeenCalled();
    expect(deps.setupEventListeners).not.toHaveBeenCalled();
  });
});
