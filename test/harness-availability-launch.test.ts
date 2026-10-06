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
import {
  detectHarnessAvailability,
  startHarnessAvailabilityProbe,
} from "../src/harness-availability-launch.js";
import { getHarnessAvailability } from "../src/shell.js";
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

    expect(detectHarnessAvailability()).toEqual(
      probed(["pi", "pig", "pi-bolt"]),
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
