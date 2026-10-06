/**
 * Paginated, searchable pick-list dialog.
 *
 * Same building blocks as pi's ModelSelectorComponent without the SettingsManager dependency.
 */

import {
  Container,
  type Focusable,
  fuzzyFilter,
  getKeybindings,
  Input,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Theme } from "./types.js";

export interface SelectOption {
  /** Value returned on selection; null is the inherit/clear sentinel. */
  value: string | null;
  label: string;
  /** Provider badge; omitted when the label already conveys it. */
  provider?: string;
}

interface SelectDialogCallbacks {
  onSelect: (value: string | null) => void;
  onCancel: () => void;
}

const MAX_VISIBLE = 10;

/** Searchable selection dialog. Rendering mirrors pi's ModelSelectorComponent. */
export class SearchableSelectDialog extends Container implements Focusable {
  private searchInput: Input;
  private listContainer: Container;
  private items: SelectOption[];
  private filteredItems: SelectOption[];
  private selectedIndex: number;
  private currentValue: string | null;
  private callbacks: SelectDialogCallbacks;
  private theme: Theme;

  // Propagated to searchInput for the IME cursor.
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    items: SelectOption[],
    currentValue: string | null,
    callbacks: SelectDialogCallbacks,
    theme: Theme,
  ) {
    super();

    this.items = items;
    this.currentValue = currentValue;
    this.callbacks = callbacks;
    this.theme = theme;
    this.filteredItems = [...items];

    const currentIdx = items.findIndex((m) => m.value === currentValue);
    this.selectedIndex = currentIdx >= 0 ? currentIdx : 0;

    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));

    this.searchInput = new Input();
    this.searchInput.onSubmit = () => {
      if (this.filteredItems[this.selectedIndex]) {
        this.callbacks.onSelect(this.filteredItems[this.selectedIndex].value);
      }
    };
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));

    this.addChild(new DynamicBorder());

    this.updateList();
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();

    if (this.filteredItems.length === 0) {
      if (
        kb.matches(keyData, "tui.select.up") ||
        kb.matches(keyData, "tui.select.down") ||
        kb.matches(keyData, "tui.select.pageUp") ||
        kb.matches(keyData, "tui.select.pageDown")
      ) {
        return;
      }
    }

    if (kb.matches(keyData, "tui.select.up")) {
      this.selectedIndex =
        this.selectedIndex === 0
          ? this.filteredItems.length - 1
          : this.selectedIndex - 1;
      this.updateList();
      return;
    }

    if (kb.matches(keyData, "tui.select.down")) {
      this.selectedIndex =
        this.selectedIndex === this.filteredItems.length - 1
          ? 0
          : this.selectedIndex + 1;
      this.updateList();
      return;
    }

    if (kb.matches(keyData, "tui.select.pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - MAX_VISIBLE);
      this.updateList();
      return;
    }

    if (kb.matches(keyData, "tui.select.pageDown")) {
      this.selectedIndex = Math.min(
        this.filteredItems.length - 1,
        this.selectedIndex + MAX_VISIBLE,
      );
      this.updateList();
      return;
    }

    if (kb.matches(keyData, "tui.select.confirm")) {
      const selected = this.filteredItems.at(this.selectedIndex);
      if (selected) {
        this.callbacks.onSelect(selected.value);
      }
      return;
    }

    if (kb.matches(keyData, "tui.select.cancel")) {
      this.callbacks.onCancel();
      return;
    }

    this.searchInput.handleInput(keyData);
    this.filterItems();
  }

  invalidate(): void {
    // No cached state to invalidate
  }

  private filterItems(): void {
    const query = this.searchInput.getValue();
    if (!query) {
      this.filteredItems = [...this.items];
    } else {
      this.filteredItems = fuzzyFilter(
        this.items,
        query,
        (item) => `${item.label} ${item.provider} ${item.value ?? ""}`,
      );
    }
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filteredItems.length - 1),
    );
    this.updateList();
  }

  private updateList(): void {
    this.listContainer.clear();

    const { filteredItems } = this;
    if (filteredItems.length === 0) {
      this.listContainer.addChild(
        new Text(this.theme.fg("muted", "  No matching items"), 0, 0),
      );
      return;
    }

    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(MAX_VISIBLE / 2),
        filteredItems.length - MAX_VISIBLE,
      ),
    );
    const endIndex = Math.min(startIndex + MAX_VISIBLE, filteredItems.length);

    for (let i = startIndex; i < endIndex; i++) {
      const item = filteredItems.at(i);
      if (!item) continue;

      const isSelected = i === this.selectedIndex;
      const isCurrent = item.value === this.currentValue;

      const labelText = isSelected
        ? this.theme.fg("accent", "→ ") + this.theme.fg("accent", item.label)
        : `  ${item.label}`;
      const providerBadge = item.provider
        ? this.theme.fg("muted", `[${item.provider}]`)
        : "";
      const checkmark = isCurrent ? this.theme.fg("success", " ✓") : "";
      const line = `${labelText} ${providerBadge}${checkmark}`;

      this.listContainer.addChild(new Text(line, 0, 0));
    }

    if (startIndex > 0 || endIndex < filteredItems.length) {
      const scrollInfo = this.theme.fg(
        "muted",
        `  (${this.selectedIndex + 1}/${filteredItems.length})`,
      );
      this.listContainer.addChild(new Text(scrollInfo, 0, 0));
    }
  }
}
