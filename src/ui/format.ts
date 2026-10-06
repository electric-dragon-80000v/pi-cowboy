/** Display formatting helpers shared by the UI layer. */

import { getAgentConfig } from "../agents/agent-types.js";
import type { SubagentType } from "../agents/types.js";
import type { AgentStatus } from "../types.js";
import type { Theme } from "./types.js";

/** Single source of truth for per-agent status icons (tool call lines, status widget, conversation viewer). */
const STATUS_ICON: Record<
  AgentStatus,
  { icon: string; color: "accent" | "success" | "error" | "dim" }
> = {
  queued: { icon: "◆", color: "accent" },
  spawned: { icon: "◈", color: "accent" },
  completed: { icon: "✓", color: "success" },
  error: { icon: "✗", color: "error" },
  stopped: { icon: "■", color: "dim" },
};

/** Theme-colored icon for an agent status, or a muted ▸ when absent. */
export function statusIcon(
  status: AgentStatus | undefined,
  theme: Theme,
): string {
  if (status === undefined) return theme.fg("muted", "▸");
  const entry = STATUS_ICON[status];
  return theme.fg(entry.color, entry.icon);
}

/** Format milliseconds as a compact human-readable duration: "1h 1m 1s", "5m 37s", "10s", "<1s". */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "<1s";

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(" ");
}

export function getDisplayName(type: SubagentType): string {
  const config = getAgentConfig(type);
  return config?.displayName ?? config?.name ?? "Agent";
}

export function agentBulletPrefix(theme: Theme): string {
  return `${theme.fg("accent", "•")} `;
}

/** Shorten a path to its tail, prefixed with "..." when it is longer than `maxLength`. */
export function truncatePath(path: string, maxLength: number): string {
  if (path.length <= maxLength) return path;
  return "..." + path.slice(path.length - maxLength + 3);
}
