import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { TimelineBrowser, type BrowserResult } from "./browser.ts";
import { defaultExportPath, resolveExportDestination, saveExport } from "./export.ts";
import { buildTimeline, cleanText, clipped, filterTimeline, KINDS, MARKER_TYPE, parseQuery, timeLabel, type FlightRecord } from "./recorder.ts";

const HELP = `Blackbox — searchable session history
Usage: /blackbox [search words] [kind:<category>] [status:failed]
Open the browser with filters already applied, or type the same query inside it.
Type /blackbox followed by a space to see argument suggestions.

Examples:
/blackbox                              Browse all active-branch records
/blackbox kind:test                    Test commands only
/blackbox kind:test status:failed      Failed test commands only
/blackbox kind:edit                    File edits and writes
/blackbox kind:decision                Explicit decision markers
/blackbox status:failed                Failures across all categories
/blackbox authentication kind:edit     Edits matching authentication

Filters:
kind:<category> (alias type:<category>): ${KINDS.join(", ")}
status:failed: failed or cancelled operations, including edits and tests.
Search words are case-insensitive and ANDed with each other and the filters.
Use one category per query; if repeated, the last category wins.

Other commands:
/blackbox mark <decision>      Save a decision; excluded from model context
/blackbox text [query]         Compact text view (also works over RPC)
/blackbox export [path]        Export Markdown; choose a destination or supply a folder/file
/blackbox help                 Show this help

Browser: type to search, ↑↓ to select, Enter for formatted details, Esc to return/close.
Details: ↑↓ / PgUp/PgDn scroll; Home/End jump to the start/end.
Ctrl+L opens a searchable language picker: all installed grammars, Automatic, or Plain text.
Markdown files render headings, lists, quotes, links, tables, and highlighted code blocks.
Choose Markdown for unrecognized Markdown output; Plain text shows the literal source.
Overrides affect only this record's display while the browser is open; commands stay Bash.
Mouse wheel / trackpad scroll details in fullscreen mode; regular mode uses terminal scrollback.
Syntax-highlighted code and separate command/output sections. Ctrl+X exports matching records.
Export offers the default folder first, or another existing folder/file, then asks for confirmation.
Default: ~/.pi/agent/exports/blackbox (respects PI_CODING_AGENT_DIR); never overwrite.
Assistant text is not automatically interpreted as decisions.
Test labels identify test-like commands; completed does not guarantee tests passed.`;

function completeArguments(prefix: string) {
  const [, leading = "", token = ""] = /^(.*\s)?(\S*)$/.exec(prefix)!;
  // Decision prose and export paths are not filter queries.
  if (/^(?:mark|export|help)\s/i.test(prefix.trimStart())) return null;
  const queryPrefix = leading.replace(/^text\s+/i, "");
  const categoryKey = token.toLowerCase().startsWith("type:") ? "type" : "kind";
  const suggestions = [
    ...(/(?:^|\s)(?:kind|type):\S+/i.test(queryPrefix) ? [] : KINDS.map((kind) => ({
      value: `${categoryKey}:${kind}`, label: `${categoryKey}:${kind}`, description: `Start with ${kind} records only`,
    }))),
    ...(/(?:^|\s)status:failed(?:\s|$)/i.test(queryPrefix) ? [] : [
      { value: "status:failed", label: "status:failed", description: "Show failed or cancelled operations" },
    ]),
    ...(leading ? [] : [
      { value: "help", label: "help", description: "Show filter syntax and examples" },
      { value: "text", label: "text", description: "Text view; accepts the same filters" },
      { value: "mark", label: "mark", description: "Save an explicit decision" },
      { value: "export", label: "export", description: "Export all records to Markdown" },
    ]),
  ].filter((item) => item.value.startsWith(token.toLowerCase()));
  // Pi replaces the entire argument prefix, not just the current token.
  return suggestions.length ? suggestions.map((item) => ({ ...item, value: leading + item.value })) : null;
}

