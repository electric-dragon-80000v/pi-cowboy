/**
 * pane-control.ts — a no-op PaneControl for tests whose subject is not the
 * pane surface. A harness's `prepare` reaches the pane only through this
 * interface, so a transport wired for a test that never prepares anything needs
 * a stand-in that records nothing and proves nothing.
 */

import type {
  PaneControl,
  PlacementCatalog,
} from "../../src/agents/agent-host.js";

/** A pane surface that silently accepts every run and never proves output. */
export const TEST_PANE: PaneControl = {
  kind: "test",
  run: async () => {},
  waitForOutput: async () => {},
};

/**
 * A placement catalog that knows nothing and spells paths as given: for tests
 * whose subject is neither discovery nor cleanup, and which therefore only need
 * the multiplexer surface to be present.
 */
export const TEST_PLACEMENTS: PlacementCatalog = {
  multiplexer: "test",
  canonicalizePath: (value) => value,
  listWorktrees: async () => [],
  listPlacements: async () => [],
  observePane: async () => undefined,
};
