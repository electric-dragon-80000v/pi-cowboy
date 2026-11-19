import {
  getMarkdownTheme,
  keyHint,
  truncateToVisualLines,
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
 * The head of a collapsed report plus the expand hint. Limits wrapped lines rather than logical
 * ones, so a single long line cannot fill the transcript. The kept lines come first: a report is
 * read from the top, unlike shell output whose result is its tail.
 */
class ReportPreview implements Component {
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly text: string,
    private readonly formatHint: (hidden: number) => string,
    private readonly padX: number,
  ) {}

  render(width: number): string[] {
    if (this.cachedLines === undefined || this.cachedWidth !== width) {
      const preview = truncateToVisualLines(
        this.text,
        PREVIEW_LINES,
        width,
        this.padX,
        "start",
      );
      this.cachedLines =
        preview.skippedCount > 0
          ? [
              ...preview.visualLines,
              ...new Text(
                this.formatHint(preview.skippedCount),
                this.padX,
                0,
              ).render(width),
            ]
          : preview.visualLines;
      this.cachedWidth = width;
    }
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
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
    const styled = report
      .split("\n")
      .map((line) => theme.fg("toolOutput", line))
      .join("\n");

    const collapsed = new Container();
    collapsed.addChild(new Text(heading, options.outputPad, 0));
    collapsed.addChild(new Spacer(1));
    collapsed.addChild(
      new ReportPreview(
        styled,
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
