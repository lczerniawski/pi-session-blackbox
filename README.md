# Blackbox for Pi

Blackbox lets you search, inspect, and export the current Pi session's active branch. It reads the existing session history without extra model calls, tool declarations, background processes, or a second event log.

## Install

By default, install from npm:

```sh
pi install npm:pi-session-blackbox
```

Then run `/reload` or start a new Pi session. Pi supplies the extension runtime and terminal UI dependencies; you don't need a separate `npm install`. Pi must run on Node.js 22.19.0 or newer.

If you don't want to install from npm, or you're debugging or developing Blackbox, use one of these local options:

- **Install a checkout:** Run `pi install /path/to/pi-session-blackbox` (the directory containing `package.json`). Pi loads local packages in place; it does not copy them or install their dependencies. For a one-off debugging run, use `pi -e /path/to/pi-session-blackbox` instead.
- **Develop in Pi's extensions directory:** Pi discovers `~/.pi/agent/extensions/blackbox/index.ts` automatically; no `pi install` is needed. Don't also install that checkout as a package, or `/blackbox` may load twice.

Run `/reload` after local changes.

The only command is `/blackbox`; no compatibility alias is registered.

## Start with filters

Pass a query after `/blackbox` to open the browser already filtered. You can change it in the Search field; both use the same syntax.

| Start command | Shows |
| --- | --- |
| `/blackbox` | All records on the active branch |
| `/blackbox kind:test` | Test commands |
| `/blackbox kind:test status:failed` | Failed test commands |
| `/blackbox kind:edit` | File edits and writes |
| `/blackbox kind:decision` | Explicit decision markers |
| `/blackbox status:failed` | Failed or cancelled operations across all categories |
| `/blackbox authentication kind:edit` | Edits containing `authentication` |

Type `/blackbox ` (with a trailing space) for argument suggestions, or `/blackbox kind:` for categories. Suggestions also work for combined queries such as `/blackbox kind:test status:`. Run `/blackbox help` for syntax, categories, and examples.

### Query syntax

```text
/blackbox [search words] [kind:<category>] [status:failed]
```

- Filters and search words can appear in any order.
- `kind:<category>` selects one category from the table below. `type:<category>` is an alias.
- `status:failed` includes failed and cancelled operations; it is not limited to the `error` category.
- Search words are case-insensitive and ANDed with each other and the filters.
- Use one category per query. If you repeat `kind:` or `type:`, the last category wins; multiple categories do not form an OR query.
- Unknown filter tokens are treated as search words. Search covers titles, detail excerpts, and entry IDs, not omitted or truncated content.

The same query works in the browser's Search field and after `/blackbox text`, for example `/blackbox text kind:test status:failed`.

## Other commands and controls

```text
/blackbox
/blackbox authentication
/blackbox kind:edit
/blackbox kind:test status:failed
/blackbox mark Use SQLite because this app only needs local persistence
/blackbox text kind:decision
/blackbox export
/blackbox export "./my session.md"
/blackbox export "~/Documents"
/blackbox help
```

- **Browse:** newest records first; type to search, arrows or mouse wheel/trackpad (fullscreen mode) to select and scroll through actions, Enter for details, Escape to go back or close.
- **Row colors:** category labels use the active Pi theme (edits use the added-diff color, tests the syntax-type color, decisions the keyword color). Timestamps are muted. Failures override category colors with the error color and a bold `!`; selection uses bold text, a background highlight, and the `→` arrow without hiding category colors. Detail headers use the same category color. Colors are display-only and never added to exports.
- **Details:** Enter opens formatted details in a focused overlay. Scroll with the mouse wheel/trackpad in fullscreen mode, arrows, or Page Up/Down. Home/End and Ctrl+Home/Ctrl+End jump to the start/end.
- **Export matches:** Ctrl+X in the browser opens the save-location chooser for the current filtered snapshot. The default folder is the first choice; you can also enter another folder or a filename. Export still requires confirmation.
- **Search:** case-insensitive AND matching over titles, detail excerpts, and entry IDs. `kind:<category>` (or `type:<category>`) and `status:failed` are optional filters. Unknown filter tokens are treated as search text.
- **Mark decisions:** stores a custom session entry excluded from model context. Markers follow Pi's branching and resume semantics. Assistant prose stays in the `assistant` category; decisions are not guessed from keyword matching.
- **Text view:** shows the latest 30 matching titles in chronological order. RPC mode uses this view automatically; it does not attempt to render terminal components.

## Reading controls

While a record is open:

| Control | Action |
| --- | --- |
| Mouse wheel / trackpad | Scroll details in Pi's fullscreen mode |
| ↑ / ↓ | Scroll one line |
| Page Up / Page Down | Scroll one page |
| Home / End | Jump to the beginning / end |
| Ctrl+Home / Ctrl+End | Also jump to the beginning / end |
| Ctrl+L | Choose the detail/output language from a searchable picker |
| Escape | Return to the filtered list; press again to close |

