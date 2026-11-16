import {
  getMarkdownTheme,
  keyHint,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

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

  if (!options.expanded || !report) {
    const hint = report
      ? theme.fg(
          "muted",
          ` (${
            "keyHint" in options && typeof options.keyHint === "function"
              ? options.keyHint("app.tools.expand", "to expand")
              : keyHint("app.tools.expand", "to expand")
          })`,
        )
      : "";
    return new Text(`${heading}${hint}`, options.outputPad, 0);
  }

  const expanded = new Container();
  expanded.addChild(new Text(heading, options.outputPad, 0));
  expanded.addChild(new Spacer(1));
  expanded.addChild(
    new Markdown(report, options.outputPad, 0, getMarkdownTheme()),
  );
  return expanded;
};
