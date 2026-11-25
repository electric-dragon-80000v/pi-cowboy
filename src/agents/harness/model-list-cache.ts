/**
 * model-list-cache.ts — the last model list each harness successfully listed.
 *
 * A harness's list comes from its own CLI, so a CLI that is missing, broken, or
 * slow leaves a picker with nothing to offer. The cache is what keeps a picker
 * useful through that: every successful enumeration is written beside
 * `config.json`, and a later answer carrying no entries is served from that
 * file instead of from nothing.
 *
 * It is keyed by harness id alone — a built-in and a plugin harness fill and
 * read it the same way — so no harness implementation knows the cache exists.
 * Only a real enumeration is written: a harness's own stand-in catalog is a
 * constant rather than an observation, and caching one would freeze it as the
 * truth for every later failure.
 *
 * Nothing expires. The file holds what the harness could run the last time it
 * answered, and a model it has since dropped fails at launch, where the harness
 * itself reports it.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { z } from "zod";
import { readJsonFileOrUndefined, writeJsonAtomic } from "../../json-file.js";
import { defaultExtensionDir, EXTENSION_NAME } from "../../paths.js";
import { errorMessage } from "../../utils.js";
import {
  modelListEntries,
  modelListNotice,
  type AnyHarnessId,
  type ModelEntry,
  type ModelList,
} from "../harness.js";

/** The payload's version. A file at another version is not this file's shape. */
const CACHE_VERSION = 1;

/** Longest harness id kept readable in the file name before it is hashed. */
const MAX_NAME_CHARS = 120;

const thinkingLevelsSchema = z.union([
  z.object({ kind: z.literal("closed"), levels: z.array(z.string()) }),
  z.object({ kind: z.literal("advisory"), levels: z.array(z.string()) }),
]);

const modelEntrySchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  thinkingLevels: thinkingLevelsSchema,
});

const cacheFileSchema = z.object({
  version: z.literal(CACHE_VERSION),
  /** The harness this file was written for; a copied file fails here. */
  harness: z.string(),
  savedAt: z.string(),
  entries: z.array(modelEntrySchema).min(1),
});

/** One stored list, with the file that answered so a notice can name it. */
export interface CachedModelList {
  readonly entries: readonly ModelEntry[];
  readonly file: string;
}

/** Where the last successful list of each harness is kept. */
export interface ModelListCache {
  /** The stored list for this harness, or `undefined` when the cache has none. */
  read(harness: AnyHarnessId): CachedModelList | undefined;
  write(harness: AnyHarnessId, entries: readonly ModelEntry[]): void;
}

/**
 * The cache under `dir`, resolving `defaultExtensionDir()` per call when no
 * directory is given: the agent dir can be redirected per process, so an
 * instance must never snapshot it.
 */
export function fileModelListCache(dir?: string): ModelListCache {
  const directory = (): string => dir ?? defaultExtensionDir();
  const fileFor = (harness: AnyHarnessId): string =>
    path.join(directory(), cacheFileName(harness));

  return {
    read(harness) {
      const file = fileFor(harness);
      const parsed = cacheFileSchema.safeParse(
        readJsonFileOrUndefined(file, "model list cache"),
      );
      if (!parsed.success || parsed.data.harness !== harness) return undefined;
      return { entries: parsed.data.entries, file };
    },
    write(harness, entries) {
      if (entries.length === 0) return;
      writeJsonAtomic(
        fileFor(harness),
        {
          version: CACHE_VERSION,
          harness,
          savedAt: new Date().toISOString(),
          entries,
        },
        "model list cache",
      );
    },
  };
}

/** A cache that stores nothing, for a caller that must not touch the disk. */
export const NO_MODEL_LIST_CACHE: ModelListCache = {
  read: () => undefined,
  write: () => {},
};

/**
 * One harness's file name. Percent-encoding keeps an id with a path separator
 * or a space inside this one directory, and an id too long to keep readable is
 * hashed instead, which bounds the name for any id.
 */
function cacheFileName(harness: AnyHarnessId): string {
  const encoded = encodeURIComponent(harness);
  const stem =
    encoded.length <= MAX_NAME_CHARS
      ? encoded
      : `sha256-${createHash("sha256").update(harness).digest("hex").slice(0, 32)}`;
  return `${EXTENSION_NAME}-${stem}-models.json`;
}

/**
 * One harness's answer, with the cached list standing in when that answer
 * carries no entries. An answer carrying entries always wins, whatever arm it
 * is, so a harness's own stand-in catalog is never replaced by an older
 * observation. A read that throws is answered as this harness's unavailable
 * list, which is the answer the catalog gives it.
 */
export async function answerWithModelListFallback(
  harness: AnyHarnessId,
  displayName: string,
  cache: ModelListCache,
  read: () => Promise<ModelList>,
): Promise<ModelList> {
  let answer: ModelList;
  try {
    answer = await read();
  } catch (error) {
    answer = {
      kind: "unavailable",
      notice: `Could not list the ${displayName} models (${errorMessage(error)}).`,
    };
  }

  const entries = modelListEntries(answer);
  if (entries.length > 0) {
    // A harness's own stand-in is a constant, not an observation.
    if (answer.kind === "listed") cache.write(harness, entries);
    return answer;
  }

  const cached = cache.read(harness);
  if (cached === undefined) return answer;
  const standIn =
    `Using the ${cached.entries.length} ` +
    `${cached.entries.length === 1 ? "model" : "models"} last listed for ` +
    `this harness (${cached.file}).`;
  const own = modelListNotice(answer);
  return {
    kind: "fallback",
    entries: cached.entries,
    notice: own === undefined ? standIn : `${own} ${standIn}`,
  };
}
