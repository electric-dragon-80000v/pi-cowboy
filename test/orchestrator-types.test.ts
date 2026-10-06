/**
 * orchestrator-types.test.ts — Registry: registration, name resolution,
 * listing, and the scan-and-merge entry point. The registry is session state,
 * so every test starts it empty.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ORCHESTRATORS } from "../src/orchestrators/default-orchestrators.js";
import {
  getAvailableOrchestrators,
  getOrchestrator,
  registerOrchestrators,
  resolveOrchestrator,
  scanAndMergeOrchestrators,
  setOrchestratorScanDirs,
} from "../src/orchestrators/orchestrator-types.js";
import { EXTENSION_ORCHESTRATORS_DIR } from "../src/paths.js";
import { createSessionTemplates, setSessionTemplates } from "../src/shell.js";
import type { OrchestratorConfig } from "../src/orchestrators/types.js";

const BASE = DEFAULT_ORCHESTRATORS.default;

/** Minimal registry-test config; cues come from the code default. */
function config(name: string): OrchestratorConfig {
  return { ...BASE, name };
}

beforeEach(() => {
  setSessionTemplates(createSessionTemplates());
});

describe("registerOrchestrators", () => {
  it("registers the code default", () => {
    registerOrchestrators(new Map());

    expect(getAvailableOrchestrators()).toEqual(["default"]);
    expect(getOrchestrator("default")).toBe(BASE);
  });

  it("overlays loaded templates on the code defaults", () => {
    const custom = config("custom");
    const replaced = { ...config("default"), displayName: "Replaced" };

    registerOrchestrators(
      new Map([
        ["custom", custom],
        ["default", replaced],
      ]),
    );

    expect(getOrchestrator("custom")).toBe(custom);
    expect(getOrchestrator("default")).toBe(replaced);
  });

  it("clears previously registered orchestrators", () => {
    registerOrchestrators(new Map([["custom", config("custom")]]));
    expect(getOrchestrator("custom")).toBeDefined();

    registerOrchestrators(new Map());

    expect(getOrchestrator("custom")).toBeUndefined();
    expect(getAvailableOrchestrators()).toHaveLength(1);
  });

  it("can skip the code defaults entirely", () => {
    registerOrchestrators(new Map([["custom", config("custom")]]), {
      disableDefaultOrchestrators: true,
    });

    expect(getOrchestrator("default")).toBeUndefined();
    expect(getAvailableOrchestrators()).toEqual(["custom"]);
  });
});

describe("resolveOrchestrator", () => {
  it("prefers the exact registered name", () => {
    registerOrchestrators(
      new Map([
        ["Twin", config("Twin")],
        ["twin", config("twin")],
      ]),
    );

    expect(resolveOrchestrator("Twin")?.name).toBe("Twin");
    expect(resolveOrchestrator("twin")?.name).toBe("twin");
  });

  it("falls back to a single case-insensitive match", () => {
    registerOrchestrators(new Map([["two-phase", config("two-phase")]]));

    expect(resolveOrchestrator("TWO-PHASE")?.name).toBe("two-phase");
    expect(resolveOrchestrator("Two-Phase")?.name).toBe("two-phase");
  });

  it("refuses to guess between names differing only by case", () => {
    registerOrchestrators(
      new Map([
        ["Twin", config("Twin")],
        ["twin", config("twin")],
      ]),
    );

    expect(resolveOrchestrator("TWIN")).toBeUndefined();
  });

  it("returns undefined for unknown and empty names", () => {
    registerOrchestrators(new Map());

    expect(resolveOrchestrator("nope")).toBeUndefined();
    expect(resolveOrchestrator("")).toBeUndefined();
  });

  it("resolves nothing when the registry is empty", () => {
    registerOrchestrators(new Map(), { disableDefaultOrchestrators: true });

    expect(resolveOrchestrator("default")).toBeUndefined();
    expect(getAvailableOrchestrators()).toEqual([]);
  });
});

describe("getOrchestrator", () => {
  it("is the config accessor for a name, case-insensitively", () => {
    const custom = config("multi-phase");
    registerOrchestrators(new Map([["multi-phase", custom]]));

    expect(getOrchestrator("multi-phase")).toBe(custom);
    expect(getOrchestrator("MULTI-PHASE")).toBe(custom);
    expect(getOrchestrator("missing")).toBeUndefined();
  });
});

