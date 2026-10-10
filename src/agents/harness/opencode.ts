/**
 * harness/opencode.ts — the opencode harness: detected on PATH, not launched.
 *
 * opencode is not a pi-compatible binary, so nothing here can reuse the
 * pi-compatible factory: `prepare` and `buildArgs` throw a not-yet-implemented
 * error, and a spawn configured for opencode fails loudly at launch rather than
 * running pi's argv under a binary that has not mapped it. Detection is real
 * meanwhile — the availability probe, the settings row, and the template's
 * `harness_type` enum all answer for it wherever the binary is on PATH.
 *
 * What lands with the implementation: the opencode CLI mapping in `buildArgs`,
 * opencode's own model settings, and its strict slice of the template
 * `[harness]` schema.
 */

import { commandPath } from "../../infrastructure/exec-path.js";
import { HerdrError } from "../../infrastructure/herdr-client.js";
import type { Harness } from "../harness.js";

const NOT_IMPLEMENTED =
  "the opencode harness is not implemented yet; use pi, pig, or pi-bolt meanwhile";

export const opencodeHarness: Harness = {
  id: "opencode",
  available: () => commandPath("opencode") !== undefined,
  async prepare(): Promise<void> {
    throw new HerdrError(NOT_IMPLEMENTED, undefined);
  },
  buildArgs(): string[] {
    throw new HerdrError(NOT_IMPLEMENTED, undefined);
  },
  teardown: async () => {},
};
