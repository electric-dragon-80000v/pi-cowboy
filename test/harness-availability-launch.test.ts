/**
 * harness-availability-launch.test.ts — the launch probe: which harnesses this
 * machine can actually launch, recorded once for the settings row and every spawn
 * to read. PATH is the only input, and it is replaced wholesale per case so the
 * answer never depends on the machine running the suite.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  probeHarnessAvailability,
  startHarnessAvailabilityProbe,
} from "../src/harness-availability-launch.js";
import type { PluginHarness } from "../src/agents/harness.js";
import { createHarnessModelCatalog } from "../src/agents/harness/model-list-catalog.js";
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
      steer: async () => ({ kind: "submitted" }),
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

  it("answers a throwing list reader as that harness's own unavailable list", async () => {
    freshPath();
    getHarnessRegistry().register({
      ...boomHarness("boom-list"),
      listModels: async () => {
        throw new Error("boom-list exploded");
      },
    });
    setHarnessAvailability(probed(["pi", "boom-list"]));

    const catalog = createHarnessModelCatalog({
      registry: getHarnessRegistry(),
      availability: getHarnessAvailability(),
      request: {
        pi: { exec: async () => ({}) } as unknown as ExtensionAPI,
        modelCatalog: { getAvailable: () => [] },
      },
    });
    await expect(catalog.list("boom-list")).resolves.toEqual({
      kind: "unavailable",
      notice: "Could not list the boom-list models (boom-list exploded).",
    });
  });
});
