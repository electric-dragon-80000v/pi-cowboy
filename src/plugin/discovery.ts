/**
 * discovery.ts — which installed pi packages are pi-cowboy plugins.
 *
 * There is one list of plugins: whatever pi reports. pi-cowboy takes that list
 * as it comes and has no knowledge of where a package came from — pi's own
 * scopes, precedence, and trust rules are pi's business and are not modelled
 * here, not even to re-decide them. It reads each package's `pi-cowboy` manifest
 * key (see manifest.ts) and that is the whole of it, so `pi install <plugin>` is
 * the whole of what installing a plugin means.
 *
 * Discovery runs once per session start and keeps nothing: the answer is
 * whatever is installed at that moment, so installing or removing a plugin
 * between sessions needs no bookkeeping to stay in step.
 *
 * Order is deterministic — plugins come back sorted by package name — so a
 * plugin's import order never depends on how pi happened to order its packages.
 */

import * as path from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { agentDir } from "../paths.js";
import { readPluginManifest } from "./manifest.js";

/** One installed plugin package: its name, the source it was installed from, and its entry module. */
export interface DiscoveredPlugin {
  /** The package's own name; ids derived from it stay stable across installs. */
  readonly name: string;
  /** The source string the package was installed from (`pi install <source>`). */
  readonly source: string;
  /** Absolute package root. */
  readonly root: string;
  /** Absolute path of the entry module the package declared. */
  readonly entry: string;
}

/**
 * One row of pi's package list, reduced to the two things pi-cowboy uses: the
 * source to name in a warning, and where to read the package from. Where the row
 * came from is deliberately not modelled — pi decides that, and pi-cowboy has no
 * opinion to record.
 */
export interface ConfiguredPackageRoot {
  readonly source: string;
  readonly installedPath?: string;
}

/**
 * The plugin packages among the rows pi reported: those whose installed root
 * carries the manifest, in name order. One entry per package — a package listed
 * twice is one plugin, and the first row is the one loaded, because the list is
 * the source of truth and there is nothing here to prefer one row over another.
 *
 * Pure — the caller supplies what pi's manager reported, so this is testable
 * without installing anything.
 */
export function pluginsAmong(
  packages: readonly ConfiguredPackageRoot[],
): DiscoveredPlugin[] {
  const byName = new Map<string, DiscoveredPlugin>();
  for (const pkg of packages) {
    if (pkg.installedPath === undefined) continue;
    const manifest = readPluginManifest(pkg.installedPath);
    if (manifest === undefined) continue;
    if (byName.has(manifest.name)) continue;
    byName.set(manifest.name, {
      name: manifest.name,
      source: pkg.source,
      root: pkg.installedPath,
      entry: path.resolve(pkg.installedPath, manifest.entry),
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The installed plugin packages. Reads pi's own package manager, so a plugin
 * arrives through `pi install` and nothing else.
 *
 * `listConfiguredPackages` resolves each installed source's path from the
 * settings alone (`getInstalledPath` parses the source and probes where it was
 * installed), so no package scan is needed and none is done. A failure here is
 * the caller's to report — it costs every plugin, which is too much to swallow
 * behind an empty list.
 */
export async function discoverPluginPackages(
  cwd: string,
): Promise<DiscoveredPlugin[]> {
  const manager = new DefaultPackageManager({
    cwd,
    agentDir: agentDir(),
    settingsManager: SettingsManager.create(cwd, agentDir()),
  });
  return pluginsAmong(manager.listConfiguredPackages());
}
