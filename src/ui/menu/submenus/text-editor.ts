/**
 * text-editor.ts — multi-line text body for prompts.
 *
 * pi-tui's Editor is the screen's text control here: it wraps, scrolls, keeps
 * history and a kill ring, and takes enter to submit / shift+enter for a
 * newline. It draws its own border, so the frame around it comes from
 * SettingsListWrapper (whose title names the field).
 */

import {
  Editor,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Theme } from "../../types.js";
import type { Notify } from "../helpers.js";
import { buildSelectListTheme } from "../helpers.js";

interface TextEditorBase {
  /** Initial text; the editor opens with the cursor after it. */
  prefill: string;
  /** The submitted text (already trimmed). */
  onDone: (text: string) => void;
  /** Escape: leave without a value. */
  onCancel: () => void;
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
}

/**
 * Empty-input rejection needs somewhere to report: a required editor without
 * a notification sink would drop the error silently on submit.
 */
type TextEditorValidation =
  | {
      /** Reject an empty submission (notified) instead of completing. */
      required: true;
      /** Notification sink for the empty-input error. */
      notify: Notify;
    }
  | { required?: false; notify?: never };

type TextEditorOptions = TextEditorBase & TextEditorValidation;

/**
 * Focusable multi-line text body. Focused from the start (it is the only
 * control on screen), so the cursor renders where the text is being typed.
 */
export function createTextEditor(
  options: TextEditorOptions,
): Component & Focusable {
  const { tui, theme, keybindings, prefill, onDone, onCancel } = options;

  const editor = new Editor(
    tui,
    {
      borderColor: (text) => theme.fg("dim", text),
      selectList: buildSelectListTheme(theme),
    },
    { paddingX: 2 },
  );
  editor.focused = true;
  if (prefill) editor.setText(prefill);
  editor.onSubmit = (text) => {
    const trimmed = text.trim();
    if (!trimmed && options.required) {
      options.notify("Cannot be empty", "error");
      return;
    }
    onDone(trimmed);
  };

  return {
    render: (width) => editor.render(width),
    invalidate: () => editor.invalidate(),
    handleInput: (data) => {
      if (keybindings.matches(data, "tui.select.cancel")) {
        onCancel();
        return;
      }
      editor.handleInput(data);
    },
    get focused() {
      return editor.focused;
    },
    set focused(value: boolean) {
      editor.focused = value;
    },
  } satisfies Component & Focusable;
}
