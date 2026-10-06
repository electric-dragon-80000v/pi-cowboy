/**
 * result-file-permissions.ts — owner-only modes for per-agent result dirs.
 *
 * Spawns stage secret-bearing files under the spawn's result directory
 * (`<tmpdir>/pi-cowboy/<agentId>/`);
 * the process umask would leave them world-readable, so directories enforce
 * `0o700` and files `0o600`. The `mkdir`/`write` mode option applies only on
 * creation, so every helper also `chmod`s for paths that already exist.
 * Both calls throw: a spawn that cannot lock its secrets down fails its
 * launch instead of proceeding world-readable.
 */

import fs from "node:fs";

/** Mode for per-agent result directories (`<tmpdir>/pi-cowboy/<agentId>/`). */
export const RESULT_DIR_MODE = 0o700;

/** Mode for the secret-bearing files staged inside a result directory. */
export const RESULT_FILE_MODE = 0o600;

/** Throws on any failure — callers must let it fail the launch. */
export function ensureResultDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: RESULT_DIR_MODE });
  fs.chmodSync(dir, RESULT_DIR_MODE);
}

/** Throws on any failure — callers must let it fail the launch. */
export function writeResultFile(file: string, content: string): void {
  fs.writeFileSync(file, content, {
    encoding: "utf-8",
    mode: RESULT_FILE_MODE,
  });
  fs.chmodSync(file, RESULT_FILE_MODE);
}
