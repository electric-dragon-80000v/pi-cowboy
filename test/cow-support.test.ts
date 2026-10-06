/**
 * cow-support.test.ts — what the volume's answer does to the materialization a
 * spawn uses and to the values the setting may hold.
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeTargetFor } from "../src/spawn/cow-support.js";
import {
  probed,
  selectable,
  unprobed,
  type Availability,
} from "../src/availability.js";
import {
  resolveWorktreeMaterialization,
  VALID_WORKTREE_MATERIALIZATIONS,
  type WorktreeMaterialization,
} from "../src/spawn/worktree-policy.js";

type Materializations = Availability<WorktreeMaterialization>;

const both: Materializations = probed(["copy-on-write", "checkout"]);
const checkoutOnly: Materializations = probed(["checkout"]);
const awaiting: Materializations = unprobed();

const tmpDirs: string[] = [];

function freshTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "cow-support-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveWorktreeMaterialization", () => {
  const cases: readonly {
    name: string;
    availability: Materializations;
    configured: "copy-on-write" | "checkout" | undefined;
    want: "copy-on-write" | "checkout";
  }[] = [
    {
      name: "clones",
      availability: both,
      configured: "copy-on-write",
      want: "copy-on-write",
    },
    {
      name: "clones",
      availability: both,
      configured: "checkout",
      want: "checkout",
    },
    {
      name: "clones",
      availability: both,
      configured: undefined,
      want: "copy-on-write",
    },
    {
      name: "awaits the probe",
      availability: awaiting,
      configured: "copy-on-write",
      want: "copy-on-write",
    },
    {
      name: "awaits the probe",
      availability: awaiting,
      configured: undefined,
      want: "copy-on-write",
    },
    // A volume that cannot clone falls back however the setting reads.
    {
      name: "cannot clone",
      availability: checkoutOnly,
      configured: "copy-on-write",
      want: "checkout",
    },
    {
      name: "cannot clone",
      availability: checkoutOnly,
      configured: "checkout",
      want: "checkout",
    },
    {
      name: "cannot clone",
      availability: checkoutOnly,
      configured: undefined,
      want: "checkout",
    },
  ];

  it.each(cases)(
    "$name + $configured -> $want",
    ({ availability, configured, want }) => {
      expect(resolveWorktreeMaterialization(configured, availability)).toBe(
        want,
      );
    },
  );

  const offered: readonly {
    availability: Materializations;
    value: "copy-on-write" | "checkout";
  }[] = [
    { availability: both, value: "copy-on-write" },
    { availability: both, value: "checkout" },
    { availability: awaiting, value: "copy-on-write" },
    { availability: awaiting, value: "checkout" },
    { availability: checkoutOnly, value: "checkout" },
  ];

  it.each(offered)(
    "a selectable $value is what the resolver keeps",
    ({ availability, value }) => {
      expect(
        selectable(VALID_WORKTREE_MATERIALIZATIONS, availability),
      ).toContain(value);
      expect(resolveWorktreeMaterialization(value, availability)).toBe(value);
    },
  );
});

describe("probeTargetFor", () => {
  it("climbs to the nearest directory that exists", () => {
    const t = freshTmp();
    const missing = join(t, "not", "created", "yet");
    expect(probeTargetFor(missing)).toBe(t);
  });

  it("uses the root itself when it exists", () => {
    const t = freshTmp();
    mkdirSync(join(t, "worktrees"), { recursive: true });
    expect(probeTargetFor(join(t, "worktrees"))).toBe(join(t, "worktrees"));
  });

  it("stops at the symlinked root rather than climbing past it", () => {
    const t = freshTmp();
    const real = join(t, "real");
    const link = join(t, "link");
    mkdirSync(real, { recursive: true });
    symlinkSync(link, join(real, "inner"));
    symlinkSync(real, link);

    const target = probeTargetFor(join(link, "worktrees"));

    expect(target).toBe(link);
    expect(statSync(target).isDirectory()).toBe(true);
  });
});
