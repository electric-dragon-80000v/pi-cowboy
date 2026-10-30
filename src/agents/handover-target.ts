/**
 * handover-target.ts — which harnesses a handover can target here, and why one
 * named harness cannot. The tool and the status menu ask these questions of the
 * same function, so a target the menu offers is a target the tool accepts.
 *
 * Registry and availability are injected: this module knows no session state,
 * so it runs against fakes in tests.
 */

import { isAvailable, selectable, type Availability } from "../availability.js";
import type { HarnessRegistry } from "./harness/harness-registry.js";
import type { AnyHarnessId } from "./harness.js";

/** Why a named harness cannot receive a handover. */
export interface HandoverTargetFault {
  readonly kind: "request-refused";
  readonly detail: string;
}

/** The registry answers this module asks for. */
export type TargetRegistry = Pick<HarnessRegistry, "ids" | "get">;

/**
 * The ids a handover can target, in registry order: registered and launchable
 * on this machine, never the source harness (a run cannot succeed itself).
 */
export function handoverTargets(
  registry: TargetRegistry,
  availability: Availability<AnyHarnessId>,
  source: AnyHarnessId,
): AnyHarnessId[] {
  return selectable(registry.ids(), availability).filter((id) => id !== source);
}

/**
 * The target harness, held to a handover's own rule: required, registered
 * here, and launchable on this machine — never a fallback. A spawn's refusal
 * text offers the template and configured default, which a handover does not
 * have, so its messages are its own.
 */
export function resolveHandoverTarget(
  raw: string,
  registry: TargetRegistry,
  availability: Availability<AnyHarnessId>,
):
  | { readonly kind: "ready"; readonly harness: AnyHarnessId }
  | { readonly kind: "faulted"; readonly fault: HandoverTargetFault } {
  const value = raw.trim();
  if (value === "") {
    return {
      kind: "faulted",
      fault: {
        kind: "request-refused",
        detail:
          "`harness_type` is required — name the harness that runs the next run. Nothing was changed.",
      },
    };
  }
  if (registry.get(value) === undefined) {
    return {
      kind: "faulted",
      fault: {
        kind: "request-refused",
        detail: `Unknown harness_type "${value}": this session registered ${registry.ids().join(", ")}. Nothing was changed — name a registered harness that runs the next run.`,
      },
    };
  }
  if (!isAvailable(value, availability)) {
    return {
      kind: "faulted",
      fault: {
        kind: "request-refused",
        detail: `Harness "${value}" cannot be launched on this machine — this machine can launch ${selectable(registry.ids(), availability).join(", ")}. Nothing was changed.`,
      },
    };
  }
  return { kind: "ready", harness: value };
}
