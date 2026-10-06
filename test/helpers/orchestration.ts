/**
 * orchestration.ts — the resolved template test spawns carry as
 * `orchestration`. A spawn cannot be built without one: a test that does not
 * care which template it is uses this, and a test that cares spreads its own
 * over it.
 */

import { DEFAULT_ORCHESTRATORS } from "../../src/orchestrators/default-orchestrators.js";
import type { OrchestratorConfig } from "../../src/orchestrators/types.js";

/** The built-in `default` template, name/cues/guidance and all. */
export const TEST_ORCHESTRATION: OrchestratorConfig =
  DEFAULT_ORCHESTRATORS.default;
