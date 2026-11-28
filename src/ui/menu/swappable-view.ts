/**
 * swappable-view.ts — one in-place view whose body swaps.
 *
 * The agent list → a per-agent actions list, a search dialog → the field it
 * opens. The frame around it keeps talking to the same object while reads,
 * writes, rendering and keys follow the body showing.
 */

import { isFocusable, type Component } from "@earendil-works/pi-tui";

export class SwappableView implements Component {
  private active: Component;

  constructor(initial: Component) {
    this.active = initial;
  }

  /** Show `body` in place of the body showing now. */
  activate(body: Component): void {
    this.active = body;
  }

  invalidate(): void {
    this.active.invalidate();
  }

  render(width: number): string[] {
    return this.active.render(width);
  }

  handleInput(data: string): void {
    this.active.handleInput?.(data);
  }

  /** Key ownership follows the body, and is what marks this view as a leaf. */
  get focused(): boolean {
    return isFocusable(this.active) ? this.active.focused : false;
  }

  set focused(value: boolean) {
    if (isFocusable(this.active)) this.active.focused = value;
  }
}
