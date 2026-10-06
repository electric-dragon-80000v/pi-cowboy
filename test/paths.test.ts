/**
 * paths.test.ts — unit tests for the lazily-resolved directory getters.
 * Pins pi's precedence (env override with tilde expansion, else `~/.pi/agent`)
 * and per-call resolution (no module-scope snapshot, which would freeze the
 * wrong directory for a subagent whose env differs).
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentDir,
  canonicalPath,
  defaultExtensionDir,
  defaultWorktreeRoot,
  EXTENSION_NAME,
} from "../src/paths.js";
import { customPromptPath } from "../src/config/config-io.js";

const ENV_VAR = "PI_CODING_AGENT_DIR";
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_VAR];
  delete process.env[ENV_VAR];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = savedEnv;
});

describe("agentDir", () => {
  it("defaults to pi's agent dir (~/.pi/agent) with no override", () => {
    expect(agentDir()).toBe(join(homedir(), ".pi", "agent"));
  });

  it("honors the PI_CODING_AGENT_DIR override", () => {
    process.env[ENV_VAR] = "/custom/agent";
    expect(agentDir()).toBe("/custom/agent");
  });

  it("expands a bare ~ to the home directory", () => {
    process.env[ENV_VAR] = "~";
    expect(agentDir()).toBe(homedir());
  });

  it("expands a leading ~/ to the home directory", () => {
    process.env[ENV_VAR] = "~/my-agents";
    expect(agentDir()).toBe(join(homedir(), "my-agents"));
  });

  it("treats an empty override as unset (pi's truthiness check)", () => {
    process.env[ENV_VAR] = "";
    expect(agentDir()).toBe(join(homedir(), ".pi", "agent"));
  });

  it("re-reads the environment on every call (no module-scope snapshot)", () => {
    expect(agentDir()).toBe(join(homedir(), ".pi", "agent"));
    process.env[ENV_VAR] = "/later/agent";
    expect(agentDir()).toBe("/later/agent");
  });
});

describe("derived paths", () => {
  it("defaultExtensionDir joins the agent dir and the extension name", () => {
    expect(defaultExtensionDir()).toBe(
      join(homedir(), ".pi", "agent", EXTENSION_NAME),
    );
  });

  it("defaultWorktreeRoot is <extension dir>/worktrees", () => {
    expect(defaultWorktreeRoot()).toBe(
      join(homedir(), ".pi", "agent", EXTENSION_NAME, "worktrees"),
    );
  });

  it("derived paths follow the env override at call time", () => {
    process.env[ENV_VAR] = "~/agents";
    expect(defaultExtensionDir()).toBe(
      join(homedir(), "agents", EXTENSION_NAME),
    );
    expect(defaultWorktreeRoot()).toBe(
      join(homedir(), "agents", EXTENSION_NAME, "worktrees"),
    );
    expect(customPromptPath()).toBe(
      join(homedir(), "agents", EXTENSION_NAME, "prompt.md"),
    );
  });
});

describe("canonicalPath", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "canonical-path-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves a symlinked spelling to the directory it names", () => {
    fs.mkdirSync(join(root, "real"));
    fs.symlinkSync(join(root, "real"), join(root, "link"));
    expect(canonicalPath(join(root, "link"))).toBe(
      canonicalPath(join(root, "real")),
    );
  });

  it("collapses a dot-dot spelling to the same directory", () => {
    fs.mkdirSync(join(root, "dir"), { recursive: true });
    expect(canonicalPath(join(root, "dir", "..", "dir"))).toBe(
      canonicalPath(join(root, "dir")),
    );
  });

  it("has no spelling for a path that does not exist", () => {
    expect(canonicalPath(join(root, "absent"))).toBeUndefined();
  });
});
