/**
 * harness-family.ts — which launch family a harness id belongs to.
 *
 * A family shares one binary and therefore one model catalogue: the pi family
 * (pi, pig, pi-bolt) runs pi and reads pi's model keys, opencode, codex and
 * claude read their own.
 * Keyed by harness id, so a harness added to `HARNESS_IDS` without a family
 * fails to compile. The launch family is what a template's model key is filed
 * under and what a launch reads it back through, so one family's key can never
 * be read out of a catalogue that does not define it.
 */

import type { HarnessFamily, HarnessId } from "./harness.js";

const HARNESS_FAMILIES: Record<HarnessId, HarnessFamily> = {
  pi: "pi",
  pig: "pi",
  "pi-bolt": "pi",
  opencode: "opencode",
  codex: "codex",
  claude: "claude",
};

/** The family whose model catalogue this harness's launch reads. */
export function harnessFamilyOf(id: HarnessId): HarnessFamily {
  return HARNESS_FAMILIES[id];
}