export default function blackbox(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<{ text: string }>(MARKER_TYPE, (entry, _options, theme) => {
    const text = typeof entry.data?.text === "string" ? entry.data.text : "(invalid marker)";
    return new Text(`${theme.fg("accent", "[decision]")} ${clipped(text)}`, 0, 0);
  });

  async function exportRecords(ctx: ExtensionCommandContext, records: FlightRecord[], requestedPath = ""): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("Blackbox exports require interactive or RPC confirmation.", "warning");
      return;
    }
    const now = new Date();
    const suggestedPath = defaultExportPath(ctx.sessionManager.getSessionId(), now);
    let path = suggestedPath;
    let createDefaultDirectory = !requestedPath;
    if (requestedPath) {
      path = await resolveExportDestination(requestedPath, ctx.cwd, suggestedPath);
    } else {
      const defaultOption = `Save to default folder — ${cleanText(dirname(suggestedPath))}`;
      const folderOption = "Choose another folder…";
      const fileOption = "Choose a file path…";
      const choice = await ctx.ui.select("Save Blackbox export", [defaultOption, folderOption, fileOption]);
      if (choice === undefined) return;
      if (choice !== defaultOption) {
        if (choice !== folderOption && choice !== fileOption) return;
        const destination = await ctx.ui.input(choice === folderOption ? "Export folder (must already exist)" : "Export file path",
          choice === folderOption ? "~/Documents or ./exports" : "~/Documents/blackbox.md");
        if (!destination?.trim()) return;
        path = await resolveExportDestination(destination.trim(), ctx.cwd, suggestedPath, choice === folderOption);
        createDefaultDirectory = false;
      }
    }
    const approved = await ctx.ui.confirm("Export Blackbox session history?",
      `${records.length} records → ${cleanText(path)}\n\nMay contain sensitive prompts, commands, and output. Thinking and file-write payloads are omitted. Existing files will not be overwritten.`);
    if (!approved) return;
    await saveExport(path, records, {
      sessionId: ctx.sessionManager.getSessionId(), name: ctx.sessionManager.getSessionName(),
      cwd: ctx.cwd, exportedAt: now.toISOString(),
    }, createDefaultDirectory);
    ctx.ui.notify(`Blackbox exported to ${cleanText(path)}`, "info");
  }

  pi.registerCommand("blackbox", {
    description: "Blackbox session history; optional kind:test / status:failed filters; help for examples",
    getArgumentCompletions: completeArguments,
    handler: async (args, ctx) => {
      try {
        const input = args.trim();
        if (input === "help") { ctx.ui.notify(HELP, "info"); return; }
        if (input === "mark" || input.startsWith("mark ")) {
          const text = cleanText(input.slice(4).trim());
          if (!text) { ctx.ui.notify("Usage: /blackbox mark <decision and rationale>", "warning"); return; }
          if (text.length > 6000) { ctx.ui.notify("Decision markers must be at most 6,000 characters.", "warning"); return; }
          pi.appendEntry(MARKER_TYPE, { text });
          ctx.ui.notify("Decision saved to this branch (not sent to the model).", "info");
          return;
        }
        // Commands work on a stable snapshot after active agent work completes.
        await ctx.waitForIdle();
        const records = buildTimeline(ctx.sessionManager.getBranch());
        if (input === "export" || input.startsWith("export ")) {
          await exportRecords(ctx, records, input.slice(6).trim());
          return;
        }
        const plain = input === "text" || input.startsWith("text ");
        const query = plain ? input.slice(4).trim() : input;
        if (plain || ctx.mode !== "tui") {
          const matches = filterTimeline(records, parseQuery(query));
          const last = matches.slice(-30);
          ctx.ui.notify([`Blackbox: ${matches.length}/${records.length} records (last ${last.length}, chronological)`,
            ...last.map((record) => `${timeLabel(record.timestamp)} [${record.kind}${record.failed ? ":failed" : ""}] ${record.title}`),
            "Use /blackbox export for details; the interactive browser requires TUI mode."].join("\n"), "info");
          return;
        }
        // A focused overlay owns page/jump keys in fullscreen mode; an editor replacement does not.
        const result = await ctx.ui.custom<BrowserResult>((tui, theme, keys, done) =>
          new TimelineBrowser(records, tui, theme, keys, done, query),
          { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } });
        if (result) await exportRecords(ctx, result.exportRecords);
      } catch (error) {
        ctx.ui.notify(`Blackbox: ${cleanText(error instanceof Error ? error.message : String(error))}`, "error");
      }
    },
  });
}
