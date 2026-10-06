import { execFileSync } from "node:child_process";

/**
 * Resolve a bare command to its absolute path, once per worker.
 *
 * Bare names spawn through posix_spawnp, and on macOS each pays a ~10x syspolicyd
 * tax (measured 48ms vs 4ms for /bin/sh) — suites shelling out hundreds of times
 * pay it per call. The resolved path is reused for every later spawn.
 */
const resolved = new Map<string, string>();

export function resolvedBin(cmd: string): string {
  if (cmd.includes("/")) return cmd; // already absolute or relative
  let bin = resolved.get(cmd);
  if (bin === undefined) {
    bin = execFileSync("/usr/bin/which", [cmd], { encoding: "utf8" }).trim();
    if (bin === "") throw new Error(`command not found: ${cmd}`);
    resolved.set(cmd, bin);
  }
  return bin;
}
