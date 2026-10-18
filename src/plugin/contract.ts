/**
 * contract.ts — what a pi-cowboy plugin is handed and what it may register.
 *
 * A plugin is a plain pi package that declares a `pi-cowboy` key in its
 * package.json (see manifest.ts). pi-cowboy discovers it through pi's own
 * package manager (see discovery.ts) and calls its factory once, before the
 * session's first spawn, handing it an api. The factory registers harnesses and
 * execution multiplexers through that api and may return a disposer.
 *
 * The api is id-keyed and data-passed: a plugin package never shares a module
 * instance with pi-cowboy (pi packages share no dependency instances), so
 * registrations travel as plain data and every type here is structural. A plugin
 * imports these types from the `pi-cowboy/plugin` subpath — never from a
 * pi-cowboy internal path — so that subpath is the whole of the contract and a
 * plugin never reaches inside the extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MultiplexerRegistration } from "../agents/multiplexer-registry.js";
import type { PluginHarness } from "../agents/harness.js";

export type { PluginHarness } from "../agents/harness.js";
export type { MultiplexerRegistration as PluginMultiplexer } from "../agents/multiplexer-registry.js";

/**
 * What a plugin registers through. `pi` is the same extension api pi-cowboy
 * itself holds, so a plugin reaches sessions and events; `cwd` is the project
 * root the session loaded, so a plugin resolves its own package-relative paths.
 */
export interface CowboyPluginApi {
  readonly pi: ExtensionAPI;
  readonly cwd: string;
  /**
   * Register one harness. The first registration for an id is kept: a plugin
   * that claims a built-in's id, or an id another plugin already claimed in this
   * load, is refused with a warning. Plugins load in package-name order and a
   * load starts from a clean registry, so which plugin wins an id is the same
   * one every session.
   */
  registerHarness(harness: PluginHarness): boolean;
  /** Register one execution multiplexer, selected by the `multiplexer` config key. */
  registerMultiplexer(multiplexer: MultiplexerRegistration): boolean;
}

/** Undoes what a plugin's factory set up; run when the process unloads. */
export type CowboyPluginDisposer = () => void | Promise<void>;

/**
 * A plugin module's default export. Called once with the api; a factory that
 * needs to undo something at unload returns a disposer, and one that needs an
 * async setup returns a promise of one.
 */
export type CowboyPluginFactory = (
  api: CowboyPluginApi,
) => void | CowboyPluginDisposer | Promise<void | CowboyPluginDisposer>;
