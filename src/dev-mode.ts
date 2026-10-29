/** The dev package sets this before importing the source extension. */
export const DEV_MODE =
  (
    globalThis as typeof globalThis & {
      readonly __PI_COWBOY_DEV_MODE__?: unknown;
    }
  ).__PI_COWBOY_DEV_MODE__ === true;
