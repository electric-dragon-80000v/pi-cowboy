/**
 * transport.ts — the transport a test builds a manager with. Production hands the
 * manager the session's runtime (`createAgentManagerTransport` in agent-manager.ts);
 * a test that builds a manager itself supplies one, so the manager never resolves a
 * multiplexer on its own.
 */

import { createAgentManagerTransport } from "../../src/agents/agent-manager.js";
import { createHerdrRuntime } from "../../src/infrastructure/herdr-host.js";
import type { SupervisorTransport } from "../../src/subagent/pane-supervisor.js";

/**
 * The session's transport over the built-in multiplexer, for a test whose assertions
 * read the mocked herdr client through the real host and placement catalog.
 */
export function builtinTransport(): SupervisorTransport {
  return createAgentManagerTransport(createHerdrRuntime({} as never));
}

/**
 * A transport that refuses to be used: for a manager whose test runs admission, store
 * and listing logic only. Reaching it means the test spawned or cleaned up a
 * placement it did not intend to.
 */
export function noMultiplexer(): SupervisorTransport {
  const unreachable = (): never => {
    throw new Error("this test's manager must not reach the multiplexer");
  };
  return {
    createHost: unreachable,
    createPane: unreachable,
    createPlacements: unreachable,
    createDeliverable: unreachable,
  };
}
