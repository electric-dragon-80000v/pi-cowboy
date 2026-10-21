/**
 * pi-model-resolver.test.ts — unit coverage for the pi family's model
 * resolution: the session's catalog, gated by the credential probe. Pins: a
 * caller model is STRICT (unknown key throws — a soft fallback WOULD resolve);
 * the configured value keeps the soft fallback to the parent; slashed model
 * ids resolve through the full id; an unauthenticatable model refuses for
 * every source; and only an explicit `{ configured: false }` refuses — a
 * throwing or unrecognized probe is NOT a verdict.
 *
 * A thinking level is carried as written: pi's closed vocabulary is validated,
 * and a token outside it produces a notice for the caller to show — never a
 * different level, and never a refusal.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
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

/**
 * The resolution as the coordinator calls it. `parent` is only absent when a
 * case says so: an omitted option means the session has its parent model.
 */
function resolve(
  request: Parameters<typeof resolvePiModel>[0],
  options: { thinking?: string; parent?: Model<Api> } = {},
) {
  return resolvePiModel(request, {
    registry,
    parent: "parent" in options ? options.parent : PARENT,
    thinking: options.thinking,
  });
}

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
    expect(resolve(undefined)).toEqual({
      resolved: {
        kind: "resolved",
        model: PARENT,
        modelKey: "parent/parent-1",
        thinking: null,
      },
      notices: [],
    });
  });

  it("resolves to none when there is neither a request nor a parent model", () => {
    expect(resolve(undefined, { parent: undefined })).toEqual({
      resolved: { kind: "none" },
      notices: [],
    });
    expect(probedProviders).toEqual([]);
  });

  it("keeps a level it was given when no model exists to carry it", () => {
    expect(resolve(undefined, { parent: undefined, thinking: "high" })).toEqual(
      {
        resolved: { kind: "level", thinking: "high" },
        notices: [],
      },
    );
    // The level is the spawn's own; the catalog is still not read for a model
    // nothing named.
    expect(probedProviders).toEqual([]);
  });

  it("resolves a caller-supplied model to the exact registry entry", () => {
    expect(
      resolve({ source: "call", key: "override/special-model" }).resolved,
    ).toEqual({
      kind: "resolved",
      model: OVERRIDE,
      modelKey: "override/special-model",
      thinking: null,
    });
  });

  it("resolves model ids containing slashes through the full id", () => {
    expect(
      resolve({ source: "call", key: "freebuff/deepseek/deepseek-v4-flash" })
        .resolved,
    ).toMatchObject({ model: NESTED });
  });

  it("fails loudly for a caller model the session does not have — no silent fallback", () => {
    // A soft fallback WOULD resolve here; strictness is the point.
    expect(() => resolve({ source: "call", key: "ghost/missing" })).toThrow(
      'Model "ghost/missing" is not available in this session',
    );
    expect(probedProviders).toEqual([]);
  });

  it("fails loudly for a caller key with no provider segment", () => {
    expect(() => resolve({ source: "call", key: "special-model" })).toThrow(
      'Model "special-model" is not available in this session',
    );
  });

  it("keeps the soft fallback to the parent for the injected configured value", () => {
    expect(
      resolve({ source: "configured", key: "config/configured-model" })
        .resolved,
    ).toMatchObject({ model: CONFIGURED });
    expect(
      resolve({ source: "configured", key: "config/vanished" }).resolved,
    ).toEqual({
      kind: "resolved",
      model: PARENT,
      modelKey: "parent/parent-1",
      thinking: null,
    });
    expect(
      resolve(
        { source: "configured", key: "config/vanished" },
        { parent: undefined },
      ).resolved,
    ).toEqual({ kind: "none" });
  });
});

describe("resolvePiModel — thinking levels", () => {
  it("carries a level pi knows, silently", () => {
    const answer = resolve(
      { source: "call", key: "override/special-model" },
      {
        thinking: "high",
      },
    );

    expect(answer.resolved).toMatchObject({ thinking: "high" });
    expect(answer.notices).toEqual([]);
  });

  it("carries a level pi does not know and reports it — it never substitutes one", () => {
    const answer = resolve(
      { source: "call", key: "override/special-model" },
      {
        thinking: "turbo",
      },
    );

    expect(answer.resolved).toMatchObject({
      model: OVERRIDE,
      thinking: "turbo",
    });
    expect(answer.notices).toHaveLength(1);
    expect(answer.notices[0]).toContain(
      'Thinking level "turbo" is not recognized by Pi',
    );
    expect(answer.notices[0]).toContain("override/special-model");
  });

  it("validates the parent pin the same way", () => {
    const answer = resolve(undefined, { thinking: "turbo" });

    expect(answer.resolved).toMatchObject({
      kind: "resolved",
      thinking: "turbo",
    });
    expect(answer.notices).toHaveLength(1);
  });

  it("stays quiet when no level was asked for", () => {
    expect(resolve(undefined).notices).toEqual([]);
  });
});

describe("resolvePiModel — credential rules", () => {
  it("proceeds for a caller model whose provider has a credential", () => {
    expect(
      resolve({ source: "call", key: "override/special-model" }).resolved,
    ).toMatchObject({ model: OVERRIDE });
    expect(probedProviders).toEqual(["override"]);
  });

  it("refuses a caller model whose provider has no credential", () => {
    // The model IS in the catalog, so only the credential probe refuses it.
    scripted.set("override", { kind: "unconfigured" });

    const message = refusalMessage(() =>
      resolve({ source: "call", key: "override/special-model" }),
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
      resolve({ source: "call", key: "freebuff/deepseek/deepseek-v4-flash" }),
    ).toThrow('No API key found for "freebuff"');
    expect(probedProviders).toEqual(["freebuff"]);
  });

  it("refuses a configured model that cannot authenticate instead of substituting the parent", () => {
    scripted.set("config", { kind: "unconfigured" });

    const message = refusalMessage(() =>
      resolve({ source: "configured", key: "config/configured-model" }),
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
      resolve(
        { source: "configured", key: "config/configured-model" },
        { parent: undefined },
      ),
    ).toThrow("cannot authenticate in this session");
  });

  it("refuses the no-request parent pin when the parent's model cannot authenticate", () => {
    scripted.set("parent", { kind: "unconfigured" });

    const message = refusalMessage(() => resolve(undefined));

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
      resolve({ source: "call", key: "override/special-model" }).resolved,
    ).toMatchObject({ model: OVERRIDE });
  });

  it("treats a throwing probe on the parent pin as no verdict and proceeds", () => {
    scripted.set("parent", { kind: "threw", message: "registry exploded" });

    expect(resolve(undefined).resolved).toMatchObject({
      model: PARENT,
    });
  });

  it("treats an unrecognized status shape as no verdict and proceeds", () => {
    scripted.set("config", { kind: "malformed" });

    expect(
      resolve({ source: "configured", key: "config/configured-model" })
        .resolved,
    ).toMatchObject({ model: CONFIGURED });
  });
});
