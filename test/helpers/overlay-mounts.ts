/**
 * overlay-mounts.ts — a recording stand-in for `ctx.ui.custom` on the overlay
 * path, for tests that only care which overlay was mounted and whether it was
 * taken down again. Screens (non-overlay custom components) are not this
 * helper's business.
 */

import type {
  Component,
  OverlayHandle,
  OverlayOptions,
  TUI,
} from "@earendil-works/pi-tui";

/** The theme slice an overlay component may read; `fg` here is the identity. */
export interface OverlayStubTheme {
  fg(color: string, text: string): string;
}

/** The colourless theme every factory built here is handed. */
const PLAIN_THEME: OverlayStubTheme = { fg: (_color, text) => text };

/** The options one overlay was mounted with. */
export interface OverlayCallOptions {
  overlay?: boolean;
  overlayOptions?: OverlayOptions | (() => OverlayOptions);
  onHandle?: (handle: OverlayHandle) => void;
}

/** One overlay mount: the component, the options, and its visibility state. */
export interface OverlayMount {
  readonly component: Component;
  readonly options: OverlayCallOptions | undefined;
  /** True once the mount's handle hid it. */
  hidden(): boolean;
}

/** Records a mount and hands back the handle that would control it. */
export function recordOverlayMount(
  factory: (tui: TUI, theme: OverlayStubTheme) => Component,
  options?: OverlayCallOptions,
): OverlayMount {
  let hidden = false;
  const handle = {
    hide: () => {
      hidden = true;
    },
    setHidden: (value: boolean) => {
      hidden = value;
    },
    isHidden: () => hidden,
    focus: () => {},
    unfocus: () => {},
    isFocused: () => false,
    getBounds: () => undefined,
  } as unknown as OverlayHandle;
  const mount: OverlayMount = {
    // Nothing recorded here is ever drawn, so the mounted component gets a TUI
    // that swallows every render request.
    component: factory(silentTui(), PLAIN_THEME),
    options,
    hidden: () => hidden,
  };
  options?.onHandle?.(handle);
  return mount;
}

function silentTui(): TUI {
  return { requestRender: () => {} } as unknown as TUI;
}
