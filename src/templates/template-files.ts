/**
 * template-files.ts — Generic `.toml` template-file helpers shared by the
 * agent and orchestrator discovery layers: TOML reader, single-line error
 * formatter, and directory scanner.
 *
 * The scanner is shell-free: the warning sink and the parse/name accessors
 * are caller-supplied, so each layer keeps its own schema and wording.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse, TomlError } from "smol-toml";
import { z } from "zod";

/** Warning sink for unloadable template files. */
export type TemplateNotify = (message: string, kind: "warning") => void;

const TEMPLATE_FILE_EXTENSION = ".toml";

/** Read TOML into an untrusted value for the caller's Zod schema to narrow. A leading byte-order mark is stripped — an editor artefact, not TOML syntax. */
export function parseTemplateToml(content: string): unknown {
  return parse(content.replace(/^\uFEFF/, ""));
}

export function compactDefined<T extends Record<string, unknown>>(
  obj: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, v]) => v !== undefined),
  ) as Partial<T>;
}

// --- Parse-error reporting ---

/** One Zod issue as `path: message` (`message` alone for a root issue). */
function describeZodIssue(issue: z.core.$ZodIssue): string {
  const route = issue.path.join(".");
  return route ? `${route}: ${issue.message}` : issue.message;
}

/** Collapse a parse error to one line for the scanner's skip warning (TOML errors carry a multi-line code frame). A ZodError reads per field as `cues.spawned: Invalid input: expected string, received number`. */
export function describeParseError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .map(describeZodIssue)
      .join("; ")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (err instanceof TomlError) {
    // Keep message and position; drop the code frame (the path is already in the warning).
    const [head] = err.message.split("\n\n");
    return `${head} (line ${err.line}, column ${err.column})`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim();
}

// --- scanTemplateFilesInDir ---

export interface TemplateScanWarning {
  /** Noun naming the file kind. */
  label: string;
  /** Clause between the file path and the parse message. */
  problem: string;
}

const DEFAULT_WARNING: TemplateScanWarning = {
  label: "File",
  problem: "was skipped",
};

/**
 * Scan a directory for `.toml` templates; empty array when it doesn't exist.
 * Kept when `parse` succeeds AND `getName` returns a name — an unnamed file
 * is not a template, dropped silently. A parse throw is dropped with a
 * one-line `notify` warning; a read failure stays quiet (nothing to report).
 */
export async function scanTemplateFilesInDir<T>(
  dirPath: string,
  parseFile: (content: string) => T,
  getName: (parsed: T) => string | undefined,
  notify?: TemplateNotify,
  warning: TemplateScanWarning = DEFAULT_WARNING,
): Promise<T[]> {
  try {
    await fs.promises.access(dirPath);
  } catch {
    return [];
  }

  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const templateFiles = entries.filter(
    (e) => e.isFile() && e.name.endsWith(TEMPLATE_FILE_EXTENSION),
  );

  const templates: T[] = [];
  for (const entry of templateFiles) {
    const filePath = path.join(dirPath, entry.name);

    let content: string;
    try {
      content = await fs.promises.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    try {
      const parsed = parseFile(content);
      if (getName(parsed)) {
        templates.push(parsed);
      }
    } catch (err) {
      notify?.(
        `[cowboy] ${warning.label} file ${filePath} ${warning.problem}: ${describeParseError(err)}`,
        "warning",
      );
    }
  }
  return templates;
}
