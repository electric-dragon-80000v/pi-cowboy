/**
 * plugin-manifest.test.ts — reading a package's `pi-cowboy` declaration. The
 * read is total: a package that is not a plugin, or one whose package.json is
 * missing or malformed, reads as undefined rather than throwing — discovery
 * walks every installed package, and "not a plugin" is the ordinary case.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPluginManifest } from "../src/plugin/manifest.js";

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A package directory whose package.json holds the given value. */
function packageWith(name: string, value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "cowboy-manifest-"));
  made.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name, ...(value as object) }),
  );
  return root;
}

describe("readPluginManifest", () => {
  it("reads the entry and the package's own name from the pi-cowboy key", () => {
    const root = packageWith("pi-cowboy-my-plugin", {
      "pi-cowboy": { plugin: "./dist/plugin.js" },
    });

    expect(readPluginManifest(root)).toEqual({
      name: "pi-cowboy-my-plugin",
      entry: "./dist/plugin.js",
    });
  });

  it("reads undefined for a package that only declares pi extensions", () => {
    // The key is deliberately separate from `pi.extensions`: pi would load the
    // entry itself and pi-cowboy would load it again.
    const root = packageWith("pi-only", { pi: { extensions: ["./index.js"] } });

    expect(readPluginManifest(root)).toBeUndefined();
  });

  it("reads undefined when the package name does not use the plugin prefix", () => {
    expect(
      readPluginManifest(
        packageWith("unprefixed-plugin", {
          "pi-cowboy": { plugin: "./plugin.js" },
        }),
      ),
    ).toBeUndefined();
  });

  it("reads undefined when the plugin entry is not a non-empty string", () => {
    expect(
      readPluginManifest(
        packageWith("pi-cowboy-bad", { "pi-cowboy": { plugin: "" } }),
      ),
    ).toBeUndefined();
    expect(
      readPluginManifest(
        packageWith("pi-cowboy-bad", { "pi-cowboy": { plugin: 7 } }),
      ),
    ).toBeUndefined();
    expect(
      readPluginManifest(packageWith("pi-cowboy-bad", { "pi-cowboy": "yes" })),
    ).toBeUndefined();
  });

  it("reads undefined for a missing or malformed package.json", () => {
    const missing = mkdtempSync(join(tmpdir(), "cowboy-manifest-"));
    made.push(missing);
    expect(readPluginManifest(missing)).toBeUndefined();

    const malformed = mkdtempSync(join(tmpdir(), "cowboy-manifest-"));
    made.push(malformed);
    writeFileSync(join(malformed, "package.json"), "{ not json");
    expect(readPluginManifest(malformed)).toBeUndefined();
  });

  it("reads undefined when the package has no name", () => {
    const root = mkdtempSync(join(tmpdir(), "cowboy-manifest-"));
    made.push(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ "pi-cowboy": { plugin: "./p.js" } }),
    );

    expect(readPluginManifest(root)).toBeUndefined();
  });
});
