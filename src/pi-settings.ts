/**
 * pi-settings.ts — pi's `defaultThinkingLevel` setting, read without pi's barrel.
 * The barrel is resolved lazily so it stays off the boot-time import graph;
 * `agentDir` stays injectable for tests.
 */
import type { ThinkingLevel } from "./types.js";
import { agentDir as resolveAgentDir } from "./paths.js";

/** pi's `defaultThinkingLevel` for `cwd` (project over global). `agentDir` is injectable for tests. */
export async function getPiDefaultThinkingLevel(
  cwd: string,
  agentDir?: string,
): Promise<ThinkingLevel | undefined> {
  // Deferred value import: keeps the barrel off the boot-time import graph.
  const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
  return SettingsManager.create(
    cwd,
    agentDir ?? resolveAgentDir(),
  ).getDefaultThinkingLevel();
}
