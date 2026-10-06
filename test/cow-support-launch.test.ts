/**
 * cow-support-launch.test.ts — probe ordering. Probes are fire-and-forget, so
 * a slow one can answer after a newer one; the shell's claim is what keeps the
 * older verdict off the current answer.
 *
 * The probe itself is stubbed, so each case controls exactly when each probe
 * finishes instead of racing a real clone on the volume.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { probed, unprobed, type Availability } from "../src/availability.js";
import type { WorktreeMaterialization } from "../src/spawn/worktree-policy.js";

type Materializations = Availability<WorktreeMaterialization>;

const both = probed<WorktreeMaterialization>(["copy-on-write", "checkout"]);
const checkoutOnly = probed<WorktreeMaterialization>(["checkout"]);

/** One probe's verdict, resolved by the case that owns it. */
interface PendingProbe {
  dir: string;
  resolve: (availability: Materializations) => void;
  reject: (reason: unknown) => void;
}

const { pending } = vi.hoisted(() => ({ pending: [] as PendingProbe[] }));

vi.mock("../src/spawn/cow-support.js", () => ({
  probeTargetFor: (worktreeRoot: string | undefined) =>
    worktreeRoot ?? "/default-root",
  detectCowAvailability: (_exec: unknown, dir: string) =>
    new Promise<Materializations>((resolve, reject) => {
      pending.push({ dir, resolve, reject });
    }),
}));

const { refreshCowSupportProbe, startCowSupportProbe } =
  await import("../src/cow-support-launch.js");
const { beginCowAvailabilityProbe, getCowAvailability, setCowAvailability } =
  await import("../src/shell.js");

/** The probe that has been started and not yet finished, oldest first. */
function inFlight(index: number): PendingProbe {
  const probe = pending.at(index);
  if (probe === undefined) {
    throw new Error(`no probe was started at index ${index}`);
  }
  return probe;
}

/** The probe that owns the current answer. */
function current(): PendingProbe {
  return pending[pending.length - 1]!;
}

/** Lets the probe's `.then` handler run after a verdict was handed to it. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const pi = {} as ExtensionAPI;

describe("cow support probes", () => {
  beforeEach(() => {
    pending.length = 0;
    // Start every case from a fresh session's answer.
    setCowAvailability(beginCowAvailabilityProbe(), unprobed());
  });

  it("measures the volume the worktree root names", () => {
    startCowSupportProbe(pi);
    expect(inFlight(0).dir).toBe("/default-root");
  });

  it("keeps the newest probe's verdict when an older one answers later", async () => {
    startCowSupportProbe(pi);
    const older = inFlight(0);

    // The worktree root moves to another volume, which is probed again.
    refreshCowSupportProbe(pi);
    const newer = current();
    expect(newer.dir).toBe("/default-root");

    // The first probe finishes last, describing a volume nobody uses now.
    older.resolve(both);
    await settle();
    expect(getCowAvailability()).toEqual(unprobed());

    newer.resolve(both);
    await settle();
    expect(getCowAvailability()).toEqual(both);
  });

  it("does not let an older probe's failure overwrite the current answer", async () => {
    startCowSupportProbe(pi);
    const older = inFlight(0);

    refreshCowSupportProbe(pi);
    const newer = current();
    newer.resolve(both);
    await settle();
    expect(getCowAvailability()).toEqual(both);

    // The stale probe fails late: it must not report the new volume as unable to
    // clone.
    older.reject(new Error("clone failed"));
    await settle();
    expect(getCowAvailability()).toEqual(both);
  });

  it("answers a refresh with its own probe, and leaves nothing known until it lands", async () => {
    refreshCowSupportProbe(pi);
    expect(getCowAvailability()).toEqual(unprobed());
    expect(pending).toHaveLength(1);

    current().resolve(checkoutOnly);
    await settle();
    expect(getCowAvailability()).toEqual(checkoutOnly);
  });
});
