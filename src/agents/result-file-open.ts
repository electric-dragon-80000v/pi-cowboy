/**
 * result-file-open.ts — whether a run's report can be handed to the desktop.
 *
 * The report lives outside the worktree, at the path `paths.ts` derives from the
 * agent id. The status menu opens it with macOS's `open`; the decision of what
 * there is to open is kept here, apart from the menu.
 */
import fs from "node:fs";

/**
 * The file `open` should show, or `undefined` when there is nothing to show.
 * Only macOS is offered, because `open` is the command the menu runs. An empty
 * report is not a result: a run that has not written one leaves its file absent
 * or zero bytes long.
 */
export function openableResultFile(
  resultFile: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "darwin") return undefined;
  try {
    const stats = fs.statSync(resultFile);
    return stats.isFile() && stats.size > 0 ? resultFile : undefined;
  } catch {
    return undefined;
  }
}