The timeline fills the viewport and hides the transcript until you close it. The record list and language picker expand to use the available height and adjust when you resize the terminal. Short records or empty results still fill the screen with blank rows, and the footer stays at the bottom. Scrolling and jump keys move within the record, not the transcript behind it. In the action list, wheel/trackpad scrolling moves the selection through the filtered records; Enter opens the selected action. Wheel scrolling stops at the list or record's bounds, including empty results, without scrolling the transcript behind the modal. When you return to the list, Home/End work in the Search field as before. Arrow/page and fullscreen top/bottom actions follow Pi's configured keybindings.

Pi's fullscreen mode supplies wheel events to extensions. In regular mode, the terminal handles mouse scrolling and scrollback; use the keyboard to navigate the action list and scroll records. For wheel scrolling, start Pi with `pi --tui-mode fullscreen`. Blackbox does not enable mouse capture or change terminal modes.

## Formatted details

Open a record with Enter:

- **Commands and tests:** separate Command and Output sections, bordered panels, and Bash syntax highlighting. Multiline commands retain their structure. Explicit interpreter heredocs (including Python, Node, Ruby, Perl, Lua, Julia, PHP, and PowerShell) get their own language's syntax colors.
- **Output:** valid JSON and recognizable unified diffs get syntax colors without changing the text. Numbered `rg`/`grep` snippets use file extensions in result prefixes or `--heading` headers to choose a language. Without filenames, explicit search paths can identify a language or a compatible JavaScript/TypeScript mix (including `.mjs` and `.d.ts`). Mixed JS/TS uses TypeScript highlighting; unrelated mixes stay literal unless filenames identify each snippet. Match/context prefixes (`950:`, `951-`), filenames, column numbers, and separators stay intact. Ambiguous snippets and other logs, including Markdown-like text and backticks, stay literal. Use Ctrl+L → Markdown to render command output as Markdown. Error, warning, and success prefixes get status colors. A `completed` label means the tool completed, not that its tests passed.
- **File reads:** Markdown files (`.md`, `.markdown`, and recognized aliases) render as documents automatically: styled headings and emphasis, lists, blockquotes, links, tables, and syntax-highlighted fenced code. They are not shown as raw Markdown inside a code panel. Other recognized file extensions select the syntax language from the recorded read path. Unknown extensions fall back to plain output. No files are re-read from disk.
- **Messages, decisions, and summaries:** Markdown headings, lists, inline code, and fenced code blocks use Pi's Markdown renderer and syntax highlighting. Specify a language on a fence (such as `typescript`, `python`, or `json`) for syntax colors; unknown languages use a plain code style.

### Language coverage and manual overrides

Blackbox uses every grammar in Pi's installed Highlight.js. This installation has 191 grammars; the picker shows the live count. The count includes markup, configuration formats, and REPL variants, not 191 distinct programming languages. No additional download or model call is needed.

Automatic highlighting uses explicit evidence: filename extensions and known filenames (such as `Dockerfile.dev`, `Makefile`, and `CMakeLists.txt`), Markdown fence language names/aliases, recognized script shebangs, and named source-search results. Additional file hints cover Dart, Nix, Haskell, F#, Julia, Elixir, SQL, TOML, and many more. It doesn't guess a language from prose or ambiguous snippets.

If the language is missing or wrong:

1. Open the record with Enter, then press Ctrl+L.
2. Type a language name or alias (`javascript`, `js`, `rust`, `rs`, `toml`, etc.). Exact names take priority over aliases and substring matches.
3. Use arrows/Page Up/Down to select and Enter to apply. Escape cancels without changing the current choice.

Choose Markdown (`markdown` or `md`) to render Markdown from an unknown filename or a command. Choose Plain text to see literal Markdown source without formatting or syntax highlighting, or Automatic to restore hint-based rendering.

The choice applies only to the selected record for the lifetime of the open browser. For commands/tests it controls Output, while Command remains Bash. Other language choices treat messages and reads as one code block. Indexed `rg`/`grep` snippets stay as source listings, even with Markdown selected, so filenames, line numbers, and match/context prefixes remain visible. Overrides never change the stored session, search, or exports.

The picker lists installed grammars. Unsupported or custom languages render as plain text; highlighting them requires adding a grammar. If this Pi distribution does not expose its highlighter dependency (for example, certain bundled installations), the picker reports that the full catalog is unavailable and Pi's built-in hints continue to work.

Long lines wrap to fit the terminal. Colors follow the active Pi theme, and scrolling works through the entire formatted excerpt. Formatting is display-only: search, RPC text views, and exports retain the sanitized original excerpts. The 6,000-character excerpt limit is unchanged, and write/edit argument payloads remain excluded.

## Categories

| Category | Source |
| --- | --- |
| `prompt` | User messages (text only) |
| `assistant` | Visible assistant text; excludes thinking blocks |
| `decision` | Explicit `/blackbox mark` notes |
| `edit` | Completed or failed `edit`/`write` operations and paths |
| `command` | Bash tool results and direct user shell executions |
| `test` | Commands matching common test runners |
| `error` | Other failed tools, assistant errors, and aborted responses |
| `tool` | Other completed tool operations, including reads |
| `model` | Selected-model changes |
| `compaction` | Compaction summaries and original token count |
| `branch` | Branch summaries |

