/**
 * handover-file.ts — an export-only handover written to disk instead of
 * launched. The name carries the three identities a reader needs to find the
 * run again — its checkout, the harness that ran it, and that harness's own
 * session id — and nothing else, so the same run always lands on the same path.
 */

import fs from "node:fs";
import type { AnyHarnessId } from "./harness.js";

/** The directory handover exports are written to. */
export const HANDOVER_EXPORT_DIR = "/tmp";

/**
 * One field of a handover export name, reduced to filename-safe characters. A
 * branch may contain `/` and a harness id anything at all, so each field is
 * flattened rather than allowed to introduce a separator or a control byte.
 */
export function handoverNameField(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** What the name is built from: the three identities, as the run knows them. */
export interface HandoverFileRequest {
  /** The run's branch, or `main-<agent id>` when it ran without a worktree. */
  readonly worktree: string;
  readonly harness: AnyHarnessId;
  readonly sessionId: string;
}

/** `cowboy-handover_<worktree>_<harness>_<sessionId>.md`. */
export function handoverFileName(request: HandoverFileRequest): string {
  const fields = [request.worktree, request.harness, request.sessionId].map(
    handoverNameField,
  );
  return `cowboy-handover_${fields.join("_")}.md`;
}

/** The absolute path one name lands on. */
export function handoverFilePath(name: string): string {
  return `${HANDOVER_EXPORT_DIR}/${name}`;
}

/** Whether an artifact is already at `path`; the caller decides what that means. */
export function handoverFileExists(path: string): boolean {
  return fs.existsSync(path);
}

/**
 * Write one artifact, answering whether an existing file was replaced. The
 * caller decides whether replacing is allowed; this only performs the write.
 */
export function writeHandoverFile(
  path: string,
  text: string,
): { readonly replaced: boolean } {
  const replaced = handoverFileExists(path);
  fs.writeFileSync(path, text, "utf8");
  return { replaced };
}
