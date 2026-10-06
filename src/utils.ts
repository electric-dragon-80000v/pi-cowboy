/**
 * utils.ts — security helpers and general utilities.
 * isUnsafeName guards agent/skill name resolution against path traversal.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "./types.js";

/** Alphanumeric, hyphen, underscore, dot — no leading dot. */
export function isUnsafeName(name: string): boolean {
  return (
    !name || name.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)
  );
}

/** Tuple shape: the agent-template Zod schema builds an enum from it, so the two can never drift. */
export const VALID_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];

export function parseThinkingLevel(
  raw: string | undefined,
): ThinkingLevel | undefined {
  if (raw === undefined) return undefined;
  return VALID_THINKING_LEVELS.includes(raw as ThinkingLevel)
    ? (raw as ThinkingLevel)
    : undefined;
}

/** Line-based TUI output breaks on raw CR/LF. */
function toSingleLine(msg: string): string {
  return msg.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Await a delay. The timer is left ref'd: an unref'd timer lets an otherwise
 * idle event loop exit mid-wait, so an awaited delay would never resolve.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(err: unknown): string {
  return toSingleLine(err instanceof Error ? err.message : String(err));
}

/** Null when unparseable (no slash or empty provider). */
export function parseModelKey(
  value: unknown,
): { provider: string; modelId: string } | null {
  // Config values flow from JSON, so a mistyped value can reach here at runtime.
  if (typeof value !== "string") return null;
  const slashIdx = value.indexOf("/");
  if (slashIdx <= 0) return null;
  return {
    provider: value.slice(0, slashIdx),
    modelId: value.slice(slashIdx + 1),
  };
}

export function findModelInRegistry(
  value: unknown,
  registry: { find(provider: string, modelId: string): Model<Api> | undefined },
  fallback: Model<Api> | undefined,
): Model<Api> | undefined {
  if (!value) return fallback;
  const parsed = parseModelKey(value);
  if (!parsed) return fallback;
  return registry.find(parsed.provider, parsed.modelId) ?? fallback;
}
/** Shared by agent-runner and worktree-validator. */
export const GIT_EXEC_TIMEOUT_MS = 5000;

/**
 * Exhaustiveness guard for a discriminated union's discriminant: every member
 * must have its own arm, because an unhandled one leaves this argument typed
 * as `never` and fails to compile. Untyped input can still reach the throw.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}
