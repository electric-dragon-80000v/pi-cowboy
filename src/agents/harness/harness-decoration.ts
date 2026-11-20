/**
 * harness-decoration.ts — one harness with another's behaviour layered over it.
 *
 * This is the composition a derivation applies, kept where it needs no id, no
 * base graph and no plugin loader: a caller holding a harness can layer the same
 * hooks on it for one launch without registering a variant. The registry keeps
 * the ids and the base graph; this module only knows harnesses.
 */

import type { Harness, HarnessDecoration } from "../harness.js";

/** Resolve the harness underneath, when it is asked, not when it is composed. */
type Base = () => Harness;

/**
 * The harness `decoration` describes, over `base`.
 *
 * The base may be a resolver because the registry answers a derivation's base
 * when a launch asks, not when the variant registered: a base that registers
 * later, or a chain that never resolves, is answered as it stands at the call.
 *
 * Hooks compose in the order the lifecycle runs — the decoration prepares, then
 * the base; the base starts, then the decoration; the decoration tears down,
 * then the base. Everything the decoration does not declare is the base's, so a
 * decoration is never a second implementation of the harness.
 */
export function decorateHarness(
  base: Harness | Base,
  decoration: HarnessDecoration,
): Harness {
  const of: Base = typeof base === "function" ? base : () => base;
  return {
    // Capabilities are read when asked, for the same reason the base is.
    get config() {
      return of().config;
    },
    get agentMultiplexerKind() {
      return of().agentMultiplexerKind;
    },
    get readHandoverRecords() {
      return of().readHandoverRecords;
    },
    defaultEnv: decoration.env,
    reservedEnvVars: () => [
      ...(of().reservedEnvVars?.() ?? []),
      ...(decoration.reservedEnvVars?.() ?? []),
    ],
    inheritedEnv: () => {
      const inherited = of().inheritedEnv?.() ?? {};
      const declared = decoration.env?.() ?? {};
      // A name the base's launch inherits is one its child and the export read
      // the same way (codex's home, pi's store). A decoration that declares a
      // value for it is the harness that will actually run, so its value wins
      // there; every other declared name stays a default, under configuration.
      const overrides = Object.fromEntries(
        Object.entries(declared).filter(([name]) => name in inherited),
      );
      return { ...inherited, ...overrides };
    },
    availability: () => {
      const answer = of().availability();
      if (answer.status === "unavailable") return answer;
      return decoration.availability?.() ?? { status: "available" as const };
    },
    prepare: async (request) => {
      await decoration.prepare?.(request);
      await of().prepare(request);
    },
    postStart: async (request) => {
      await of().postStart?.(request);
      await decoration.postStart?.(request);
    },
    stop: (request) => of().stop(request),
    buildArgs: (launch) => of().buildArgs(launch),
    teardown: async (request) => {
      await decoration.teardown?.(request);
      await of().teardown(request);
    },
    steer: (request) => of().steer(request),
    listModels: (request) => of().listModels(request),
  };
}
