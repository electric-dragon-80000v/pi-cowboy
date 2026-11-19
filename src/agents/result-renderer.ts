import {
  getMarkdownTheme,
  keyHint,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  type Component,
} from "@earendil-works/pi-tui";

/** Collapsed reports show this many lines of the body before the expand hint. */
const PREVIEW_LINES = 4;

/**
 * The head of a collapsed report plus the expand hint, rendered as markdown so the preview and the
 * expanded body read the same. Limits rendered lines rather than logical ones, so a single long
 * line cannot fill the transcript. The kept lines come first: a report is read from the top, unlike
 * shell output whose result is its tail.
 */
class ReportPreview implements Component {
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private readonly markdown: Markdown;

  constructor(
    report: string,
    private readonly formatHint: (hidden: number) => string,
    private readonly padX: number,
  ) {
    this.markdown = new Markdown(report, padX, 0, getMarkdownTheme());
  }

  render(width: number): string[] {
    if (this.cachedLines === undefined || this.cachedWidth !== width) {
      const lines = this.markdown.render(width);
      const hidden = lines.length - PREVIEW_LINES;
      this.cachedLines =
        hidden > 0
          ? [
              ...lines.slice(0, PREVIEW_LINES),
              ...new Text(this.formatHint(hidden), this.padX, 0).render(width),
            ]
          : lines;
      this.cachedWidth = width;
    }
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.markdown.invalidate();
  }
}

export const renderSubagentResult: MessageRenderer = (
  message,
  options,
  theme,
) => {
  const content =
    typeof message === "object" &&
    typeof (message as { content?: unknown }).content === "string"
      ? (message as { content: string }).content
      : "";
  const separator = content.indexOf("\n\n");
  const headline = (
    separator < 0 ? content : content.slice(0, separator)
  ).trim();
  const report = separator < 0 ? "" : content.slice(separator + 2).trim();
  const isError = /\b(error|stopped)\b/i.test(headline);
  const icon = theme.fg(isError ? "error" : "success", isError ? "✗" : "✓");
  const heading = `${icon} ${theme.fg("toolTitle", theme.bold(headline || "Cowboy agent report"))}`;

  if (!report) {
    return new Text(heading, options.outputPad, 0);
  }

  if (!options.expanded) {
    const hintKey =
      "keyHint" in options && typeof options.keyHint === "function"
        ? options.keyHint("app.tools.expand", "to expand")
        : keyHint("app.tools.expand", "to expand");
    const collapsed = new Container();
    collapsed.addChild(new Text(heading, options.outputPad, 0));
    collapsed.addChild(new Spacer(1));
    collapsed.addChild(
      new ReportPreview(
        report,
        (hidden) =>
          `${theme.fg("muted", `... (${hidden} more lines,`)} ${hintKey}${theme.fg("muted", ")")}`,
        options.outputPad,
      ),
    );
    return collapsed;
  }

  const expanded = new Container();
  expanded.addChild(new Text(heading, options.outputPad, 0));
  expanded.addChild(new Spacer(1));
  expanded.addChild(
    new Markdown(report, options.outputPad, 0, getMarkdownTheme()),
  );
  return expanded;
};
