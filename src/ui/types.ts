/** Terminal rendering theme. Lives here so non-UI modules avoid a UI-layer dependency. */
export type Theme = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  italic?: (text: string) => string;
};
