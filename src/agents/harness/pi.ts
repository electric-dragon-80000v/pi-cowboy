/**
 * harness/pi.ts — the pi harness: the family's namesake binary.
 *
 * pi is already the pane shell's `pi`, so unlike its siblings nothing has to be
 * forwarded: its argv and model list are the family's own, which pi-compatible.ts
 * assembles for every pi-compatible binary, and its store is pi-store.ts's. The
 * launcher is installed only when the spawn carries env overrides — the one
 * thing a real binary cannot be handed any other way.
 */

import { type Harness, type PiFamilyLaunchRequest } from "../harness.js";
import { installPaneLauncher, launchEnvBody } from "./pane-launcher.js";
import { buildPiLaunchArgs, piFamilyListModels } from "./pi-compatible.js";
import { exportForHandoverOf } from "./pi-session.js";
import { piStore } from "./pi-store.js";

/** Signature the env launcher carries, so verification proves which launcher landed. */
const PI_ENV_LAUNCHER_SIGNATURE = "PI_ENV_LAUNCHER_4c7d19";

/** Token the verify command echoes once the env launcher body is confirmed. */
const PI_ENV_READY_MARKER = "PI_ENV_VERIFIED";

/**
 * Real pi is already the pane shell's `pi`: it is always launchable, and it
 * needs no launcher unless the spawn carries env overrides — a real binary
 * cannot be handed a per-launch environment any other way. Its argv is the
 * family's shared assembly — pi is the family's namesake — and its model list
 * is the family's shared catalog.
 */
export const piHarness: Harness<PiFamilyLaunchRequest> = {
  agentMultiplexerKind: "pi",
  availability: () => ({ status: "available" }),
  // The real binary is a pi binary like any other: same store, so the same
  // inheritance and the same export its siblings get from the factory.
  inheritedEnv: () => piStore.inheritedEnv(process.env),
  reservedEnvVars: () => piStore.reservedNames,
  exportForHandover: exportForHandoverOf(piStore),
  async prepare({ pane, paneId, launch }): Promise<void> {
    // Nothing to hand over, no launcher: the pane's own `pi` is already the
    // binary, and its environment is the whole answer.
    if (launch.envFile === null) return;
    await installPaneLauncher(pane, paneId, {
      commandName: "pi",
      body: launchEnvBody(launch.envFile, 'command pi "$@"'),
      signature: PI_ENV_LAUNCHER_SIGNATURE,
      readyMarker: PI_ENV_READY_MARKER,
    });
  },
  buildArgs: buildPiLaunchArgs,
  listModels: piFamilyListModels,
  // The catalog is local: nothing to warm.
  prefetchModels: () => {},
  teardown: async () => {},
};