`status:failed` selects failures across all categories, including edits and tests.

## How it works

The command reconstructs a timeline from `ctx.sessionManager.getBranch()` on demand. Existing sessions work immediately, including entries from before the extension was installed. Compaction does not erase persisted events from this view. Abandoned branches are not mixed into the active branch; their explicit branch summaries can still appear.

Tool results are matched to assistant tool calls by call ID, not by arrival order. The browser is a snapshot: reopening it refreshes the view. Commands wait for active agent work to finish before taking that snapshot, except for adding an explicit decision marker.

Decision markers use the persisted `session-blackbox.marker.v1` data ID. Markers saved under earlier IDs are not included in Blackbox; existing session data is not modified.

## Exports and privacy

Run `/blackbox export` to export all active-branch records, or press **Ctrl+X** in the browser to export only the matching snapshot. Both show a save-location chooser:

1. **Save to default folder:** press Enter to accept the first choice. Saves to `~/.pi/agent/exports/blackbox/<timestamp>_<session-id>.md` and creates the default folder if needed. With `PI_CODING_AGENT_DIR`, the folder is `<agent-dir>/exports/blackbox`; the chooser shows the actual location.
2. **Choose another folder…:** enter an existing folder, such as `~/Documents` or `./exports`. The generated timestamp/session filename is retained.
3. **Choose a file path…:** enter the full destination, such as `~/Documents/my blackbox.md`, to choose both the folder and filename.

Then review the exact destination in the confirmation dialog. Cancelling either dialog, leaving the custom path blank, or declining confirmation writes nothing. Choosing a custom location applies only to that export; the next chooser still starts with the default folder.

You can skip the chooser by specifying the destination directly (confirmation still applies):

```text
/blackbox export "~/Documents"             # Existing folder; generated filename
/blackbox export "./my session.md"          # Specific filename
```

- Export requires confirmation in TUI or RPC mode. It is disabled without dialog-capable UI. RPC clients receive standard selection, input, and confirmation requests; no native OS file dialog is required.
- Relative custom paths resolve against Pi's working directory; `~/` and quoted paths with spaces are supported. Custom folders and a custom file's parent directory must already exist; only the default folder is created automatically.
- Files are created with permissions `0600`. Newly created default directories use `0700`. Existing files and symlinks are never overwritten.
- Existing exports remain in their original locations. No existing exports are moved, deleted, or rewritten.
- Thinking, signatures, image payloads, and file-write/edit argument payloads are omitted. Prompts, visible assistant text, read results, and command output can contain secrets. Review exports before sharing; Blackbox does not automatically redact them.
- Detail excerpts are capped at 6,000 characters. Search operates on those excerpts, not on omitted or truncated raw content. Terminal control sequences are removed before display/export.
- This is a raw-history view. Model-context edits/redactions do not erase the original persisted content or hide it here, consistent with Pi's session history semantics.

## Limits

Test detection is a command-name heuristic, not a shell parser. Compound commands can be labelled `test` if one recognized test runner occurs; wrappers or custom test scripts may be missed. `completed` means the tool reported completion, not that an assertion suite passed. Direct user shell commands show their actual exit status when available.

Only persisted top-level messages are expanded. Nested tool calls and subagent work appear through their parent results; they are not independently replayed. No filesystem watcher, cross-session index, inferred decision extraction, or automatic failed-approach analysis is included in this version.

## Verification and packaging

From a source checkout (tests are not included in the published tarball):

```sh
npm test
npm pack --dry-run
```

The npm archive includes only the six TypeScript source files, `package.json`, this README, and `LICENSE`. The explicit `pi.extensions` manifest loads `./index.ts`; Pi supplies `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as peer dependencies. To try the archive before publishing, run `npm pack`, extract the resulting `.tgz` into a temporary directory, and use `pi install /path/to/extracted/package` with a separate `PI_CODING_AGENT_DIR`.

Tests cover branch reconstruction and isolation, filters, decision markers, RPC fallback, and loading `/blackbox` in Pi. Language and Markdown tests check installed grammars, filename and fence hints, heredocs, manual overrides, literal output, themes, and unchanged exports. Export tests check the chooser, custom paths, RPC dialogs, cancellation, private permissions, and refusal to overwrite. Fullscreen tests check wheel input, overlay focus, scrolling bounds, resizing, and restoring the transcript and editor on close.

Tests need Node.js 22.19.0 or newer and a Pi installation. Runtime tests find Pi alongside Node; set `PI_PACKAGE_PATH` if Pi is installed elsewhere.

To publish a release run `npm login`, then `npm publish --dry-run` and `npm publish` from the package root. For subsequent releases, bump the version in `package.json` first; npm does not allow republishing the same name and version. Publishing is manual.

## License

MIT — see [LICENSE](LICENSE).
