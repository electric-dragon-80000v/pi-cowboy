/**
 * harness-availability-launch.test.ts — the launch probe: which harnesses this
 * machine can actually launch, recorded once for the settings row and every spawn
 * to read. PATH is the only input, and it is replaced wholesale per case so the
 * answer never depends on the machine running the suite.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  detectHarnessAvailability,
  prefetchHarnessModels,
  startHarnessAvailabilityProbe,
} from "../src/harness-availability-launch.js";
import { harnessFor } from "../src/agents/harness/registry.js";
import {
  getHarnessAvailability,
  setHarnessAvailability,
} from "../src/shell.js";
import { probed, unprobed } from "../src/availability.js";

const realPath = process.env.PATH;
const tmpDirs: string[] = [];

/** A directory that becomes the whole PATH, so only what it holds is found. */
function freshPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-probe-"));
  tmpDirs.push(dir);
  process.env.PATH = dir;
  return dir;
}

function executable(dir: string, name: string): void {
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(file, 0o755);
}

afterEach(() => {
  process.env.PATH = realPath;
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  // No fetch reset: the harness memo is keyed by pi instance, and every
  // case below news up its own — no case can read another's answer.
});

describe("detectHarnessAvailability", () => {
  it("keeps pi and drops every pi-compatible binary the machine does not have", () => {
    freshPath();

    expect(detectHarnessAvailability()).toEqual(probed(["pi"]));
  });

  it("adds each binary it finds, in the vocabulary's order", () => {
    const dir = freshPath();
    executable(dir, "pi-bolt");
    executable(dir, "pig");
    executable(dir, "opencode");

    expect(detectHarnessAvailability()).toEqual(
      probed(["pi", "pig", "pi-bolt", "opencode"]),
    );
  });
});

describe("startHarnessAvailabilityProbe", () => {
  it("records its answer for every later reader", () => {
    expect(getHarnessAvailability()).toEqual(unprobed());

    freshPath();
    startHarnessAvailabilityProbe();

    expect(getHarnessAvailability()).toEqual(probed(["pi"]));
  });
});

describe("prefetchHarnessModels", () => {
  /** `pi.exec` answering one model, counted per case. */
  function answeringPi(
    stdout: string,
    code = 0,
  ): { pi: ExtensionAPI; exec: ReturnType<typeof vi.fn> } {
    const exec = vi.fn(async () => ({ code, stdout, stderr: "" }));
    return { pi: { exec } as unknown as ExtensionAPI, exec };
  }

  /** `listModels` the way registration calls it: pi plus a catalog. */
  function listOpencode(pi: ExtensionAPI): Promise<unknown> {
    return harnessFor("opencode").listModels({
      pi,
      modelCatalog: { getAvailable: () => [] },
    });
  }

  it("starts no fetch where no runnable harness warms one", () => {
    freshPath();
    startHarnessAvailabilityProbe();
    const { pi, exec } = answeringPi("");

    prefetchHarnessModels(pi);

    // pi reads its catalog on demand and warms nothing.
    expect(exec).not.toHaveBeenCalled();
  });

  it("starts no fetch while the probe has not proven opencode", () => {
    // opencode is on PATH, but the shell answers unprobed — and an unproven
    // harness warms nothing. This stays red if the gate is ever dropped.
    const dir = freshPath();
    executable(dir, "opencode");
    setHarnessAvailability(unprobed());
    const { pi, exec } = answeringPi("");

    prefetchHarnessModels(pi);

    expect(exec).not.toHaveBeenCalled();
  });

  it("warms once at boot and later reads join the one run", async () => {
    const dir = freshPath();
    executable(dir, "opencode");
    startHarnessAvailabilityProbe();
    const { pi, exec } = answeringPi("anthropic/claude-opus-4\n");

    // Boot warms without awaiting, exactly like the probes.
    prefetchHarnessModels(pi);
    prefetchHarnessModels(pi);
    expect(exec).toHaveBeenCalledTimes(1);

    // Registration's read path joins the warm instead of shelling out again.
    await expect(listOpencode(pi)).resolves.toEqual([
      { key: "anthropic/claude-opus-4", label: "claude-opus-4" },
    ]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("forgets an empty answer so the next read retries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dir = freshPath();
      executable(dir, "opencode");
      startHarnessAvailabilityProbe();
      const { pi, exec } = answeringPi("", 1);

      await expect(listOpencode(pi)).resolves.toEqual([]);
      await Promise.resolve();

      // The next read starts a fresh run instead of pinning the empty row.
      await expect(listOpencode(pi)).resolves.toEqual([]);
      expect(exec).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("prefetchHarnessModels", () => {
  it("warms every runnable harness without naming any, exactly once", () => {
    const dir = freshPath();
    executable(dir, "opencode");
    startHarnessAvailabilityProbe();
    const exec = vi.fn(() => new Promise(() => {}));
    const pi = { exec } as unknown as ExtensionAPI;

    prefetchHarnessModels(pi);
    prefetchHarnessModels(pi);

    // opencode's hook started its memoized fetch; the pi family no-op'd.
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("starts nothing where the probe proved nothing slow", () => {
    freshPath();
    startHarnessAvailabilityProbe();
    const exec = vi.fn(() => new Promise(() => {}));

    prefetchHarnessModels({ exec } as unknown as ExtensionAPI);

    expect(exec).not.toHaveBeenCalled();
  });
});
