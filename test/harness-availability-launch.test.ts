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
  probeHarnessAvailability,
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

function executable(dir: string, name: string, stdout = ""): void {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\n`, {
    mode: 0o755,
  });
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

describe("probeHarnessAvailability", () => {
  it("keeps pi and drops every pi-compatible binary the machine does not have", () => {
    freshPath();

    expect(probeHarnessAvailability().availability).toEqual(probed(["pi"]));
  });

  it("adds each binary it finds, in the vocabulary's order", () => {
    const dir = freshPath();
    executable(dir, "pi-bolt");
    executable(dir, "pig");
    executable(dir, "opencode", "opencode v2.0.28");
    executable(dir, "codex");

    expect(probeHarnessAvailability().availability).toEqual(
      probed(["pi", "pig", "pi-bolt", "opencode", "codex"]),
    );
  });
});

/** A `pi` that keeps the session_start handlers registered on it. */
function probePi(): {
  pi: ExtensionAPI;
  on: ReturnType<typeof vi.fn>;
  startSession: (ctx: unknown) => void;
} {
  let handler: ((event: unknown, ctx: unknown) => void) | undefined;
  const on = vi.fn((event: string, next: (e: unknown, c: unknown) => void) => {
    if (event === "session_start") handler = next;
  });
  return {
    pi: { on } as unknown as ExtensionAPI,
    on,
    startSession: (ctx) => handler?.(undefined, ctx),
  };
}

describe("startHarnessAvailabilityProbe", () => {
  it("records its answer for every later reader", () => {
    expect(getHarnessAvailability()).toEqual(unprobed());

    freshPath();
    startHarnessAvailabilityProbe(probePi().pi);

    expect(getHarnessAvailability()).toEqual(probed(["pi"]));
  });

  it("keeps an installed opencode it cannot launch off the offer, and says which one it found", () => {
    const dir = freshPath();
    executable(dir, "opencode", "opencode v1.19.0");
    const { pi, startSession } = probePi();
    const notify = vi.fn();

    startHarnessAvailabilityProbe(pi);

    expect(getHarnessAvailability()).toEqual(probed(["pi"]));
    startSession({ hasUI: true, ui: { notify } });
    expect(notify).toHaveBeenCalledWith(
      "You seem to have opencode version 1.19.0 installed, pi-cowboy only supports v2.x.x.",
      "warning",
    );
  });

  it("has nothing to say when every harness it found is launchable", () => {
    const dir = freshPath();
    executable(dir, "opencode", "opencode v2.0.28");
    const { pi, on, startSession } = probePi();

    startHarnessAvailabilityProbe(pi);

    expect(getHarnessAvailability()).toEqual(probed(["pi", "opencode"]));
    expect(startSession).toBeTypeOf("function");
    expect(on).not.toHaveBeenCalled();
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
    startHarnessAvailabilityProbe(probePi().pi);
    const { pi, exec } = answeringPi("");

    prefetchHarnessModels(pi);

    // pi reads its catalog on demand and warms nothing.
    expect(exec).not.toHaveBeenCalled();
  });

  it("starts no fetch while the probe has not proven opencode", () => {
    // opencode is on PATH, but the shell answers unprobed — and an unproven
    // harness warms nothing. This stays red if the gate is ever dropped.
    const dir = freshPath();
    executable(dir, "opencode", "opencode v2.0.28");
    setHarnessAvailability(unprobed());
    const { pi, exec } = answeringPi("");

    prefetchHarnessModels(pi);

    expect(exec).not.toHaveBeenCalled();
  });

  it("warms once at boot and later reads join the one run", async () => {
    const dir = freshPath();
    executable(dir, "opencode", "opencode v2.0.28");
    startHarnessAvailabilityProbe(probePi().pi);
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
      executable(dir, "opencode", "opencode v2.0.28");
      startHarnessAvailabilityProbe(probePi().pi);
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
    executable(dir, "opencode", "opencode v2.0.28");
    startHarnessAvailabilityProbe(probePi().pi);
    const exec = vi.fn(() => new Promise(() => {}));
    const pi = { exec } as unknown as ExtensionAPI;

    prefetchHarnessModels(pi);
    prefetchHarnessModels(pi);

    // opencode's hook started its memoized fetch; the pi family no-op'd.
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("starts nothing where the probe proved nothing slow", () => {
    freshPath();
    startHarnessAvailabilityProbe(probePi().pi);
    const exec = vi.fn(() => new Promise(() => {}));

    prefetchHarnessModels({ exec } as unknown as ExtensionAPI);

    expect(exec).not.toHaveBeenCalled();
  });
});
