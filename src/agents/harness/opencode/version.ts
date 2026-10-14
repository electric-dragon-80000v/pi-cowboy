/**
 * opencode/version.ts — what the installed binary reports, and whether this
 * harness speaks it.
 *
 * The harness launches OpenCode 2's CLI (`mini`, `--standalone`, `--model` with
 * a `#variant`), which another major refuses outright. A machine whose
 * `opencode` is not 2.x is therefore not a machine this harness can launch on,
 * and the reason it cannot is the version itself — so the read is judged here,
 * once, and both the verdict and any line for the human come from it.
 */

import { commandPath } from "../../../infrastructure/exec-path.js";
import { runSync } from "../../../infrastructure/exec-sync.js";

/** The major this harness launches: the CLI surface its argv is built against. */
const SUPPORTED_MAJOR = "2";

/** `opencode --version` prints one line: the program, a `v`, then the version. */
const VERSION_LINE = /^opencode v(\d+\.\d+\.\d+)/;

/** Budget for the read: a binary that hangs must not hold the session's probe. */
const VERSION_TIMEOUT_MS = 5_000;

/** What the machine's opencode is, judged against the one this harness speaks. */
export type OpencodeProbe =
  | { readonly kind: "supported"; readonly version: string }
  | { readonly kind: "unsupported"; readonly version: string }
  /** A binary is there but reported no version this can read. */
  | { readonly kind: "unreadable" }
  /** No opencode on PATH. */
  | { readonly kind: "absent" };

/**
 * The version a `--version` output names, or undefined when it is not that line.
 * Nothing else about the output is read, so a banner added around it costs
 * nothing.
 */
export function parseOpencodeVersion(output: string): string | undefined {
  return VERSION_LINE.exec(output.trim())?.[1];
}

/** Whether a parsed version's CLI is the one this harness builds argv against. */
export function isSupportedOpencodeVersion(version: string): boolean {
  return version.startsWith(`${SUPPORTED_MAJOR}.`);
}

/** Read the installed binary's version. Total: every outcome is one member. */
export function probeOpencode(): OpencodeProbe {
  const bin = commandPath("opencode");
  if (bin === undefined) return { kind: "absent" };
  const output = runSync(bin, ["--version"], VERSION_TIMEOUT_MS);
  const version =
    output === undefined ? undefined : parseOpencodeVersion(output);
  if (version === undefined) return { kind: "unreadable" };
  return isSupportedOpencodeVersion(version)
    ? { kind: "supported", version }
    : { kind: "unsupported", version };
}
