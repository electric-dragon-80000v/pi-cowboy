/**
 * json-file.ts — JSON persistence shared by the extension's state files.
 *
 * A write goes through a temporary sibling and a rename, so a reader never sees
 * half a file and a failed write leaves the previous contents in place. A read
 * treats a missing file as "nothing stored yet" and reports a file that exists
 * but cannot be read or parsed, since that is a fact about the machine rather
 * than an absence.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "./utils.js";

/** Write `value` as JSON, replacing `filePath` only once the whole file is on disk. */
export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  label: string,
): void {
  const tmpPath = filePath + ".tmp";
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error(`[subagents] Failed to save ${label}: ${errorMessage(err)}`);
  }
}

/**
 * The parsed contents of a JSON file, or `undefined` when it is missing,
 * unparsable, or unreadable. `label` names the file's kind in the warning that
 * an unreadable or malformed file produces.
 */
export function readJsonFileOrUndefined(
  filePath: string,
  label: string,
): unknown {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as { code?: string } | undefined)?.code !== "ENOENT") {
      console.warn(
        `[subagents] Ignoring unreadable ${label} ${filePath}: ${errorMessage(err)}`,
      );
    }
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    console.warn(
      `[subagents] Ignoring malformed ${label} ${filePath}: ${errorMessage(err)}`,
    );
    return undefined;
  }
}
