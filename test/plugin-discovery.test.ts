/**
 * plugin-discovery.test.ts — which installed packages are pi-cowboy plugins.
 * The pure half is exercised here: pi's own manager supplies the installed
 * packages, and this decides which of them carry the manifest, in a
 * deterministic order. There is one list and one entry per package.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  pluginsAmong,
  type ConfiguredPackageRoot,
} from "../src/plugin/discovery.js";

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** An installed package root; `manifest` undefined makes it a non-plugin. */
function installed(name: string, manifest?: { plugin: string }): string {
  const root = mkdtempSync(join(tmpdir(), "cowboy-discover-"));
  made.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name, ...(manifest ? { "pi-cowboy": manifest } : {}) }),
  );
  return root;
}

function configured(source: string, root: string): ConfiguredPackageRoot {
  return { source, installedPath: root };
}

describe("pluginsAmong", () => {
  it("keeps only packages that declare the manifest, in name order", () => {
    const zebra = installed("pi-cowboy-zebra-plugin", { plugin: "./z.js" });
    const alpha = installed("pi-cowboy-alpha-plugin", { plugin: "./a.js" });
    const plain = installed("not-a-plugin");

    const plugins = pluginsAmong([
      configured("zebra", zebra),
      configured("plain", plain),
      configured("alpha", alpha),
    ]);

    expect(plugins.map((plugin) => plugin.name)).toEqual([
      "pi-cowboy-alpha-plugin",
      "pi-cowboy-zebra-plugin",
    ]);
    expect(plugins[0]!.entry).toBe(join(alpha, "./a.js"));
    expect(plugins[0]!.source).toBe("alpha");
  });

  it("skips a configured package that is not installed", () => {
    expect(
      pluginsAmong([{ source: "missing", installedPath: undefined }]),
    ).toEqual([]);
  });

  it("loads a package listed twice once, taking the first entry", () => {
    const first = installed("pi-cowboy-shared-plugin", {
      plugin: "./first.js",
    });
    const second = installed("pi-cowboy-shared-plugin", {
      plugin: "./second.js",
    });

    const plugins = pluginsAmong([
      configured("first", first),
      configured("second", second),
    ]);

    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.root).toBe(first);
    expect(plugins[0]!.entry).toBe(join(first, "./first.js"));
  });
});
