/**
 * exec-sync.ts — the one place this extension waits for a child process.
 *
 * The harness availability probe is synchronous by design: its verdict is in the
 * shell before the first menu can open, and a binary's version is part of that
 * verdict. Everything else shells out asynchronously through `pi.exec`, so
 * children inherit the session environment; nothing here needs that, because a
 * version read is one word of output from a binary PATH has already resolved.
 */

import { execFileSync } from "node:child_process";

/**
 * Run a command and wait for its output, or undefined when it did not answer: a
 * missing binary, a non-zero exit and a timeout are one answer here, because a
 * caller that needs a successful run has no use for a failure's exit code.
 *
 * Stdin is discarded rather than inherited, so a command that reads it cannot
 * wait on a terminal that is not there.
 */
export function runSync(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): string | undefined {
  try {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}
