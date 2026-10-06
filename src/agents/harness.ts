/**
 * harness.ts — the harness contract: which process launches a subagent, and how.
 *
 * A template's `[harness]` table is harness-specific — its fields belong to the
 * harness that owns them. This module holds only what every harness has in
 * common plus the id vocabulary; each harness's implementation lives beside it
 * (harness/pig.ts, harness/pi-bolt.ts) and is selected through
 * harness/registry.ts.
 *
 * `HARNESS_IDS` stays the full vocabulary everywhere a value is read or written:
 * a template written where a harness exists must still load where it does not.
 * Which harnesses a machine can launch only narrows what the setting offers and
 * which harness a spawn ends up using.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAvailable, type Availability } from "../availability.js";

/** Every selectable harness. The `harness_type` enum and `HarnessId` derive from this. */
export const HARNESS_IDS = ["pi", "pig", "pi-bolt"] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

/** A template that omits `harness_type` launches under pi. */
export const DEFAULT_HARNESS: HarnessId = "pi";

/** Narrow untrusted input (config, menu) to a canonical harness; invalid values fall back at the config boundary. */
export function parseHarnessId(value: unknown): HarnessId | undefined {
  return HARNESS_IDS.find((id): id is HarnessId => id === value);
}

/**
 * Which harness a spawn launches under. A harness this machine cannot launch
 * falls back to pi whatever the setting or the template says — the same answer
 * the setting itself is narrowed to, so the menu can never offer a harness a
 * spawn would not use, and an unavailable value never fails a spawn.
 */
export function resolveHarness(
  configured: HarnessId,
  availability: Availability<HarnessId>,
): HarnessId {
  return isAvailable(configured, availability) ? configured : DEFAULT_HARNESS;
}

/** What a harness needs to bring its host pane into the state it launches in. */
export interface HarnessPrepareRequest {
  readonly pi: ExtensionAPI;
  readonly paneId: string;
  readonly cwd: string;
}

/** One harness implementation. */
export interface Harness {
  readonly id: HarnessId;
  /**
   * Whether this machine can launch the harness, read at probe time. False keeps
   * the harness out of the setting, and a template that still names it falls back
   * to pi instead of opening a pane that could never run it.
   */
  available(): boolean;
  /**
   * Bring the pane into the state this harness launches in. Idempotent;
   * throws when the state could not be established.
   */
  prepare(request: HarnessPrepareRequest): Promise<void>;
}
