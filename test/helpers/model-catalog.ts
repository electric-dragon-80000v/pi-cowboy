/**
 * model-catalog.ts — the pi-family fixture the resolver tests share: a small
 * catalog plus a credential probe whose answers are scripted per provider.
 * Anything outside `CATALOG` reads as "not available in this session".
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelLookup } from "../../src/models/pi-model-resolver.js";

export function model(provider: string, id: string): Model<Api> {
  return { provider, id } as unknown as Model<Api>;
}

export const PARENT = model("parent", "parent-1");
export const CONFIGURED = model("config", "configured-model");
export const OVERRIDE = model("override", "special-model");
export const NESTED = model("freebuff", "deepseek/deepseek-v4-flash");

/** The session's catalog — anything else is "not available in this session". */
export const CATALOG = [CONFIGURED, OVERRIDE, NESTED];

export type ProbeScript =
  | { kind: "configured" }
  | { kind: "unconfigured" }
  | { kind: "threw"; message: string }
  /** A shape the resolver must not read as a verdict. */
  | { kind: "malformed" };

export const scripted = new Map<string, ProbeScript>();
export const probedProviders: string[] = [];

export const registry: ModelLookup = {
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

/** Every test starts from a catalog nobody has scripted a probe against. */
export function resetModelCatalog(): void {
  scripted.clear();
  probedProviders.length = 0;
}
