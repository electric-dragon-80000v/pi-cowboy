/**
 * result-artifacts.ts — the staging directory a run's files live in.
 *
 * A spawn stages its briefing, prompt, and report under
 * `<tmpdir>/pi-cowboy/<agentId>/` (see paths.ts). Those files are ephemeral, so
 * the directory's whole lifecycle here is "remove it once nothing can report
 * into it".
 */

import fs from "node:fs";
import * as path from "node:path";

/**
 * Remove a run's result directory. Best effort, and safe when it is already
 * gone — the files are ephemeral temp-dir artifacts.
 *
 * The artifacts outlive settlement: a settled run stays watched, so the child
 * may keep writing reports to this same directory until the run is dropped.
 */
export function removeResultArtifacts(resultFile: string): void {
  try {
    fs.rmSync(path.dirname(resultFile), { recursive: true, force: true });
  } catch {
    // Best effort: the agent's files are ephemeral temp-dir artifacts.
  }
}
