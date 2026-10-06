/**
 * cow-support.ts — finding out whether the volume worktrees land on can clone,
 * and saying so as the materializations it can honor.
 *
 * The answer is a policy (`resolveWorktreeMaterialization` in
 * `worktree-policy.ts` and the generic `selectable` in `availability.ts`); this
 * module owns only how the answer is found.
 *
 * The session's result lives in the shell, so reading it never reaches for a
 * global, and the probe runs once at launch rather than per spawn.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  defaultCowCloneDeps,
  type ExecLike,
} from "../infrastructure/git/cow-clone.js";
import { defaultWorktreeRoot } from "../paths.js";
import { probed, type Availability } from "../availability.js";
import {
  VALID_WORKTREE_MATERIALIZATIONS,
  type WorktreeMaterialization,
} from "./worktree-policy.js";

/**
 * Probe the volume the worktrees will be created on. Any failure to clone — an
 * ext4 volume, a kernel without the ioctl, a `cp` without `--reflink` — is the
 * same answer: this volume cannot clone, so git's classic checkout is all that is
 * left to offer.
 */
export async function detectCowAvailability(
  exec: ExecLike,
  dir: string,
): Promise<Availability<WorktreeMaterialization>> {
  try {
    await defaultCowCloneDeps(exec).probe(dir);
    return probed(VALID_WORKTREE_MATERIALIZATIONS);
  } catch {
    return probed(["checkout"]);
  }
}

/**
 * The nearest existing directory at or above `target`. The worktree root may not
 * exist yet at launch, and only its filesystem matters to the probe.
 */
export function probeTargetFor(worktreeRoot: string | undefined): string {
  let dir = path.resolve(worktreeRoot ?? defaultWorktreeRoot());
  for (;;) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      // not there yet; climb
    }
    const parent = path.dirname(dir);
    if (parent === dir) return tmpdir();
    dir = parent;
  }
}
