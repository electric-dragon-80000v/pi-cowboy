/**
 * utils.ts — security helpers and general utilities.
 * isUnsafeName guards agent/skill name resolution against path traversal.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelChoice } from "./types.js";

/** Alphanumeric, hyphen, underscore, dot — no leading dot. */
export function isUnsafeName(name: string): boolean {
  return (
    !name || name.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)
  );
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

/**
 * The name a spawn's model records and displays: pi's catalog id, or a foreign
 * choice's own name — the launching harness's label for the key, or the key
 * itself when that harness's list did not name it.
 */
export function modelChoiceName(
  choice: ModelChoice | undefined,
): string | undefined {
  if (!choice) return undefined;
  if ("model" in choice) return choice.model.id;
  // An inherited model names nothing: there is no key of the spawn's own to show.
  return "harness" in choice ? choice.name : undefined;
}

/**
 * The model key a choice names, or undefined when it names none — an inherited
 * model has no key of the spawn's own to pool or display against.
 */
export function modelChoiceKey(
  choice: ModelChoice | undefined,
): string | undefined {
  return choice != null && "key" in choice ? choice.key : undefined;
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
