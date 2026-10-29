/**
 * agent-settings-plugin-harness.test.ts — the Agent settings "Default harness"
 * row reads the live registry, so a harness a plugin registered is offered and
 * selectable exactly like a built-in, and one the probe did not confirm stays
 * off the offer. Each case installs the session's registry, so the plugin harness
 * it registers answers for that case alone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getHarnessRegistry } from "../../src/shell.js";
import { probed, unprobed } from "../../src/availability.js";
import { KEY, openMenu, type MenuSession } from "./harness.js";
import { resetShell, setPi, shellState } from "./shell-mock.js";
import { createMemoryStore, type MemoryStore } from "./store.js";

vi.mock("../../src/shell.js", () => import("./shell-mock.js"));

const { showSpawnOptionsMenu } =
  await import("../../src/ui/menu/menu-agent-settings.js");

let memory: MemoryStore;

beforeEach(() => {
  resetShell();
  getHarnessRegistry().register({
    id: "demo-harness",
    displayName: "Demo Harness",
    agentMultiplexerKind: "demo-harness",
    availability: () => ({ status: "available" }),
    prepare: async () => {},
    buildArgs: () => [],
    teardown: async () => {},
    listModels: async () => ({ kind: "listed", entries: [] }),
    stop: async () => {},
    prefetchModels: () => {},
  });
  setPi({ exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
  memory = createMemoryStore({ projectStatus: "absent" });
  memory.install();
});

function openAgentSettings(): MenuSession {
  return openMenu((ctx: ExtensionCommandContext) => showSpawnOptionsMenu(ctx));
}

describe("Agent settings — a plugin harness in the default-harness row", () => {
  it("offers a registered plugin harness and selects it", async () => {
    shellState.harnessAvailability = probed(["pi", "demo-harness"]);

    const session = openAgentSettings();
    session.focus("Default harness");
    session.press(KEY.enter);
    await session.settle();

    expect(session.activeRow()?.value).toBe("demo-harness");
    expect(memory.store.agent.harnessType).toBe("demo-harness");
  });

  it("keeps an unconfirmed plugin harness off the offer", async () => {
    // The probe ran and did not confirm the plugin, so the row never reaches it.
    shellState.harnessAvailability = probed(["pi"]);

    const session = openAgentSettings();
    session.focus("Default harness");
    session.press(KEY.enter);
    await session.settle();

    expect(session.activeRow()?.value).toBe("pi");
    expect(memory.store.agent.harnessType).toBe("pi");
  });

  it("keeps a harness whose codec failed off the offer", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const harnesses = getHarnessRegistry();
    harnesses.register({
      id: "broken-harness",
      displayName: "Broken Harness",
      agentMultiplexerKind: "broken-harness",
      availability: () => ({ status: "available" }),
      prepare: async () => {},
      buildArgs: () => [],
      teardown: async () => {},
      listModels: async () => ({ kind: "listed", entries: [] }),
      stop: async () => {},
      prefetchModels: () => {},
      config: {
        scope: "global",
        parse: () => {
          throw new Error("bad slice");
        },
      },
    });
    harnesses.validateConfigs({ global: {}, project: {} }, () => {});
    shellState.harnessAvailability = unprobed();

    const session = openAgentSettings();
    session.focus("Default harness");

    expect(harnesses.ids()).not.toContain("broken-harness");
    expect(session.text().replace(/\s+/g, " ")).not.toContain("broken-harness");

    const seen: string[] = [];
    for (let press = 0; press < harnesses.ids().length; press++) {
      session.press(KEY.enter);
      seen.push(session.activeRow()?.value ?? "");
    }

    expect(seen).not.toContain("broken-harness");
    expect(seen).toContain("demo-harness");
    vi.restoreAllMocks();
  });

  it("keeps every registered harness on offer before the probe lands", () => {
    shellState.harnessAvailability = unprobed();

    const session = openAgentSettings();
    session.focus("Default harness");

    // Cycling from pi reaches the plugin harness: an unknown verdict rules
    // nothing out, exactly as it does for a built-in.
    const seen: string[] = [];
    for (let press = 0; press < getHarnessRegistry().ids().length; press++) {
      session.press(KEY.enter);
      seen.push(session.activeRow()?.value ?? "");
    }

    expect(seen).toContain("demo-harness");
  });
});
