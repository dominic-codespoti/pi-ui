# Component reference

| Kind      | Sources                                                     | Renders as                                                               | Interaction | Notes                                                                                                                                    |
| --------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| select    | pi-tui exports: SelectList                                  | A selectable list with an optional label and item descriptions.          | select      | —                                                                                                                                        |
| input     | pi-tui exports: Input, Editor                               | A text field for Input or a multi-line editor for Editor.                | submit      | —                                                                                                                                        |
| text      | pi-tui exports: Text                                        | Plain text or preformatted text when preserving terminal layout.         | none        | —                                                                                                                                        |
| button    | shape fields — required: label, onClick; optional: variant  | A button when interactive, otherwise a non-interactive label.            | click       | —                                                                                                                                        |
| checkbox  | shape fields — required: checked, onToggle; optional: label | A labeled checkbox or toggle control.                                    | toggle      | —                                                                                                                                        |
| progress  | shape fields — required: progress, render; optional: label  | A progress bar with an optional label.                                   | none        | —                                                                                                                                        |
| loader    | pi-tui exports: Loader, CancellableLoader                   | An animated loading indicator with its message.                          | none        | —                                                                                                                                        |
| image     | pi-tui exports: Image                                       | An image with its extracted label when available.                        | none        | Images over the wire size limit are replaced with a text notice.                                                                         |
| markdown  | pi-tui exports: Markdown                                    | Rendered Markdown content.                                               | none        | —                                                                                                                                        |
| settings  | pi-tui exports: SettingsList                                | A list of settings with their current values and available choices.      | cycle       | —                                                                                                                                        |
| container | pi-tui exports: Box, HStack, VStack, Container              | A vertical stack or horizontal wrapping row containing child components. | none        | A container with a single parsed child collapses to that child. HStack becomes a horizontal wrapping row. Spacer components are dropped. |

## Parser rules

- Components are detected by shape (duck typing), not class identity; detection order matters, for example SettingsList before SelectList, Editor before Input, and Loader before Markdown before Text.
- Component trees beyond the node, item, or depth limits are truncated.
- ANSI styling is stripped from Text content in parsed text nodes.
- Unrecognised components with render() become preformatted text.
- Labels are extracted from title or label, or from the first short Text child.

## pi-tui runtime exports

| Export        | Parses as | Notes                                                                                                 |
| ------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| TruncatedText | text      | Its render output is shown as preformatted text.                                                      |
| ScrollView    | container | Its children parse as a container, with single-child containers collapsing to that child.             |
| MouseRegion   | text      | Its rendered output is treated as preformatted text by the parser fallback.                           |
| Spacer        | dropped   | Spacer nodes are omitted from parsed component trees.                                                 |
| TuiAltScreen  | container | It inherits Container and is parsed through its children rather than its terminal-screen render path. |
| TuiMainScreen | container | It inherits Container and is parsed through its children rather than its terminal-screen render path. |

## Theme colors

text, userMessageText, customMessageText, toolOutput, syntaxVariable, mdCodeBlock, dim, thinkingText, mdLinkUrl, mdListBullet, toolDiffContext, syntaxComment, thinkingOff, thinkingMinimal, muted, mdQuote, syntaxOperator, syntaxPunctuation, thinkingLow, border, borderMuted, mdCodeBlockBorder, mdQuoteBorder, mdHr, borderAccent, accent, mdHeading, syntaxKeyword, thinkingHigh, thinkingXhigh, thinkingMax, toolTitle, customMessageLabel, mdLink, syntaxFunction, thinkingMedium, mdCode, syntaxType, success, toolDiffAdded, syntaxString, error, toolDiffRemoved, warning, bashMode, syntaxNumber

## Limits

| Limit                          | Value                       |
| ------------------------------ | --------------------------- |
| Parsed component nodes         | 256                         |
| Items per parsed node          | 256                         |
| Component tree depth           | 128                         |
| Component tree text            | 256,000 characters (250 KB) |
| Image data                     | 256,000 characters (250 KB) |
| Widget refresh interval        | 250 ms                      |
| Custom dialog refresh interval | 200 ms                      |
