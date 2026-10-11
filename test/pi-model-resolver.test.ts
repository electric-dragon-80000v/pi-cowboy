/**
 * pi-model-resolver.test.ts — unit coverage for the pi family's model
 * resolution: the session's catalog, gated by the credential probe. Pins: a
 * caller model is STRICT (unknown key throws — a soft fallback WOULD resolve);
 * the configured value keeps the soft fallback to the parent; slashed model
 * ids resolve through the full id; an unauthenticatable model refuses for
 * every source; and only an explicit `{ configured: false }` refuses — a
 * throwing or unrecognized probe is NOT a verdict.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { resolvePiModel } from "../src/models/pi-model-resolver.js";
import {
  CONFIGURED,
  NESTED,
  OVERRIDE,
  PARENT,
  probedProviders,
  registry,
  resetModelCatalog,
  scripted,
} from "./helpers/model-catalog.js";

beforeEach(() => {
  resetModelCatalog();
});

function refusalMessage(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a refusal, but the resolution succeeded");
}

describe("resolvePiModel — catalog rules", () => {
  it("pins the parent model when no request exists (legacy)", () => {
    expect(resolvePiModel(undefined, registry, PARENT)).toEqual({
      kind: "resolved",
      model: PARENT,
      modelKey: "parent/parent-1",
    });
  });

  it("resolves to none when there is neither a request nor a parent model", () => {
    expect(resolvePiModel(undefined, registry, undefined)).toEqual({
      kind: "none",
    });
    expect(probedProviders).toEqual([]);
  });

  it("resolves a caller-supplied model to the exact registry entry", () => {
    expect(
      resolvePiModel(
        { source: "call", key: "override/special-model" },
        registry,
        PARENT,
      ),
    ).toEqual({
      kind: "resolved",
      model: OVERRIDE,
      modelKey: "override/special-model",
    });
  });

  it("resolves model ids containing slashes through the full id", () => {
    expect(
      resolvePiModel(
        { source: "call", key: "freebuff/deepseek/deepseek-v4-flash" },
        registry,
        PARENT,
      ),
    ).toMatchObject({ model: NESTED });
  });

  it("fails loudly for a caller model the session does not have — no silent fallback", () => {
    // A soft fallback WOULD resolve here; strictness is the point.
    expect(() =>
      resolvePiModel(
        { source: "call", key: "ghost/missing" },
        registry,
        PARENT,
      ),
    ).toThrow('Model "ghost/missing" is not available in this session');
    expect(probedProviders).toEqual([]);
  });

  it("fails loudly for a caller key with no provider segment", () => {
    expect(() =>
      resolvePiModel(
        { source: "call", key: "special-model" },
        registry,
        PARENT,
      ),
    ).toThrow('Model "special-model" is not available in this session');
  });

  it("keeps the soft fallback to the parent for the injected configured value", () => {
    expect(
      resolvePiModel(
        { source: "configured", key: "config/configured-model" },
        registry,
        PARENT,
      ),
    ).toMatchObject({ model: CONFIGURED });
    expect(
      resolvePiModel(
        { source: "configured", key: "config/vanished" },
        registry,
        PARENT,
      ),
    ).toEqual({
      kind: "resolved",
      model: PARENT,
      modelKey: "parent/parent-1",
    });
    expect(
      resolvePiModel(
        { source: "configured", key: "config/vanished" },
        registry,
        undefined,
      ),
    ).toEqual({ kind: "none" });
  });
});

describe("resolvePiModel — credential rules", () => {
  it("proceeds for a caller model whose provider has a credential", () => {
    expect(
      resolvePiModel(
        { source: "call", key: "override/special-model" },
        registry,
        PARENT,
      ),
    ).toMatchObject({ model: OVERRIDE });
    expect(probedProviders).toEqual(["override"]);
  });

  it("refuses a caller model whose provider has no credential", () => {
    // The model IS in the catalog, so only the credential probe refuses it.
    scripted.set("override", { kind: "unconfigured" });

    const message = refusalMessage(() =>
      resolvePiModel(
        { source: "call", key: "override/special-model" },
        registry,
        PARENT,
      ),
    );

    expect(message).toContain(
      'Model "override/special-model" cannot authenticate in this session',
    );
    expect(message).toContain('No API key found for "override"');
    expect(message).toContain("Nothing was spawned");
  });

  it("probes the resolved model's provider, not the request key", () => {
    // The probe asks about the resolved entry's provider, not the request key.
    scripted.set("freebuff", { kind: "unconfigured" });

    expect(() =>
      resolvePiModel(
        { source: "call", key: "freebuff/deepseek/deepseek-v4-flash" },
        registry,
        PARENT,
      ),
    ).toThrow('No API key found for "freebuff"');
    expect(probedProviders).toEqual(["freebuff"]);
  });

  it("refuses a configured model that cannot authenticate instead of substituting the parent", () => {
    scripted.set("config", { kind: "unconfigured" });

    const message = refusalMessage(() =>
      resolvePiModel(
        { source: "configured", key: "config/configured-model" },
        registry,
        PARENT,
      ),
    );

    expect(message).toContain(
      'The subagent model "config/configured-model" for this configured default cannot authenticate in this session',
    );
    expect(message).toContain('No API key found for "config"');
    expect(message).toContain("Nothing was spawned");
    // The credentialed parent is still not substituted, and not even probed.
    expect(probedProviders).toEqual(["config"]);
  });

  it("refuses a configured model when the session has no parent model either", () => {
    scripted.set("config", { kind: "unconfigured" });

    expect(() =>
      resolvePiModel(
        { source: "configured", key: "config/configured-model" },
        registry,
        undefined,
      ),
    ).toThrow("cannot authenticate in this session");
  });

  it("refuses the no-request parent pin when the parent's model cannot authenticate", () => {
    scripted.set("parent", { kind: "unconfigured" });

    const message = refusalMessage(() =>
      resolvePiModel(undefined, registry, PARENT),
    );

    expect(message).toContain(
      'The parent session\'s model "parent/parent-1" did not resolve credentials in this session',
    );
    expect(message).toContain('No API key found for "parent"');
    expect(message).toContain("Nothing was spawned");
  });

  it("treats a throwing probe as no verdict and proceeds", () => {
    // A throwing probe says nothing about the child's credential.
    scripted.set("override", { kind: "threw", message: "registry exploded" });

    expect(
      resolvePiModel(
        { source: "call", key: "override/special-model" },
        registry,
        PARENT,
      ),
    ).toMatchObject({ model: OVERRIDE });
  });

  it("treats a throwing probe on the parent pin as no verdict and proceeds", () => {
    scripted.set("parent", { kind: "threw", message: "registry exploded" });

    expect(resolvePiModel(undefined, registry, PARENT)).toMatchObject({
      model: PARENT,
    });
  });

  it("treats an unrecognized status shape as no verdict and proceeds", () => {
    scripted.set("config", { kind: "malformed" });

    expect(
      resolvePiModel(
        { source: "configured", key: "config/configured-model" },
        registry,
        PARENT,
      ),
    ).toMatchObject({ model: CONFIGURED });
  });
});
