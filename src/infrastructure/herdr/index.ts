/**
 * index.ts — barrel for the herdr plane (see ../herdr-client.ts, the path the
 * herdr test fixtures mock).
 *
 *   Layer 1  herdr-transport.ts, polling.ts
 *   Layer 2  panes.ts, agents.ts, worktrees.ts, herdr-client.ts (facade)
 *   Layer 3  agent-stopper.ts (stop-and-confirm state machine)
 */

export * from "./herdr-transport.js";
export * from "./polling.js";
export * from "./panes.js";
export * from "./agents.js";
export * from "./worktrees.js";
export * from "./herdr-client.js";
export * from "./agent-stopper.js";
