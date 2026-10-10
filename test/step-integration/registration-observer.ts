/**
 * registration-observer.ts — a probe extension for the loadout test.
 *
 * A tool shows up in the model's request, so the loadout tests read tools from
 * the stub. Commands never reach the model, so `/cowboy`'s registration is only
 * visible from inside pi: on session_start this writes the active tool names and
 * the registered command names to the file named by `PI_COWBOY_OBSERVER_FILE`.
 */

import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const file = process.env.PI_COWBOY_OBSERVER_FILE;
    if (file === undefined || file === "") return;
    writeFileSync(
      file,
      JSON.stringify({
        activeTools: pi.getActiveTools(),
        commands: pi.getCommands().map((command) => command.name),
      }),
    );
  });
}
