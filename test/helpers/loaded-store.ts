/**
 * loaded-store.ts — the store a session has after its first load.
 *
 * A ConfigStore constructed over an io reads nothing until `reload()`, which is
 * what session_start drives; a test that hands the store files it already has
 * calls that load itself, here.
 */
import { ConfigStore } from "../../src/config/config-store.js";
import type { ConfigIO } from "../../src/config/config-store.js";

export function loadedStore(io: ConfigIO): ConfigStore {
  const store = new ConfigStore(io);
  store.reload();
  return store;
}
