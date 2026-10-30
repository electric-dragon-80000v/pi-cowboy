/**
 * handover-target.test.ts — the target list a handover offers, and the refusal
 * a named harness earns. Registry and availability are fakes: the module owns
 * only the rules.
 */
import { describe, expect, it } from "vitest";
import type { AnyHarnessId } from "../src/agents/harness.js";
import type { HarnessRegistry } from "../src/agents/harness/harness-registry.js";
import {
  handoverTargets,
  resolveHandoverTarget,
} from "../src/agents/handover-target.js";
import { probed, unprobed } from "../src/availability.js";

/** A registry that knows exactly these ids. */
function registryOf(ids: AnyHarnessId[]): Pick<HarnessRegistry, "ids" | "get"> {
  return {
    ids: () => ids,
    get: (id) =>
      ids.includes(id) ? ({} as ReturnType<HarnessRegistry["get"]>) : undefined,
  };
}

const ALL = ["pi", "claude", "codex"] as const;

describe("handoverTargets", () => {
  it("keeps registry order and excludes the source harness", () => {
    expect(handoverTargets(registryOf([...ALL]), unprobed(), "claude")).toEqual(
      ["pi", "codex"],
    );
  });

  it("drops the harnesses this machine cannot launch", () => {
    expect(
      handoverTargets(registryOf([...ALL]), probed(["pi", "codex"]), "pi"),
    ).toEqual(["codex"]);
  });

  it("offers nothing when the source is the only launchable harness", () => {
    expect(handoverTargets(registryOf([...ALL]), probed(["pi"]), "pi")).toEqual(
      [],
    );
  });

  it("excludes a plugin source by identity alone", () => {
    expect(
      handoverTargets(
        registryOf(["pi", "reg-plugin"]),
        unprobed(),
        "reg-plugin",
      ),
    ).toEqual(["pi"]);
  });
});

describe("resolveHandoverTarget", () => {
  it("refuses an empty harness, naming nothing as the fallback", () => {
    expect(
      resolveHandoverTarget("  ", registryOf([...ALL]), unprobed()),
    ).toEqual({
      kind: "faulted",
      fault: {
        kind: "request-refused",
        detail:
          "`harness_type` is required — name the harness that runs the next run. Nothing was changed.",
      },
    });
  });

  it("refuses an unregistered harness, naming the registered ones", () => {
    expect(
      resolveHandoverTarget("gemini", registryOf([...ALL]), unprobed()),
    ).toEqual({
      kind: "faulted",
      fault: {
        kind: "request-refused",
        detail:
          'Unknown harness_type "gemini": this session registered pi, claude, codex. Nothing was changed — name a registered harness that runs the next run.',
      },
    });
  });

  it("refuses a harness this machine cannot launch, naming the launchable ones", () => {
    expect(
      resolveHandoverTarget("claude", registryOf([...ALL]), probed(["pi"])),
    ).toEqual({
      kind: "faulted",
      fault: {
        kind: "request-refused",
        detail:
          'Harness "claude" cannot be launched on this machine — this machine can launch pi. Nothing was changed.',
      },
    });
  });

  it("accepts a registered, launchable harness", () => {
    expect(
      resolveHandoverTarget(
        " claude ",
        registryOf([...ALL]),
        probed(["claude"]),
      ),
    ).toEqual({ kind: "ready", harness: "claude" });
  });

  it("accepts any registered harness while no probe has answered", () => {
    expect(
      resolveHandoverTarget("codex", registryOf([...ALL]), unprobed()),
    ).toEqual({ kind: "ready", harness: "codex" });
  });
});
