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
import type { ModelList, PluginHarness } from "../src/agents/harness.js";
import {
  getHarnessAvailability,
  getHarnessRegistry,
  installSessionRegistries,
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

describe("startHarnessAvailabilityProbe", () => {
  it("records its answer for every later reader", () => {
    expect(getHarnessAvailability()).toEqual(unprobed());

    freshPath();
    startHarnessAvailabilityProbe();

    expect(getHarnessAvailability()).toEqual(probed(["pi"]));
  });

  it("keeps an installed opencode it cannot launch off the offer, and says which one it found", () => {
    const dir = freshPath();
    executable(dir, "opencode", "opencode v1.19.0");

    const probe = startHarnessAvailabilityProbe();

    expect(getHarnessAvailability()).toEqual(probed(["pi"]));
    expect(probe.notices).toEqual([
      "You seem to have opencode version 1.19.0 installed, pi-cowboy only supports v2.x.x.",
    ]);
  });

  it("has nothing to say when every harness it found is launchable", () => {
    const dir = freshPath();
    executable(dir, "opencode", "opencode v2.0.28");

    const probe = startHarnessAvailabilityProbe();

    expect(getHarnessAvailability()).toEqual(probed(["pi", "opencode"]));
    expect(probe.notices).toEqual([]);
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

  /** One `opencode api GET /api/model` answer holding one model. */
  function opencodeModelApi(): string {
    return JSON.stringify({
      data: [{ providerID: "anthropic", id: "claude-opus-4" }],
    });
  }

  /** `listModels` the way registration calls it: pi and a catalog. */
  function listOpencode(pi: ExtensionAPI): Promise<ModelList> {
    return getHarnessRegistry()
      .require("opencode")
      .listModels({
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
    executable(dir, "opencode", "opencode v2.0.28");
    setHarnessAvailability(unprobed());
    const { pi, exec } = answeringPi("");

    prefetchHarnessModels(pi);

    expect(exec).not.toHaveBeenCalled();
  });

  it("warms once at boot and later reads join the one run", async () => {
    const dir = freshPath();
    executable(dir, "opencode", "opencode v2.0.28");
    startHarnessAvailabilityProbe();
    const { pi, exec } = answeringPi(opencodeModelApi());

    // Boot warms without awaiting, exactly like the probes.
    prefetchHarnessModels(pi);
    prefetchHarnessModels(pi);
    expect(exec).toHaveBeenCalledTimes(1);

    // Registration's read path joins the warm instead of shelling out again.
    await expect(listOpencode(pi)).resolves.toEqual({
      kind: "listed",
      entries: [
        {
          key: "anthropic/claude-opus-4",
          label: "claude-opus-4",
          thinkingLevels: { kind: "advisory", levels: [] },
        },
      ],
    });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("forgets a failed answer so the next read retries, with its reason each run", async () => {
    const dir = freshPath();
    executable(dir, "opencode", "opencode v2.0.28");
    startHarnessAvailabilityProbe();
    const { pi, exec } = answeringPi("", 1);

    const first = await listOpencode(pi);
    await Promise.resolve();

    // The next read starts a fresh run instead of pinning the empty row, and
    // every failed run answers with the reason rather than once per session.
    const second = await listOpencode(pi);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(first.kind).toBe("unavailable");
    expect(second).toEqual(first);
  });
});

describe("prefetchHarnessModels", () => {
  it("warms every runnable harness without naming any, exactly once", () => {
    const dir = freshPath();
    executable(dir, "opencode", "opencode v2.0.28");
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

/**
 * A plugin's hooks are called on the session's path, so one that throws must
 * cost its own harness and nothing else — never the session.
 */
describe("a harness whose hooks throw", () => {
  /** A plugin harness whose two session hooks are the ones under test. */
  function boomHarness(id: string): PluginHarness {
    return {
      id,
      displayName: id,
      agentMultiplexerKind: id,
      availability: () => {
        throw new Error(`${id} exploded`);
      },
      prepare: async () => {},
      buildArgs: () => [],
      teardown: async () => {},
      listModels: async () => ({ kind: "listed", entries: [] }),
      stop: async () => {},
      prefetchModels: () => {
        throw new Error(`${id} exploded`);
      },
    };
  }

  afterEach(() => {
    // A harness registered here belongs to this case's session only.
    installSessionRegistries();
  });

  it("answers a throwing availability hook as unavailable, naming the harness", () => {
    freshPath();
    getHarnessRegistry().register(boomHarness("boom-availability"));

    const probe = probeHarnessAvailability();

    expect(probe.availability).toEqual(probed(["pi"]));
    expect(probe.notices).toHaveLength(1);
    expect(probe.notices[0]).toContain('"boom-availability"');
    expect(probe.notices[0]).toContain("boom-availability exploded");
  });

  it("survives a throwing prefetch hook, leaving the session to start", () => {
    freshPath();
    getHarnessRegistry().register(boomHarness("boom-prefetch"));
    setHarnessAvailability(probed(["pi", "boom-prefetch"]));

    // Warming is an optimization: a cold list, not a failed session.
    expect(() =>
      prefetchHarnessModels({
        exec: async () => ({}),
      } as unknown as ExtensionAPI),
    ).not.toThrow();
  });
});
