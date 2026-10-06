/**
 * model-request.test.ts — unit coverage for the tool boundary's model request.
 * The end-to-end wiring is pinned in model-override.test.ts. Pins: provenance
 * is the args KEY (caller's key wins); a caller model is STRICT; the
 * configured value keeps the soft fallback; slashed model ids resolve through
 * the full id; an unauthenticatable model refuses for every source; and only
 * an explicit `{ configured: false }` refuses — a throwing or unrecognized
 * probe is NOT a verdict.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  CONFIGURED_MODEL_KEY,
  readModelKey,
  readModelRequest,
  resolveModelRequest,
  type ModelLookup,
} from "../src/models/model-request.js";

function model(provider: string, id: string): Model<Api> {
  return { provider, id } as unknown as Model<Api>;
}

const PARENT = model("parent", "parent-1");
const CONFIGURED = model("config", "configured-model");
const OVERRIDE = model("override", "special-model");
const NESTED = model("freebuff", "deepseek/deepseek-v4-flash");

/** The session's catalog — anything else is "not available in this session". */
const CATALOG = [CONFIGURED, OVERRIDE, NESTED];

type ProbeScript =
  | { kind: "configured" }
  | { kind: "unconfigured" }
  | { kind: "threw"; message: string }
  /** A shape this module must not read as a verdict. */
  | { kind: "malformed" };

let scripted: Map<string, ProbeScript>;
let probedProviders: string[];

const registry: ModelLookup = {
  find: (provider, modelId) =>
    CATALOG.find((m) => m.provider === provider && m.id === modelId),
  getProviderAuthStatus: (provider) => {
    probedProviders.push(provider);
    const script = scripted.get(provider) ?? { kind: "configured" };
    switch (script.kind) {
      case "configured":
        return { configured: true, source: "stored" };
      case "unconfigured":
        return { configured: false };
      case "malformed":
        return { resolved: "who knows" };
      case "threw":
        throw new Error(script.message);
    }
  },
};

beforeEach(() => {
  scripted = new Map();
  probedProviders = [];
});

function refusalMessage(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a refusal, but the resolution succeeded");
}

describe("readModelKey", () => {
  it("trims a string and reads everything else as unset", () => {
    expect(readModelKey(" a/b ")).toBe("a/b");
    expect(readModelKey("")).toBeUndefined();
    expect(readModelKey("   ")).toBeUndefined();
    expect(readModelKey(null)).toBeUndefined();
    expect(readModelKey(undefined)).toBeUndefined();
    expect(readModelKey(42)).toBeUndefined();
  });
});

describe("readModelRequest", () => {
  it("reads an absent request as undefined", () => {
    expect(readModelRequest({})).toBeUndefined();
    expect(readModelRequest({ model: null })).toBeUndefined();
    expect(readModelRequest({ model: "  " })).toBeUndefined();
  });

  it("tags the caller's param and the listener's channel apart", () => {
    expect(readModelRequest({ model: "override/special-model" })).toEqual({
      source: "call",
      key: "override/special-model",
    });
    expect(readModelRequest({ [CONFIGURED_MODEL_KEY]: "config/x" })).toEqual({
      source: "configured",
      key: "config/x",
    });
  });

  it("lets the caller's own key win over the injected channel", () => {
    expect(
      readModelRequest({
        model: "override/special-model",
        [CONFIGURED_MODEL_KEY]: "config/x",
      }),
    ).toEqual({ source: "call", key: "override/special-model" });
  });

  it("falls back to the configured channel for null/blank caller values", () => {
    expect(
      readModelRequest({ model: null, [CONFIGURED_MODEL_KEY]: "config/x" }),
    ).toEqual({ source: "configured", key: "config/x" });
    expect(
      readModelRequest({ model: "  ", [CONFIGURED_MODEL_KEY]: "config/x" }),
    ).toEqual({ source: "configured", key: "config/x" });
  });
});

describe("resolveModelRequest — catalog rules", () => {
  it("pins the parent model when no request exists (legacy)", () => {
    expect(resolveModelRequest(undefined, registry, PARENT)).toEqual({
      kind: "resolved",
      model: PARENT,
      modelKey: "parent/parent-1",
    });
  });

  it("resolves to none when there is neither a request nor a parent model", () => {
    expect(resolveModelRequest(undefined, registry, undefined)).toEqual({
      kind: "none",
    });
    expect(probedProviders).toEqual([]);
  });

  it("resolves a caller-supplied model to the exact registry entry", () => {
    expect(
      resolveModelRequest(
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
      resolveModelRequest(
        { source: "call", key: "freebuff/deepseek/deepseek-v4-flash" },
        registry,
        PARENT,
      ),
    ).toMatchObject({ model: NESTED });
  });

  it("fails loudly for a caller model the session does not have — no silent fallback", () => {
    // A soft fallback WOULD resolve here; strictness is the point.
    expect(() =>
      resolveModelRequest(
        { source: "call", key: "ghost/missing" },
        registry,
        PARENT,
      ),
    ).toThrow('Model "ghost/missing" is not available in this session');
    expect(probedProviders).toEqual([]);
  });

  it("fails loudly for a caller key with no provider segment", () => {
    expect(() =>
      resolveModelRequest(
        { source: "call", key: "special-model" },
        registry,
        PARENT,
      ),
    ).toThrow('Model "special-model" is not available in this session');
  });

  it("keeps the soft fallback to the parent for the injected configured value", () => {
    expect(
      resolveModelRequest(
        { source: "configured", key: "config/configured-model" },
        registry,
        PARENT,
      ),
    ).toMatchObject({ model: CONFIGURED });
    expect(
      resolveModelRequest(
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
      resolveModelRequest(
        { source: "configured", key: "config/vanished" },
        registry,
        undefined,
      ),
    ).toEqual({ kind: "none" });
  });
});

describe("resolveModelRequest — credential rules", () => {
  it("proceeds for a caller model whose provider has a credential", () => {
    expect(
      resolveModelRequest(
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
      resolveModelRequest(
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
      resolveModelRequest(
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
      resolveModelRequest(
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
      resolveModelRequest(
        { source: "configured", key: "config/configured-model" },
        registry,
        undefined,
      ),
    ).toThrow("cannot authenticate in this session");
  });

  it("refuses the no-request parent pin when the parent's model cannot authenticate", () => {
    scripted.set("parent", { kind: "unconfigured" });

    const message = refusalMessage(() =>
      resolveModelRequest(undefined, registry, PARENT),
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
      resolveModelRequest(
        { source: "call", key: "override/special-model" },
        registry,
        PARENT,
      ),
    ).toMatchObject({ model: OVERRIDE });
  });

  it("treats a throwing probe on the parent pin as no verdict and proceeds", () => {
    scripted.set("parent", { kind: "threw", message: "registry exploded" });

    expect(resolveModelRequest(undefined, registry, PARENT)).toMatchObject({
      model: PARENT,
    });
  });

  it("treats an unrecognized status shape as no verdict and proceeds", () => {
    scripted.set("config", { kind: "malformed" });

    expect(
      resolveModelRequest(
        { source: "configured", key: "config/configured-model" },
        registry,
        PARENT,
      ),
    ).toMatchObject({ model: CONFIGURED });
  });
});
