/**
 * manifest.ts — a plugin package's own declaration: the `pi-cowboy` key in its
 * package.json.
 *
 * The key is deliberately not `pi.extensions`: a plugin's entry is loaded by
 * pi-cowboy, not by pi, so declaring it under pi's own extension key would load
 * it twice. The shape is `"pi-cowboy": { "plugin": "./dist/plugin.js" }`, a path
 * relative to the package root, so a package pi already installs for its own
 * reasons can also carry a pi-cowboy plugin without a second package.
 *
 * Reading is total: a package.json that is missing, unreadable, not an object,
 * or whose key is absent or malformed yields `undefined` (a package that is not
 * a plugin), never a throw — discovery walks every installed package, and one
 * that is not a plugin is the ordinary case, not an error.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "../predicates.js";

/** A package's pi-cowboy declaration: who it is and where its plugin module lives. */
export interface CowboyPluginManifest {
  /** The package's own name, so two plugins register under distinct ids. */
  readonly name: string;
  /** Entry module path, relative to the package root. */
  readonly entry: string;
}

/** The package.json key a plugin is declared under. */
const MANIFEST_KEY = "pi-cowboy";

/** The one field the key carries today: the entry module's package-relative path. */
function parseEntry(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const entry = value.plugin;
  return typeof entry === "string" && entry.length > 0 ? entry : undefined;
}

/** Read one package's plugin declaration, or undefined when it is not a plugin. */
export function readPluginManifest(
  packageRoot: string,
): CowboyPluginManifest | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const entry = parseEntry(parsed[MANIFEST_KEY]);
  if (entry === undefined) return undefined;
  const name = parsed.name;
  return { name: typeof name === "string" ? name : packageRoot, entry };
}
