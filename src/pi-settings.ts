/** pi-settings.ts — pi's `defaultThinkingLevel` setting. `agentDir` is injectable for tests. */
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./types.js";
import { agentDir as resolveAgentDir } from "./paths.js";

/** pi's `defaultThinkingLevel` for `cwd` (project over global). `agentDir` is injectable for tests. */
export async function getPiDefaultThinkingLevel(
  cwd: string,
  agentDir?: string,
): Promise<ThinkingLevel | undefined> {
  return SettingsManager.create(
    cwd,
    agentDir ?? resolveAgentDir(),
  ).getDefaultThinkingLevel();
}
