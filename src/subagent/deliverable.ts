/**
 * deliverable.ts — the child's report: the file it writes, the parent's read of
 * it.
 *
 * A run's deliverable is a file on disk, not a message. The child is told where
 * to write it by its prompt, and the parent reads it here. No protocol carries
 * it, and nothing here needs the child to run the extension.
 */

import fs from "node:fs";

/** A read of the run's result file: what the child last wrote, and when. */
export interface DeliverableReport {
  content: string;
  /**
   * The file's modification time. Read with the content so a rewrite that
   * repeats the same words still counts as a report the caller has not seen.
   */
  mtime: number;
}

/** The parent's read of one run's deliverable. */
export interface DeliverableSource {
  readDeliverable(): Promise<DeliverableReport | null>;
}

/**
 * The deliverable as the run's result file. Parent and child derive the path
 * independently (`subagentResultFileFor`), so no path ever travels between them.
 */
export class FileDeliverable implements DeliverableSource {
  constructor(private readonly resultFile: string) {}

  /**
   * The child's last report, or null when it is absent, unreadable, or blank —
   * the run has not finished. The content rides with the file's modification
   * time, because a rewritten report of the same words is still news. The stamp
   * is sampled before the content: a write landing between the two calls leaves
   * the pair understating the file rather than overstating it, and the next poll
   * corrects it.
   */
  async readDeliverable(): Promise<DeliverableReport | null> {
    try {
      const mtime = fs.statSync(this.resultFile).mtimeMs;
      const content = fs.readFileSync(this.resultFile, "utf-8").trim();
      if (!content) return null;
      return { content, mtime };
    } catch {
      return null;
    }
  }
}
