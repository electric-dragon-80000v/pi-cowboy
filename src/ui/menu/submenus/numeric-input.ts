/** numeric-input-submenu.ts — numeric input (createNumericSubmenu) and plain text input (createInputSubmenu). */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, type Component } from "@earendil-works/pi-tui";

import { validateNumeric } from "../helpers.js";

/** Empty-input behavior for the numeric submenu. Each case carries exactly the fields it needs: a required value errors, an optional one clears, and a defaulted one fills its value. */
type NumericSubmenuOptions =
  | { kind: "required"; min?: number; onValid?: (parsed: number) => void }
  | {
      kind: "optional";
      min?: number;
      onValid?: (parsed: number) => void;
      onEmpty?: () => void;
    }
  | {
      kind: "defaulted";
      min?: number;
      default: number;
      onValid?: (parsed: number) => void;
    };

/** Numeric submenu erroring via ctx.ui.notify; empty input follows the options' empty-input behavior. */
export function createNumericSubmenu(
  ctx: ExtensionCommandContext,
  options: NumericSubmenuOptions,
): (initialValue: string, done: (selectedValue?: string) => void) => Component {
  const min = options.min ?? 1;
  const fmtLabel = (n: number) => (n === 0 ? "\u2265 0" : `\u2265 ${n}`);
  const onError = (msg: string) => ctx.ui.notify(msg, "error");

  return (initialValue, done) => {
    const input = new Input();
    input.setValue(initialValue === "(not set)" ? "" : initialValue);
    input.onSubmit = (value) => {
      const trimmed = value.trim();
      if (!trimmed || /^unlimited$/i.test(trimmed)) {
        switch (options.kind) {
          case "required":
            onError(`Invalid value \u2014 must be a number ${fmtLabel(min)}`);
            return;
          case "defaulted":
            options.onValid?.(options.default);
            done(String(options.default));
            return;
          case "optional":
            options.onEmpty?.();
            done("(not set)");
            return;
        }
      }
      const parsed = validateNumeric(trimmed, min);
      if (parsed === undefined) {
        onError(`Invalid value \u2014 must be a number ${fmtLabel(min)}`);
        return;
      }
      options.onValid?.(parsed);
      done(String(parsed));
    };
    input.onEscape = () => done();
    return input;
  };
}

/** Plain-text submenu; empty input errors when `required`, else clears. */
export function createInputSubmenu(
  ctx: ExtensionCommandContext,
  options?: { required?: boolean },
): (initialValue: string, done: (value?: string) => void) => Input {
  return (initialValue, done) => {
    const input = new Input();
    input.setValue(initialValue);
    input.onSubmit = (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        if (options?.required) {
          ctx.ui.notify("Cannot be empty", "error");
          return;
        }
        done();
        return;
      }
      done(trimmed);
    };
    input.onEscape = () => done();
    return input;
  };
}
