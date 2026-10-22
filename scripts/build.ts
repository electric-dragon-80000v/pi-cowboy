/**
 * build.ts — the JavaScript step of `pnpm run build`: both public entries are
 * bundled and minified into `dist/`. The `.d.ts` files come from the `tsc`
 * step that follows it; this script never emits types.
 *
 * The two entries are the extension (`pi.extensions`) and the `pi-cowboy/plugin`
 * subpath plugin packages import. `outbase: src` keeps each entry at the path
 * `package.json` names (`dist/index.js`, `dist/plugin/index.js`), which also
 * keeps `import.meta.url` arithmetic in `src/paths.ts` resolving against the
 * package root: every emitted chunk sits one level below it.
 *
 * `splitting` is what preserves the lazy `import()`s in `src/registration.ts`:
 * the menu screens stay separate chunks that load when a command opens them, so
 * boot never carries their code.
 *
 * `keepNames` keeps `Function.name`/`class` names readable in a stack trace and
 * for anything that inspects them, while identifiers inside each function still
 * mangle.
 *
 * `packages: "external"` leaves every bare import to Node, which is the
 * decision this size was measured against: inlining the dependencies was far
 * larger (zod alone minifies to ~460 KiB) and would drop the deduplication a
 * package manager already gives them.
 *
 * Source maps stay external so a stack trace can be read from a local build;
 * `files` in package.json keeps them out of the published tarball.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = path.join(ROOT, "dist");

// Chunk names are content-hashed, so a rebuild over an existing dist would
// leave the previous build's chunks behind and publish both.
fs.rmSync(DIST, { recursive: true, force: true });

await build({
  entryPoints: [
    path.join(ROOT, "src", "index.ts"),
    path.join(ROOT, "src", "plugin", "index.ts"),
  ],
  outbase: path.join(ROOT, "src"),
  outdir: DIST,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node24",
  packages: "external",
  minify: true,
  keepNames: true,
  sourcemap: true,
  logLevel: "warning",
});
