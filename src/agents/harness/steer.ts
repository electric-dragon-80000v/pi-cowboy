/**
 * steer.ts — how a harness whose process the multiplexer names as an agent
 * takes a steering message.
 *
 * Every built-in harness launches a binary the multiplexer's agent registry
 * recognizes, so their steer is one call: the pane's agent surface, which
 * validates the target and writes the text and its submission in order. A
 * harness outside that registry is not one of these — it implements `steer`
 * itself, through whatever input its own TUI reads.
 *
 * The capability is checked here rather than at the call site so every built-in
 * reports the same refusal: a multiplexer with no agent surface cannot be
 * steered, and saying so beats typing into whatever the pane's foreground is.
 */

import type { HarnessSteer } from "../harness.js";

export const steerThroughAgentSurface: HarnessSteer = ({
  pane,
  paneId,
  message,
}) => {
  if (!pane.promptAgent) {
    return Promise.resolve({
      kind: "not-submitted",
      detail:
        "this multiplexer offers no agent surface, so the message cannot be delivered.",
    });
  }
  return pane.promptAgent(paneId, message);
};
