/**
 * harness-derivation.ts — one variant's registry entry, built from its
 * declaration and its base's answer.
 *
 * Pure: the base arrives as an answer, because a variant may register before the
 * harness it derives from, and a missing or cyclic chain is something the entry
 * reports rather than a reason registration fails. The registry owns the graph
 * and the state; this module owns only how a variant presents itself once that
 * graph has answered.
 */

import type {
  AnyHarnessId,
  HarnessAvailability,
  HarnessDerivation,
} from "../harness.js";
import type { RegisteredHarness } from "./harness-registry.js";
import { decorateHarness } from "./harness-decoration.js";

/** The harness a variant delegates to, or why it has none. */
export type BaseResolution =
  | { readonly kind: "resolved"; readonly harness: RegisteredHarness }
  | { readonly kind: "missing"; readonly id: AnyHarnessId }
  | { readonly kind: "cycle"; readonly id: AnyHarnessId };

/**
 * The registry entry `derivation` describes.
 *
 * Capability members are getters: a base that registers later, or one whose
 * reader appears with it, is answered as it stands when a launch asks. The
 * hooks come from the decoration composition, so a variant stays the base's
 * implementation plus its own preparation.
 */
export function deriveHarness(
  derivation: HarnessDerivation,
  base: () => BaseResolution,
): RegisteredHarness {
  const requireBase = (): RegisteredHarness => {
    const answer = base();
    if (answer.kind !== "resolved") {
      throw new Error(`no harness registered for "${derivation.base}"`);
    }
    return answer.harness;
  };
  const decorated = decorateHarness(requireBase, derivation);

  const availability = (): HarnessAvailability => {
    const answer = base();
    if (answer.kind === "missing") {
      return {
        status: "unavailable",
        notice: `its base harness "${answer.id}" is not registered`,
      };
    }
    if (answer.kind === "cycle") {
      return {
        status: "unavailable",
        notice: `its base chain cycles through "${answer.id}"`,
      };
    }
    return decorated.availability();
  };

  return {
    id: derivation.id,
    displayName: derivation.displayName,
    get family() {
      const answer = base();
      return answer.kind === "resolved" ? answer.harness.family : undefined;
    },
    get agentMultiplexerKind() {
      return decorated.agentMultiplexerKind;
    },
    get config() {
      return decorated.config;
    },
    get readHandoverRecords() {
      return decorated.readHandoverRecords;
    },
    get readEnv() {
      return decorated.readEnv;
    },
    defaultEnv: decorated.defaultEnv,
    reservedEnvVars: decorated.reservedEnvVars,
    inheritedEnv: decorated.inheritedEnv,
    availability,
    prepare: (request) => decorated.prepare(request),
    postStart: async (request) => {
      await decorated.postStart?.(request);
    },
    stop: (request) => decorated.stop(request),
    steer: (request) => decorated.steer(request),
    buildArgs: (launch) => decorated.buildArgs(launch),
    teardown: (request) => decorated.teardown(request),
    listModels: (request) => decorated.listModels(request),
  };
}