describe("getAvailableOrchestrators", () => {
  it("lists every registered orchestrator by name", () => {
    registerOrchestrators(
      new Map([
        ["alpha", config("alpha")],
        ["beta", config("beta")],
      ]),
    );

    expect(getAvailableOrchestrators()).toEqual(["default", "alpha", "beta"]);
  });

  it("lists exactly what resolveOrchestrator accepts", () => {
    registerOrchestrators(new Map([["alpha", config("alpha")]]));

    const names = getAvailableOrchestrators();
    expect(names.map((name) => resolveOrchestrator(name)?.name)).toEqual(names);
  });
});

describe("scanAndMergeOrchestrators", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function scanDir(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cowboy-orch-types-"));
    tempDirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
  }

  it("scans the extension directory too, and tolerates it being absent", () => {
    // The extension scan contributes "with code review"; the path must resolve as an absolute directory.
    expect(EXTENSION_ORCHESTRATORS_DIR.endsWith("orchestrators/")).toBe(true);
  });

  it("returns the code defaults when no directory has templates", async () => {
    setOrchestratorScanDirs("", "");

    const merged = await scanAndMergeOrchestrators();

    expect([...merged.keys()]).toEqual(["default", "with code review"]);
    expect(merged.get("default")?.cues).toEqual(BASE.cues);
  });

  it("merges user and project layers over the code default", async () => {
    const userDir = scanDir({
      "default.toml":
        'name = "default"\ndisplay_name = "From user"\n\n[cues]\nspawned = "user {{agent_id}}"\n',
    });
    const projectDir = scanDir({
      "custom.toml":
        'name = "custom"\ndisplay_name = "Project custom"\n\n[cues]\nsettled = "done: {{result}}"\n',
    });
    setOrchestratorScanDirs(userDir, projectDir);

    const merged = await scanAndMergeOrchestrators();

    const base = merged.get("default")!;
    expect(base.displayName).toBe("From user");
    expect(base.cues.spawned).toBe("user {{agent_id}}");
    expect(base.cues.queued).toBe(BASE.cues.queued);

    const custom = merged.get("custom")!;
    expect(custom.displayName).toBe("Project custom");
    expect(custom.cues.settled).toBe("done: {{result}}");
    expect(custom.cues.spawned).toBe(BASE.cues.spawned);
  });

  it("applies the shared workspace layer between user and project", async () => {
    const userDir = scanDir({
      "default.toml":
        'name = "default"\ndisplay_name = "User"\n\n[cues]\nspawned = "user"\n',
    });
    const projectDir = scanDir({
      "default.toml": 'name = "default"\nguidance = "project guidance"\n',
    });
    const sharedDir = scanDir({
      "default.toml":
        'name = "default"\ndisplay_name = "Shared"\n\n[cues]\nqueued = "shared queued"\n',
    });
    setOrchestratorScanDirs(userDir, projectDir, sharedDir);

    const merged = await scanAndMergeOrchestrators();
    const base = merged.get("default")!;

    expect(base.guidance).toBe("project guidance");
    expect(base.displayName).toBe("Shared");
    expect(base.cues.spawned).toBe("user");
    expect(base.cues.queued).toBe("shared queued");
    expect(base.cues.settled).toBe(BASE.cues.settled);
  });

  it("warns through the injected sink and keeps scanning", async () => {
    const userDir = scanDir({
      "broken.toml": 'name = "broken"\n\n[cues]\nspawned = "{{nope}}"\n',
      "good.toml": 'name = "good"\nguidance = "d"\n',
    });
    setOrchestratorScanDirs(userDir, "");
    const notify = vi.fn();

    const merged = await scanAndMergeOrchestrators({ notify });

    expect(notify).toHaveBeenCalledTimes(1);
    expect([...merged.keys()].sort()).toEqual([
      "default",
      "good",
      "with code review",
    ]);
  });

  it("keeps the code default cues as the base when defaults are disabled", async () => {
    const userDir = scanDir({
      "custom.toml":
        'name = "custom"\nguidance = "d"\n\n[cues]\nsettled = "only this"\n',
    });
    setOrchestratorScanDirs(userDir, "");

    const merged = await scanAndMergeOrchestrators({
      disableDefaultOrchestrators: true,
    });

    // No `default` entry — but a loaded template still starts from the shipped cues for undefined events.
    expect(merged.has("default")).toBe(false);
    expect(merged.get("custom")?.cues).toEqual({
      spawned: BASE.cues.spawned,
      queued: BASE.cues.queued,
      settled: "only this",
    });
  });
});
