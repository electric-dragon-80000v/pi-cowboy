/**
 * config-store-two-slices.test.ts — the shapes the two slices share a file in.
 * The agent and concurrency slices write through the same global and project
 * files, so a write to one must carry the other's section along, and a project
 * file must only come into being through a write.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config/config-store.js";
import { createConfigIO } from "../src/config/config-io.js";

/** A project dir with an agent dir beside it: the two files a store writes. */
interface Files {
  projectDir: string;
  globalPath: string;
  projectPath: string;
}

let root: string;

function createFiles(): Files {
  root = mkdtempSync(join(tmpdir(), "pi-cowboy-two-slices-"));
  const projectDir = join(root, ".pi");
  // The global file resolves at call time; keep the read off the developer's agent dir.
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  return {
    projectDir,
    globalPath: join(root, "agent", "pi-cowboy", "config.json"),
    projectPath: join(projectDir, "pi-cowboy", "config.json"),
  };
}

function storeOver(files: Files): ConfigStore {
  return new ConfigStore(createConfigIO(files.projectDir));
}

function read(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("one file, two slices", () => {
  it("keeps the sibling section when a slice writes the global layer", () => {
    const files = createFiles();
    const store = storeOver(files);

    store.mutate.concurrency.setProvider("anthropic", 3);
    store.mutate.agent.setExtensionEnabled(false);

    expect(read(files.globalPath)).toEqual({
      agent: { extensionEnabled: false },
      concurrency: { providers: { anthropic: 3 } },
    });
  });

  it("drops only its own section when a slice clears the whole layer", () => {
    const files = createFiles();
    const store = storeOver(files);
    store.mutate.concurrency.setProvider("anthropic", 3);
    store.mutate.agent.setExtensionEnabled(false);

    store.mutate.concurrency.clearAll();

    expect(read(files.globalPath)).toEqual({
      agent: { extensionEnabled: false },
    });
  });

  it("creates the project file on a write and never on a clear", () => {
    const files = createFiles();
    const store = storeOver(files);

    store.mutate.agent.clearAllModelOverrides("project");
    expect(() => readFileSync(files.projectPath, "utf-8")).toThrow();

    store.mutate.agent.setDefaultModel("openai/gpt-4o", "project");
    expect(read(files.projectPath)).toEqual({
      agent: { default: "openai/gpt-4o" },
    });
  });

  it("keeps the slice the project file does not carry absent", () => {
    const files = createFiles();
    mkdirSync(join(files.projectDir, "pi-cowboy"), { recursive: true });
    writeFileSync(
      files.projectPath,
      JSON.stringify({ concurrency: { default: 6 } }),
    );

    storeOver(files).mutate.concurrency.setProvider("openai", 2, "project");

    // The agent section stays absent: the concurrency write must not invent one.
    expect(read(files.projectPath)).toEqual({
      concurrency: { default: 6, providers: { openai: 2 } },
    });
  });
});
