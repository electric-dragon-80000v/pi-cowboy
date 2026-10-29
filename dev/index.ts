// Set the immutable mode flag before loading source modules that inspect it.
Object.defineProperty(globalThis, "__PI_COWBOY_DEV_MODE__", {
  value: true,
  writable: false,
  configurable: false,
});

// Dynamic import is intentional: static imports run before the flag is set.
const { default: extension } = await import("../src/index.js");
export default extension;
